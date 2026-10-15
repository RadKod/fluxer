// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS} from '@app/api/auth/AuthEmail';
import type {SudoVerificationResult} from '@app/api/auth/services/SudoVerificationService';
import type {ConnectionRepository} from '@app/api/connection/ConnectionRepository';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {GuildService} from '@app/api/guild/services/GuildService';
import {GuildMemberSearchIndexService} from '@app/api/guild/services/member/GuildMemberSearchIndexService';
import type {DiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import type {EntityAssetService} from '@app/api/infrastructure/EntityAssetService';
import type {KVAccountDeletionQueueService} from '@app/api/infrastructure/KVAccountDeletionQueueService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getFollowRepository, getProfileAccessCache} from '@app/api/middleware/ServiceSingletons';
import type {AuthSession} from '@app/api/models/AuthSession';
import type {User} from '@app/api/models/User';
import {enqueueStripeCustomerEmailSync} from '@app/api/stripe/StripeCustomer';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {
	type PartialUserChangePropagationDeps,
	propagateUserUpdate,
} from '@app/api/user/services/PartialUserChangePropagation';
import {ProfileAccessService} from '@app/api/user/services/ProfileAccessService';
import {UserAccountLifecycleService} from '@app/api/user/services/UserAccountLifecycleService';
import {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import {UserAccountNotesService} from '@app/api/user/services/UserAccountNotesService';
import {UserAccountProfileService} from '@app/api/user/services/UserAccountProfileService';
import {
	type AuthSessionReplacement,
	UserAccountSecurityService,
} from '@app/api/user/services/UserAccountSecurityService';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {UserAccountUpdatePropagator} from '@app/api/user/services/UserAccountUpdatePropagator';
import type {UserContactChangeLogService} from '@app/api/user/services/UserContactChangeLogService';
import {createPremiumClearPatch} from '@app/api/user/UserHelpers';
import {USERNAME_CLAIM_ERROR_CODES, type UsernameClaimResult} from '@app/api/user/username/UsernameOwnershipService';
import {runAllInOrder} from '@app/api/utils/ConcurrencyUtils';
import {enqueueUsernameReindex} from '@app/api/worker/tasks/ReindexUserGuildMembers';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {UserUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';

interface UpdateUserParams {
	user: User;
	oldAuthSession: AuthSession;
	data: UserUpdateRequest;
	request: Request;
	sudoContext?: SudoVerificationResult;
	emailVerifiedViaToken?: boolean;
}

interface UpdateUserResult {
	user: User;
	authSessionReplacement: AuthSessionReplacement | null;
}

export class UserAccountService {
	readonly lookupService: UserAccountLookupService;
	private readonly profileService: UserAccountProfileService;
	private readonly securityService: UserAccountSecurityService;
	readonly settingsService: UserAccountSettingsService;
	readonly notesService: UserAccountNotesService;
	readonly lifecycleService: UserAccountLifecycleService;
	readonly updatePropagator: UserAccountUpdatePropagator;
	private readonly userUpdateDeps: PartialUserChangePropagationDeps;
	private readonly userAccountRepository: UserRepository;
	private readonly guildRepository: GuildRepository;
	private readonly searchIndexService: GuildMemberSearchIndexService;

	constructor(
		private readonly apiContext: ApiContext,
		userCacheService: UserCacheService,
		guildService: GuildService,
		entityAssetService: EntityAssetService,
		guildRepository: GuildRepository,
		discriminatorService: DiscriminatorService,
		kvDeletionQueue: KVAccountDeletionQueueService,
		private readonly contactChangeLogService: UserContactChangeLogService,
		connectionRepository: ConnectionRepository,
		readonly limitConfigService: LimitConfigService,
	) {
		const {
			users: userAccountRepository,
			gateway: gatewayService,
			email: emailService,
			rateLimit: rateLimitService,
		} = this.apiContext.services;
		this.userUpdateDeps = {userCacheService, gatewayService, userRepository: userAccountRepository, guildRepository};
		this.userAccountRepository = userAccountRepository;
		this.guildRepository = guildRepository;
		const profileAccessCache = getProfileAccessCache();
		this.searchIndexService = new GuildMemberSearchIndexService();
		this.updatePropagator = new UserAccountUpdatePropagator({gatewayService, userRepository: userAccountRepository});
		this.lookupService = new UserAccountLookupService({
			userAccountRepository,
			guildRepository,
			guildService,
			discriminatorService,
			connectionRepository,
			profileAccess: new ProfileAccessService({
				users: userAccountRepository,
				settings: userAccountRepository,
				relationships: userAccountRepository,
				channels: userAccountRepository,
				// Closures, so the follow repository singleton is not touched while modules load.
				follows: {
					getFollow: (userId, targetId) => getFollowRepository().getFollow(userId, targetId),
					isFollowingCached: (userId, targetId) => getFollowRepository().isFollowingCached(userId, targetId),
				},
				cache: profileAccessCache,
			}),
		});
		this.profileService = new UserAccountProfileService({
			userAccountRepository,
			guildRepository,
			entityAssetService,
			rateLimitService,
			limitConfigService,
		});
		this.securityService = new UserAccountSecurityService({
			apiContext: this.apiContext,
			userAccountRepository,
			discriminatorService,
			rateLimitService,
			limitConfigService,
		});
		this.settingsService = new UserAccountSettingsService({
			userAccountRepository,
			updatePropagator: this.updatePropagator,
			gatewayService,
			userCacheService,
			guildRepository,
			limitConfigService,
			profileAccessCache,
		});
		this.notesService = new UserAccountNotesService({
			userAccountRepository,
			updatePropagator: this.updatePropagator,
		});
		this.lifecycleService = new UserAccountLifecycleService({
			apiContext: this.apiContext,
			userAccountRepository,
			guildRepository,
			emailService,
			userUpdateDeps: this.userUpdateDeps,
			kvDeletionQueue,
		});
	}

	async update(params: UpdateUserParams): Promise<UpdateUserResult> {
		const {user, oldAuthSession, data, request, sudoContext, emailVerifiedViaToken = false} = params;
		const profileResult = await this.profileService.processProfileUpdates({user, data});
		const securityResult = await this.securityService.processSecurityUpdates({user, data, sudoContext});
		const updates = {
			...securityResult.updates,
			...profileResult.updates,
		};
		const securityPremiumFlags = securityResult.updates.premium_flags;
		if (securityPremiumFlags !== undefined && securityPremiumFlags !== null) {
			const profilePremiumFlags = profileResult.updates.premium_flags ?? user.premiumFlags;
			updates.premium_flags = profilePremiumFlags | (securityPremiumFlags & ~user.premiumFlags);
		}
		const emailChanged = data.email !== undefined;
		if (emailChanged) {
			updates.email_verified = !!emailVerifiedViaToken;
			if (emailVerifiedViaToken && user.suspiciousActivityFlags !== null && user.suspiciousActivityFlags !== 0) {
				const newFlags = user.suspiciousActivityFlags & ~EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS;
				if (newFlags !== user.suspiciousActivityFlags) {
					updates.suspicious_activity_flags = newFlags;
				}
			}
		}
		let updatedUser: User;
		let current = user;
		try {
			if (securityResult.metadata.usernameClaim !== undefined) {
				let result: UsernameClaimResult;
				try {
					result = await getUsernameOwnershipService().claimSelf(user.id, securityResult.metadata.usernameClaim);
				} catch (cause) {
					throw new FluxerError({
						code: APIErrorCodes.USERNAME_UNAVAILABLE,
						status: 503,
						cause: cause instanceof Error ? cause : undefined,
					});
				}
				if (!result.ok)
					throw new FluxerError({
						code: USERNAME_CLAIM_ERROR_CODES[result.code],
						status: result.code === 'UNAVAILABLE' ? 503 : result.code === 'RATE_LIMITED' ? 429 : 409,
						data: result.availableAt ? {available_at: result.availableAt.toISOString()} : undefined,
					});
				// Micup: the ownership protocol rewrote the identity, so the profile write starts from the projected row.
				if (!result.noop) current = await this.userAccountRepository.findUniqueAssert(user.id);
			}
			updatedUser = await this.userAccountRepository.patchUpsert(
				user.id,
				updates,
				current.toRow(),
				user.isBot ? undefined : securityResult.metadata.identityDeadlineAt,
			);
		} catch (error) {
			Logger.error(
				{error, userId: user.id},
				'User profile update failed with unknown commit status; retaining uploaded assets',
			);
			throw error;
		} finally {
			await securityResult.metadata.usernameReservation?.release();
		}
		const finalizationSteps: Array<() => Promise<unknown>> = [
			() =>
				this.contactChangeLogService.recordDiff({
					oldUser: user,
					newUser: updatedUser,
					reason: 'user_requested',
					actorUserId: user.id,
				}),
			() => enqueueStripeCustomerEmailSync(this.apiContext.services.worker, user, updatedUser),
			async () => {
				try {
					await this.profileService.commitAssetChanges(profileResult);
				} catch (error) {
					Logger.error({error, userId: user.id}, 'Failed to commit asset changes after successful DB update');
				}
			},
			() => propagateUserUpdate(this.userUpdateDeps, user, updatedUser, {continueAfterDispatchFailure: true}),
			async () => {
				const nameChanged =
					user.username !== updatedUser.username ||
					user.discriminator !== updatedUser.discriminator ||
					user.globalName !== updatedUser.globalName;
				if (updatedUser.identityVersion > 0n && updatedUser.identityVersion !== user.identityVersion) {
					await enqueueUsernameReindex(this.apiContext.services.worker, updatedUser.id, updatedUser.identityVersion);
				} else if (nameChanged) {
					void this.reindexGuildMembersForUser(updatedUser);
				}
			},
		];
		let authSessionReplacement: AuthSessionReplacement | null = null;
		if (securityResult.metadata.invalidateAuthSessions) {
			finalizationSteps.push(
				async () => {
					authSessionReplacement = await this.securityService.invalidateAndRecreateSessions({
						user,
						oldAuthSession,
						request,
					});
				},
				() => this.userAccountRepository.deleteAllPasswordResetTokens(user.id),
			);
		}
		await runAllInOrder(finalizationSteps, 'Failed to finalize user update');
		return {user: updatedUser, authSessionReplacement};
	}

	private async reindexGuildMembersForUser(updatedUser: User): Promise<void> {
		try {
			const guildIds = await this.userAccountRepository.getUserGuildIds(updatedUser.id);
			await this.searchIndexService.updateUserMembers(updatedUser, guildIds, this.guildRepository);
		} catch (error) {
			Logger.error({userId: updatedUser.id.toString(), error}, 'Failed to reindex guild members after user update');
		}
	}

	async resetCurrentUserPremiumState(user: User): Promise<void> {
		const updates = {
			...createPremiumClearPatch(),
			premium_lifetime_sequence: null,
			stripe_subscription_id: null,
			stripe_customer_id: null,
			has_ever_purchased: null,
			first_refund_at: null,
			gift_inventory_server_seq: null,
			gift_inventory_client_seq: null,
			premium_flags: user.premiumFlags & ~PremiumFlags.ENABLED_OVERRIDE,
		};
		const updatedUser = await this.userAccountRepository.patchUpsert(user.id, updates, user.toRow());
		await propagateUserUpdate(this.userUpdateDeps, user, updatedUser);
	}
}
