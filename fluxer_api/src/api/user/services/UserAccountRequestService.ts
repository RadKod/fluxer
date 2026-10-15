// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import * as AuthEmailRevert from '@app/api/auth/AuthEmailRevert';
import {requireEmailVerified} from '@app/api/auth/EmailVerificationUtils';
import {requireSudoMode, type SudoVerificationResult} from '@app/api/auth/services/SudoVerificationService';
import {createChannelID, createGuildID, type UserID} from '@app/api/BrandedTypes';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {emitActivity} from '@app/api/infrastructure/activity/ActivityEvents';
import {isBlockedEmailDomain} from '@app/api/infrastructure/activity/SharedLists';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVClient, getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getPremiumLedgerService, getProfileAccessCache} from '@app/api/middleware/ServiceSingletons';
import type {AuthSession} from '@app/api/models/AuthSession';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {isProfileHidden} from '@app/api/user/ProfileVisibility';
import type {ProfileViewer} from '@app/api/user/profile/ProfileAccessRules';
import {applyProfileExtensions} from '@app/api/user/profile/ProfileExtensionProviders';
import type {ProfileViewConnection} from '@app/api/user/profile/ProfileViewProjection';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {EmailChangeService} from '@app/api/user/services/EmailChangeService';
import {propagateIfPartialChanged} from '@app/api/user/services/PartialUserChangePropagation';
import type {UserAccountService} from '@app/api/user/services/UserAccountService';
import type {UserChannelService} from '@app/api/user/services/UserChannelService';
import {readUsernameMigration} from '@app/api/user/UniqueUsernames';
import {createPremiumClearPatch, isAccountClosed, shouldStripExpiredPremium} from '@app/api/user/UserHelpers';
import {
	mapGuildMemberToProfileResponse,
	mapUserToPrivateResponse,
	mapUserToProfileResponse,
} from '@app/api/user/UserMappers';
import {extractEmailDomain} from '@app/api/utils/EmailDomainUtils';
import {AccountIdentityModes} from '@fluxer/constants/src/AccountIdentityConstants';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {getCurrentTimeZoneOffsetMinutes} from '@fluxer/date_utils/src/TimeZoneUtils';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnauthorizedError} from '@fluxer/errors/src/domains/core/UnauthorizedError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {ConnectionResponse} from '@fluxer/schema/src/domains/connection/ConnectionSchemas';
import type {
	EmailChangeApplyRequest,
	UserUpdateWithVerificationRequest,
} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import type {
	UserPrivateResponse,
	UserProfileFullResponse,
	UserUpdateResponse,
	UserUsernamePromptResponse,
} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type {Context} from 'hono';

type UserUpdatePayload = Omit<
	UserUpdateWithVerificationRequest,
	'mfa_method' | 'mfa_code' | 'webauthn_response' | 'webauthn_challenge' | 'email_token'
>;

const EMAIL_VERIFICATION_REQUIRED_PROFILE_UPDATE_FIELDS: ReadonlyArray<keyof UserUpdatePayload> = [
	'username',
	'discriminator',
	'global_name',
	'avatar',
	'banner',
	'bio',
	'pronouns',
	'accent_color',
	'name_style',
	'theme_colors',
	'timezone',
	'timezone_privacy_flags',
	'premium_badge_hidden',
	'premium_badge_masked',
	'premium_badge_timestamp_hidden',
	'premium_badge_sequence_hidden',
];

function hasProfileCustomizationUpdate(data: UserUpdatePayload): boolean {
	return EMAIL_VERIFICATION_REQUIRED_PROFILE_UPDATE_FIELDS.some((field) => data[field] !== undefined);
}

function hasDefinedUserUpdatePayload(data: UserUpdatePayload): boolean {
	return Object.values(data).some((value) => value !== undefined);
}

function profileFieldsChanged(before: User, after: User): boolean {
	return (
		before.username !== after.username ||
		before.globalName !== after.globalName ||
		before.bio !== after.bio ||
		before.avatarHash !== after.avatarHash ||
		before.pronouns !== after.pronouns
	);
}

interface UserProfileParams {
	currentUserId: UserID;
	targetUserId: UserID;
	guildId?: bigint;
	withMutualFriends?: boolean;
	withMutualGuilds?: boolean;
	viewer?: ProfileViewer;
	requestCache: RequestCache;
}

