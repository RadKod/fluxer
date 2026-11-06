// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import * as AuthEmailRevert from '@app/api/auth/AuthEmailRevert';
import {requireSudoMode, type SudoVerificationResult} from '@app/api/auth/services/SudoVerificationService';
import {createChannelID, createGuildID, type UserID} from '@app/api/BrandedTypes';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {emitActivity} from '@app/api/infrastructure/activity/ActivityEvents';
import {isBlockedEmailDomain} from '@app/api/infrastructure/activity/SharedLists';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {usesUsernameSignIn} from '@app/api/instance/AccountIdentityModeCache';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVClient, getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {
	getOperatorPassWallService,
	getPremiumLedgerService,
	getProfileAccessCache,
} from '@app/api/middleware/ServiceSingletons';
import type {AuthSession} from '@app/api/models/AuthSession';
import type {User} from '@app/api/models/User';
import {
	dispatchOperatorPassUserUpdate,
	type OperatorPassEntitlementService,
	type OperatorPassHolder,
	operatorPassPrivateFields,
	profileOperatorPassSince,
	resolveOperatorPassHolder,
} from '@app/api/operator_pass/OperatorPassEntitlementService';
import type {OperatorPassLabsRoleService} from '@app/api/operator_pass/OperatorPassLabsRole';
import {isOperatorPassWallStanding} from '@app/api/operator_pass/OperatorPassWallPresentation';
import type {AuthTokenType, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {
	evaluateTierGateFor,
	getAccountTier,
	isInteractionTierEnforced,
	NO_TIER_CONTEXT,
	tierDenialError,
} from '@app/api/user/AccountTier';
import {isProfileHidden} from '@app/api/user/ProfileVisibility';
import type {ProfileViewer} from '@app/api/user/profile/ProfileAccessRules';
import {applyProfileExtensions} from '@app/api/user/profile/ProfileExtensionProviders';
import type {ProfileViewConnection} from '@app/api/user/profile/ProfileViewProjection';
import {resolveHiddenProfileBadges} from '@app/api/user/profile_badges/HiddenProfileBadges';
import {applyProfileBadgeSettings} from '@app/api/user/profile_badges/PremiumBadgeMasking';
import {buildOwnProfileBadges, buildProfileBadges} from '@app/api/user/profile_badges/ProfileBadgeBuilder';
import {loadProfileBadgeEnvironment} from '@app/api/user/profile_badges/ProfileBadgeEnvironment';
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
import {AccountTiers, TierGatedActions} from '@fluxer/constants/src/AccountTierConstants';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {getCurrentTimeZoneOffsetMinutes} from '@fluxer/date_utils/src/TimeZoneUtils';
import {UseClaimRouteError} from '@fluxer/errors/src/domains/auth/UseClaimRouteError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnauthorizedError} from '@fluxer/errors/src/domains/core/UnauthorizedError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {ConnectionResponse} from '@fluxer/schema/src/domains/connection/ConnectionSchemas';
import type {
	ProfileBadgePreviewRequest,
	ProfileBadgePreviewResponse,
} from '@fluxer/schema/src/domains/user/ProfileBadgeSchemas';
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

const PROFILE_CUSTOMIZATION_FIELDS: ReadonlyArray<keyof UserUpdatePayload> = [
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
	'hidden_profile_badges',
	'premium_badge_hidden',
	'premium_badge_masked',
	'premium_badge_timestamp_hidden',
	'premium_badge_sequence_hidden',
	'operator_pass_badge_hidden',
	'operator_pass_badge_timestamp_hidden',
	'operator_pass_badge_count_hidden',
];

function hasProfileCustomizationUpdate(data: UserUpdatePayload): boolean {
	return PROFILE_CUSTOMIZATION_FIELDS.some((field) => data[field] !== undefined);
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
	requestLocale: string;
}

export class UserAccountRequestService {
	constructor(
		private readonly emailChangeService: EmailChangeService,
		private readonly userAccountService: UserAccountService,
		private readonly userChannelService: UserChannelService,
		private readonly userRepository: UserRepository,
		private readonly userCacheService: UserCacheService,
		private readonly gatewayService: IGatewayService,
		private readonly operatorPassEntitlementService: OperatorPassEntitlementService | null = null,
		private readonly labsRoleService: OperatorPassLabsRoleService | null = null,
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

	async getCurrentUserResponse(params: {
		authTokenType?: AuthTokenType;
		oauthBearerScopes?: Set<string> | null;
		user?: User;
	}): Promise<UserPrivateResponse> {
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
				response.verified = false;
			}
			this.stripBearerSensitiveFields(response);
			return response;
		}
		const user = params.user;
		if (user) {
			return this.withOperatorPassFields(user, mapUserToPrivateResponse(user));
		}
		throw new UnauthorizedError();
	}

	private async withOperatorPassFields<T extends UserPrivateResponse>(user: User, response: T): Promise<T> {
		if (!this.operatorPassEntitlementService || user.isBot) {
			return response;
		}
		const holder = await this.operatorPassEntitlementService.getHolder(user);
		return {...response, ...operatorPassPrivateFields(user, holder)};
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
			return this.withOperatorPassFields(user, mapUserToPrivateResponse(user));
		}
		if (userUpdateData.email !== undefined) {
			throw InputValidationError.fromCode('email', ValidationErrorCodes.EMAIL_MUST_BE_CHANGED_VIA_TOKEN);
		}
		const isUnclaimed = getAccountTier(user) === AccountTiers.UNCLAIMED;
		const usernameSignIn = usesUsernameSignIn();
		if (
			!isUnclaimed &&
			userUpdateData.new_password !== undefined &&
			!userUpdateData.password &&
			user.passwordHash !== null
		) {
			throw InputValidationError.fromCode('password', ValidationErrorCodes.PASSWORD_NOT_SET);
		}
		const profileCustomization = hasProfileCustomizationUpdate(userUpdateData);
		const profileGate = evaluateTierGateFor(user, TierGatedActions.PROFILE_CUSTOMIZE, NO_TIER_CONTEXT);
		if (isUnclaimed && !profileGate.allowed) {
			const allowed = new Set(['new_password', 'has_dismissed_premium_onboarding', 'has_unread_gift_inventory']);
			if (userUpdateData.new_password !== undefined && usernameSignIn) {
				allowed.add('username');
			}
			const disallowedField = Object.keys(userUpdateData).find((key) => !allowed.has(key));
			if (disallowedField) {
				throw InputValidationError.fromCode(
					disallowedField,
					ValidationErrorCodes.UNCLAIMED_ACCOUNTS_CAN_ONLY_SET_EMAIL_VIA_TOKEN,
					{need: profileGate.need},
				);
			}
		} else {
			if (isUnclaimed && userUpdateData.new_password !== undefined && !usernameSignIn && !emailTokenProvided) {
				throw new UseClaimRouteError();
			}
			if (profileCustomization && !profileGate.allowed) throw tierDenialError(profileGate);
		}
		if (profileCustomization) assertAccountNotLimited(user);
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
				origin: 'user',
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
		if (
			this.labsRoleService &&
			(user.hiddenProfileBadges.has('visionary') !== updatedUser.hiddenProfileBadges.has('visionary') ||
				user.hiddenProfileBadges.has('operator_pass') !== updatedUser.hiddenProfileBadges.has('operator_pass') ||
				userUpdateData.premium_badge_masked !== undefined)
		) {
			await this.labsRoleService.resyncLabsRoles(updatedUser);
		}
		if (
			(user.hiddenProfileBadges.has('operator_pass') !== updatedUser.hiddenProfileBadges.has('operator_pass') ||
				userUpdateData.operator_pass_badge_timestamp_hidden !== undefined ||
				userUpdateData.operator_pass_badge_count_hidden !== undefined) &&
			this.operatorPassEntitlementService
		) {
			await dispatchOperatorPassUserUpdate(
				{
					repository: this.operatorPassEntitlementService.repository,
					userRepository: this.userRepository,
					gatewayService: this.gatewayService,
				},
				updatedUser.id,
			);
		}
		const response = await this.withOperatorPassFields(updatedUser, mapUserToPrivateResponse(updatedUser));
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
		const profileLookup = this.userAccountService.lookupService.getUserProfile({
			userId: params.currentUserId,
			targetId: params.targetUserId,
			guildId,
			withMutualFriends: params.withMutualFriends,
			withMutualGuilds: params.withMutualGuilds,
			viewer: params.viewer,
			requestCache: params.requestCache,
		});
		const [profile, operatorPassState, badgeEnvironment] = await Promise.all([
			profileLookup,
			this.operatorPassEntitlementService?.loadState(params.targetUserId) ?? null,
			profileLookup.then((found) => loadProfileBadgeEnvironment(found.user.badgeIds)),
		]);
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
		const userProfile = mapUserToProfileResponse(profileUser, {
			restrictProfile,
			viewerIsSelf: params.currentUserId === profileUser.id,
		});
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
		const operatorPassSince = operatorPassState
			? profileOperatorPassSince({
					user: profileUser,
					state: operatorPassState,
					viewerId: params.currentUserId,
					restrictProfile,
				})
			: null;
		const viewerIsSelf = params.currentUserId === profileUser.id;
		const operatorPass = profileUser.isBot || !operatorPassState ? null : resolveOperatorPassHolder(operatorPassState);
		const badgeInput = {
			user: profileUser,
			operatorPass,
			operatorPassQuote: await this.operatorPassWallQuote(profileUser, operatorPass),
			locale: params.requestLocale,
			environment: badgeEnvironment,
			restricted: restrictProfile,
			profileHidden: hidden,
		};
		const profileBadges = buildProfileBadges(badgeInput);
		const hiddenProfileBadgeCount = viewerIsSelf
			? buildOwnProfileBadges(badgeInput).filter((badge) => badge.hidden).length
			: undefined;
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
			profile_badges: profileBadges,
			operator_pass_since: operatorPassSince?.toISOString() ?? null,
			hidden_profile_badge_count: hiddenProfileBadgeCount,
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

	private async operatorPassWallQuote(user: User, holder: OperatorPassHolder | null): Promise<string | null> {
		if (!holder || !this.operatorPassEntitlementService || !isOperatorPassWallStanding(user)) {
			return null;
		}
		return getOperatorPassWallService().publication.shownQuote(user.id);
	}

	async previewProfileBadges(params: {
		user: User;
		settings: ProfileBadgePreviewRequest;
		requestLocale: string;
	}): Promise<ProfileBadgePreviewResponse> {
		const {user, settings} = params;
		const [operatorPassState, environment] = await Promise.all([
			user.isBot ? null : (this.operatorPassEntitlementService?.loadState(user.id) ?? null),
			loadProfileBadgeEnvironment(user.badgeIds),
		]);
		const expired = shouldStripExpiredPremium(user);
		const operatorPass = operatorPassState ? resolveOperatorPassHolder(operatorPassState) : null;
		const input = {
			user: {
				flags: user.flags,
				premiumFlags: applyProfileBadgeSettings(user.premiumFlags, settings),
				premiumType: expired ? null : user.premiumType,
				premiumSince: expired ? null : user.premiumSince,
				premiumLifetimeSequence: expired ? null : user.premiumLifetimeSequence,
				badgeIds: user.badgeIds,
				hiddenProfileBadges: resolveHiddenProfileBadges(user.hiddenProfileBadges, settings) ?? user.hiddenProfileBadges,
			},
			operatorPass,
			operatorPassQuote: await this.operatorPassWallQuote(user, operatorPass),
			locale: params.requestLocale,
			environment,
			profileHidden: isProfileHidden(user),
		};
		return {profile_badges: buildProfileBadges(input), own_badges: buildOwnProfileBadges(input)};
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
		response.is_staff = false;
		response.acls = [];
		response.traits = [];
		response.email_bounced = undefined;
		response.timezone = undefined;
		response.timezone_privacy_flags = undefined;
		response.account_limited = undefined;
		response.premium_type = null;
		response.premium_grace_ends_at = null;
		response.premium_discriminator = false;
		response.last_voice_activity_sharing_change_at = null;
		response.age_verified_adult = undefined;
		response.terms_agreed_at = null;
		response.privacy_agreed_at = null;
		response.claimed = undefined;
		response.account_tier = undefined;
		response.verification_need = undefined;
		response.has_password = undefined;
		response.date_of_birth_required = undefined;
		response.profile_restricted = undefined;
		response.mfa_enabled = false;
		response.authenticator_types = undefined;
		response.password_last_changed_at = null;
		response.nsfw_allowed = false;
		response.premium_since = null;
		response.premium_until = null;
		response.premium_will_cancel = false;
		response.premium_billing_cycle = null;
		response.premium_lifetime_sequence = null;
		response.hidden_profile_badges = [];
		response.premium_badge_hidden = false;
		response.premium_badge_masked = false;
		response.premium_badge_timestamp_hidden = false;
		response.premium_badge_sequence_hidden = false;
		response.premium_purchase_disabled = false;
		response.premium_enabled_override = false;
		response.premium_perks_disabled = false;
		response.operator_pass_since = null;
		response.has_dismissed_premium_onboarding = false;
		response.has_ever_purchased = false;
		response.has_unread_gift_inventory = false;
		response.unread_gift_inventory_count = 0;
		response.pending_bulk_message_deletion = null;
	}

	private requiresSensitiveUserVerification(user: User, data: UserUpdatePayload, emailTokenProvided: boolean): boolean {
		const isUnclaimed = getAccountTier(user) === AccountTiers.UNCLAIMED;
		const usernameChanged = data.username !== undefined && data.username !== user.username;
		const discriminatorChanged = data.discriminator !== undefined && data.discriminator !== user.discriminator;
		const emailChanged = data.email !== undefined && data.email !== user.email;
		const newPasswordProvided = data.new_password !== undefined;
		if (isUnclaimed) {
			return !isInteractionTierEnforced() && (usernameChanged || discriminatorChanged);
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