export class UserAccountRequestService {
	constructor(
		private readonly emailChangeService: EmailChangeService,
		private readonly userAccountService: UserAccountService,
		private readonly userChannelService: UserChannelService,
		private readonly userRepository: UserRepository,
		private readonly userCacheService: UserCacheService,
	) {}

	async getUsernameStatus(userId: UserID) {
		try {
			const status = await getUsernameOwnershipService().getPrivateStatus(userId);
			return {...status, changeAvailableAt: status.changeAvailableAt?.toISOString() ?? null};
		} catch (cause) {
			throw new FluxerError({
				code: APIErrorCodes.USERNAME_UNAVAILABLE,
				status: 503,
				cause: cause instanceof Error ? cause : undefined,
			});
		}
	}

	async getUsernamePrompt(user: User): Promise<UserUsernamePromptResponse> {
		const now = Date.now();
		if (
			user.isBot ||
			user.isSystem ||
			isAccountClosed(user) ||
			user.usernameState === 'selected' ||
			user.usernameState === 'reselect_required' ||
			((user.flags & UserFlags.DISABLED) !== 0n &&
				(user.tempBannedUntil === null || user.tempBannedUntil.getTime() > now))
		)
			return {show: false};
		const migration = await readUsernameMigration();
		if (
			migration.state !== 'selecting' ||
			!migration.started_at ||
			!migration.forced_at ||
			now >= Date.parse(migration.forced_at)
		)
			return {show: false};
		const jitter =
			createHash('sha256').update(`${user.id}:${migration.epoch}`).digest().readUInt32BE(0) % (6 * 3600000 + 1);
		const firstDueAt = Date.parse(migration.started_at) + jitter;
		const dayStart = Math.floor((now + 3 * 3600000) / 86400000) * 86400000 - 3 * 3600000;
		const dueAt = dayStart <= firstDueAt ? firstDueAt : dayStart + jitter;
		if (!Number.isFinite(dueAt)) return {show: false};
		if (now < dueAt) return {show: false, retry_after_ms: dueAt - now};
		const day = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Europe/Istanbul',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(now);
		try {
			return {show: (await getKVClient().set(`uprompt:${user.id}:${day}`, '1', 'EX', 172800, 'NX')) === 'OK'};
		} catch {
			return {show: false};
		}
	}

	getCurrentUserResponse(params: {
		authTokenType?: 'session' | 'bearer' | 'bot' | 'admin_api_key';
		oauthBearerScopes?: Set<string> | null;
		user?: User;
	}): UserPrivateResponse {
		const tokenType = params.authTokenType;
		if (tokenType === 'bearer') {
			const bearerUser = params.user;
			if (!bearerUser) {
				throw new UnauthorizedError();
			}
			const includeEmail = params.oauthBearerScopes?.has('email') ?? false;
			const response = mapUserToPrivateResponse(bearerUser);
			if (!includeEmail) {
				response.email = null;
			}
			this.stripBearerSensitiveFields(response);
			return response;
		}
		const user = params.user;
		if (user) {
			return mapUserToPrivateResponse(user);
		}
		throw new UnauthorizedError();
	}

	async updateCurrentUser(params: {
		ctx: Context<HonoEnv>;
		user: User;
		body: UserUpdateWithVerificationRequest;
		authSession: AuthSession;
	}): Promise<UserUpdateResponse> {
		const {ctx, body, authSession} = params;
		const {user} = params;
		const oldEmail = user.email;
		const {
			mfa_method: _mfaMethod,
			mfa_code: _mfaCode,
			webauthn_response: _webauthnResponse,
			webauthn_challenge: _webauthnChallenge,
			email_token: emailToken,
			...userUpdateDataRest
		} = body;
		let userUpdateData: UserUpdatePayload = userUpdateDataRest;
		const emailTokenProvided = emailToken !== undefined;
		if (!emailTokenProvided && !hasDefinedUserUpdatePayload(userUpdateData)) {
			return mapUserToPrivateResponse(user);
		}
		if (userUpdateData.email !== undefined) {
			throw InputValidationError.fromCode('email', ValidationErrorCodes.EMAIL_MUST_BE_CHANGED_VIA_TOKEN);
		}
		const isUnclaimed = user.isUnclaimedAccount();
		if (!isUnclaimed && userUpdateData.new_password !== undefined && !userUpdateData.password) {
			throw InputValidationError.fromCode('password', ValidationErrorCodes.PASSWORD_NOT_SET);
		}
		if (isUnclaimed) {
			const allowed = new Set(['new_password', 'has_dismissed_premium_onboarding', 'has_unread_gift_inventory']);
			if (
				userUpdateData.new_password !== undefined &&
				(await ctx.get('instanceConfigRepository').getAccountIdentityMode()) === AccountIdentityModes.USERNAME
			) {
				allowed.add('username');
			}
			const disallowedField = Object.keys(userUpdateData).find((key) => !allowed.has(key));
			if (disallowedField) {
				throw InputValidationError.fromCode(
					disallowedField,
					ValidationErrorCodes.UNCLAIMED_ACCOUNTS_CAN_ONLY_SET_EMAIL_VIA_TOKEN,
				);
			}
		}
		if (!isUnclaimed && hasProfileCustomizationUpdate(userUpdateData)) {
			requireEmailVerified(user, 'profile');
			assertAccountNotLimited(user);
		}
		let emailFromToken: string | null = null;
		let emailVerifiedViaToken = false;
		const needsVerification = this.requiresSensitiveUserVerification(user, userUpdateData, emailTokenProvided);
		let sudoResult: SudoVerificationResult | null = null;
		if (needsVerification) {
			sudoResult = await requireSudoMode(ctx, user, body);
		}
		if (emailTokenProvided && emailToken) {
			emailFromToken = await this.emailChangeService.getTokenEmail(user.id, emailToken);
			userUpdateData = {...userUpdateData, email: emailFromToken};
			emailVerifiedViaToken = true;
			if (isBlockedEmailDomain(extractEmailDomain(emailFromToken))) {
				throw InputValidationError.fromCode('email', ValidationErrorCodes.INVALID_EMAIL_ADDRESS);
			}
		}
		const {user: updatedUser, authSessionReplacement} = await this.userAccountService.update({
			user,
			oldAuthSession: authSession,
			data: userUpdateData,
			request: ctx.req.raw,
			sudoContext: sudoResult ?? undefined,
			emailVerifiedViaToken,
		});
		if (emailTokenProvided && emailToken) {
			await this.emailChangeService.deleteToken(emailToken);
		}
		const emailActuallyChanged =
			!!emailFromToken &&
			!!updatedUser.email &&
			(oldEmail == null || oldEmail.toLowerCase() !== updatedUser.email.toLowerCase());
		if (emailActuallyChanged && updatedUser.email) {
			await emitActivity('email_changed', updatedUser.id.toString(), {
				user_id: updatedUser.id.toString(),
				new_email: updatedUser.email,
				was_unclaimed: isUnclaimed,
				has_ever_purchased: updatedUser.hasEverPurchased,
			});
		}
		if (profileFieldsChanged(user, updatedUser)) {
			await emitActivity('profile_updated', updatedUser.id.toString(), {
				user_id: updatedUser.id.toString(),
				username: updatedUser.username,
				global_name: updatedUser.globalName,
				bio: updatedUser.bio,
				avatar_hash: updatedUser.avatarHash,
				pronouns: updatedUser.pronouns,
			});
		}
		if (emailActuallyChanged && oldEmail) {
			try {
				await AuthEmailRevert.issueEmailRevertToken(ctx.get('apiContext'), {
					user: updatedUser,
					previousEmail: oldEmail,
					newEmail: updatedUser.email,
				});
			} catch (error) {
				Logger.warn({error, userId: updatedUser.id}, 'Failed to issue email revert token');
			}
		}
		const response = mapUserToPrivateResponse(updatedUser);
		if (!authSessionReplacement) {
			return response;
		}
		return {
			...response,
			token: authSessionReplacement.token,
			auth_session_id_hash: authSessionReplacement.authSessionIdHash,
		};
	}

	async applyEmailChange(params: {
		ctx: Context<HonoEnv>;
		user: User;
		body: EmailChangeApplyRequest;
		authSession: AuthSession;
	}): Promise<UserPrivateResponse> {
		return this.updateCurrentUser({
			ctx: params.ctx,
			user: params.user,
			body: params.body,
			authSession: params.authSession,
		});
	}

	async preloadMessages(params: {
		userId: UserID;
		viewer: ThreadViewer;
		channels: ReadonlyArray<bigint>;
		requestCache: RequestCache;
	}): Promise<Record<string, unknown>> {
		const channelIds = params.channels.map((channelId) => createChannelID(channelId));
		return this.userChannelService.preloadDMMessages({
			userId: params.userId,
			viewer: params.viewer,
			channelIds,
		});
	}

	async getUserProfile(params: UserProfileParams): Promise<UserProfileFullResponse> {
		const guildId = params.guildId ? createGuildID(params.guildId) : undefined;
		const profile = await this.userAccountService.lookupService.getUserProfile({
			userId: params.currentUserId,
			targetId: params.targetUserId,
			guildId,
			withMutualFriends: params.withMutualFriends,
			withMutualGuilds: params.withMutualGuilds,
			viewer: params.viewer,
			requestCache: params.requestCache,
		});
		const lookedUpUser = profile.user;
		let profileUser = lookedUpUser;
		let premiumType = profile.premiumType;
		let premiumSince = profile.premiumSince;
		let premiumLifetimeSequence = profile.premiumLifetimeSequence;
		let stripPremium = shouldStripExpiredPremium(profileUser);
		if (stripPremium) {
			// Micup the cached view only says the premium looks lapsed; the repair and the strip below run on the real
			// row (a projection never reaches patchUpsert), and the next request draws a view rebuilt from it.
			profileUser = await this.userRepository.findUniqueAssert(profileUser.id);
			profile.user = profileUser;
			stripPremium = shouldStripExpiredPremium(profileUser);
			await getProfileAccessCache().forgetView(profileUser.id);
		}
		if (stripPremium) {
			// Micup: paid time in the premium ledger is repaired, never stripped on a stale read. The ledger is read only
			// here, when the row already looks lapsed, so an ordinary profile view costs nothing extra.
			try {
				const premiumLedgerService = getPremiumLedgerService();
				if (await premiumLedgerService.isActive(profileUser.id)) {
					stripPremium = false;
					const {user: repairedUser} = await premiumLedgerService.ensureUserPremium(profileUser.id);
					if (repairedUser) {
						profileUser = repairedUser;
						profile.user = repairedUser;
					}
				}
			} catch (error) {
				stripPremium = false;
				Logger.warn({userId: profileUser.id.toString(), error}, 'Premium ledger check failed before returning profile');
			}
		}
		if (stripPremium) {
			try {
				const sanitizedUser = await this.userRepository.patchUpsert(
					profileUser.id,
					createPremiumClearPatch(),
					profileUser.toRow(),
				);
				if (sanitizedUser) {
					const lapsedUser = profileUser;
					profileUser = sanitizedUser;
					profile.user = sanitizedUser;
					premiumType = undefined;
					premiumSince = undefined;
					premiumLifetimeSequence = undefined;
					// Micup: the premium badge leaves the public flags; a failed announcement never fails the profile.
					await propagateIfPartialChanged(
						{userCacheService: this.userCacheService},
						lapsedUser,
						sanitizedUser,
						'before returning profile',
					);
				}
			} catch (error) {
				Logger.warn(
					{userId: profileUser.id.toString(), error},
					'Failed to sanitize expired premium fields before returning profile',
				);
			}
		}
		if (profileUser !== lookedUpUser) {
			// Micup: the lookup filled the request cache and the guild member with the partial user from before the repair
			// or strip above, so both answer with the partial user as written.
			const partialUser = this.userCacheService.setUserPartialResponseFromUserInRequestCache(
				profileUser,
				params.requestCache,
			);
			if (profile.guildMember) {
				profile.guildMember = {...profile.guildMember, user: partialUser};
			}
		}
		const restrictProfile = profile.restrictProfile;
		const hidden = isProfileHidden(profileUser);
		const userProfile = mapUserToProfileResponse(profileUser, {restrictProfile});
		const guildMemberProfile = mapGuildMemberToProfileResponse(profile.guildMemberDomain ?? null, {
			restrictProfile,
			hidden,
		});
		const timezoneOffset =
			profile.timezoneVisible && !hidden ? getCurrentTimeZoneOffsetMinutes(profileUser.timezone) : null;
		const mutualFriends = profile.mutualFriends
			? profile.mutualFriends.map(
					(user) =>
						params.requestCache.userPartials.get(user.id) ??
						this.userCacheService.setUserPartialResponseFromUserInRequestCache(user, params.requestCache),
				)
			: undefined;
		const connectedAccounts =
			profile.connections && !hidden ? this.mapConnectionsToResponse(profile.connections) : undefined;
		const response: UserProfileFullResponse = {
			user:
				params.requestCache.userPartials.get(profileUser.id) ??
				this.userCacheService.setUserPartialResponseFromUserInRequestCache(profileUser, params.requestCache),
			user_profile: userProfile,
			guild_member: profile.guildMember ?? undefined,
			guild_member_profile: guildMemberProfile ?? undefined,
			premium_type: premiumType,
			premium_since: premiumSince?.toISOString(),
			premium_lifetime_sequence: premiumLifetimeSequence,
			mutual_friends: mutualFriends,
			mutual_guilds: profile.mutualGuilds,
			connected_accounts: connectedAccounts,
			timezone_offset: timezoneOffset,
			profile_limited: restrictProfile ? true : undefined,
		};
		if (hidden) {
			return {...response, profile_effect_data: null};
		}
		return applyProfileExtensions(response, {
			userId: profileUser.id,
			viewerId: params.currentUserId,
			restrictProfile,
			user: profileUser,
			cachedBadges: profile.badges,
		});
	}

	checkTagAvailability(params: {currentUser: User; username: string; discriminator?: number}): boolean {
		const currentUser = params.currentUser;
		const discriminator = params.discriminator;
		if (
			params.username.toLowerCase() === currentUser.username.toLowerCase() &&
			discriminator === currentUser.discriminator
		) {
			return false;
		}
		return true;
	}

	private stripBearerSensitiveFields(response: UserPrivateResponse): void {
		delete response.username_state;
		response.acls = [];
		response.traits = [];
		response.email_bounced = undefined;
		response.mfa_enabled = false;
		response.authenticator_types = undefined;
		response.password_last_changed_at = null;
		response.nsfw_allowed = false;
		response.premium_since = null;
		response.premium_until = null;
		response.premium_will_cancel = false;
		response.premium_billing_cycle = null;
		response.premium_lifetime_sequence = null;
		response.premium_badge_hidden = false;
		response.premium_badge_masked = false;
		response.premium_badge_timestamp_hidden = false;
		response.premium_badge_sequence_hidden = false;
		response.premium_purchase_disabled = false;
		response.premium_enabled_override = false;
		response.premium_perks_disabled = false;
		response.has_dismissed_premium_onboarding = false;
		response.has_ever_purchased = false;
		response.has_unread_gift_inventory = false;
		response.unread_gift_inventory_count = 0;
		response.pending_bulk_message_deletion = null;
	}

	private requiresSensitiveUserVerification(user: User, data: UserUpdatePayload, emailTokenProvided: boolean): boolean {
		const isUnclaimed = user.isUnclaimedAccount();
		const usernameChanged = data.username !== undefined && data.username !== user.username;
		const discriminatorChanged = data.discriminator !== undefined && data.discriminator !== user.discriminator;
		const emailChanged = data.email !== undefined && data.email !== user.email;
		const newPasswordProvided = data.new_password !== undefined;
		if (isUnclaimed) {
			return usernameChanged || discriminatorChanged;
		}
		return usernameChanged || discriminatorChanged || emailTokenProvided || emailChanged || newPasswordProvided;
	}

	private mapConnectionsToResponse(connections: Array<ProfileViewConnection>): Array<ConnectionResponse> {
		return connections
			.sort((a, b) => a.sort_order - b.sort_order)
			.map((connection) => ({
				id: connection.connection_id,
				type: connection.connection_type,
				name: connection.name,
				verified: connection.verified,
				visibility_flags: connection.visibility_flags,
				sort_order: connection.sort_order,
			}));
	}
}
