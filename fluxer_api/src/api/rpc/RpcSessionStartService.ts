// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserRow} from '@app/api/database/types/UserTypes';
import {mapGuildMemberToResponse} from '@app/api/guild/GuildModel';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import {emitActivity} from '@app/api/infrastructure/activity/ActivityEvents';
import type {IDiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {
	getCachedAccountIdentity,
	getCachedTagStyle,
	getFreshCachedAccountIdentity,
} from '@app/api/instance/AccountIdentityModeCache';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getPremiumLedgerService} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {
	RpcTimingRecorder,
	type RpcTimingSteps,
	startRpcTiming,
	timeRpcStep,
	timeRpcStepSync,
} from '@app/api/rpc/RpcTimings';
import type {UserData} from '@app/api/rpc/RpcTypes';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {gameActivityPolicyState} from '@app/api/user/services/GameActivityPolicyService';
import {propagateIfPartialChanged} from '@app/api/user/services/PartialUserChangePropagation';
import {createPremiumClearPatch, shouldStripExpiredPremium} from '@app/api/user/UserHelpers';
import {hasPartialUserFieldsChanged, mapUserToPrivateResponse} from '@app/api/user/UserMappers';
import {UsernameRepairIncompleteError} from '@app/api/user/username/UsernameOwnershipService';
import {TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {PremiumFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {GameActivityPolicyState, RpcSessionTimings} from '@fluxer/schema/src/domains/rpc/RpcSchemas';

interface SessionStartUserRepository
	extends Pick<IUserRepository, 'patchUpsert' | 'updateFlags' | 'findSettings' | 'findUniqueAssert'> {}

interface SessionStartGuildRepository extends Pick<IGuildRepositoryAggregate, 'getMember' | 'upsertMember'> {}

interface SessionStartUserCacheService
	extends Pick<
		UserCacheService,
		| 'getUserPartialResponse'
		| 'setUserPartialResponseFromUser'
		| 'setUserPartialResponseFromUserInBackground'
		| 'setUserPartialResponseFromUserInRequestCache'
	> {}

interface SessionStartGatewayService extends Pick<IGatewayService, 'dispatchGuild' | 'dispatchPresence'> {}

interface SessionStartDiscriminatorService extends Pick<IDiscriminatorService, 'generateDiscriminator'> {}

interface SessionStartPremiumLedgerService extends Pick<PremiumLedgerService, 'isActive' | 'ensureUserPremium'> {}

interface SessionStartDeps {
	userRepository: SessionStartUserRepository;
	guildRepository: SessionStartGuildRepository;
	userCacheService: SessionStartUserCacheService;
	gatewayService: SessionStartGatewayService;
	discriminatorService: SessionStartDiscriminatorService;
	premiumLedgerService?: SessionStartPremiumLedgerService;
}

interface ProcessSessionStartParams {
	userData: UserData;
	requestCache: RequestCache;
	geoipCountryIso: string | null;
	clientIp: string | null;
}

interface ProcessSessionStartResult {
	user: User;
	gameActivityPolicy: GameActivityPolicyState;
	timings: RpcSessionTimings;
}

export class RpcSessionStartService {
	constructor(private readonly deps: SessionStartDeps) {}

	async processSessionStart(params: ProcessSessionStartParams): Promise<ProcessSessionStartResult> {
		const identityDeadlineAt = Date.now() + 30_000;
		const timings = new RpcTimingRecorder();
		const {userData, requestCache, geoipCountryIso, clientIp} = params;
		let user = userData.user;
		const usernameMigrationActive = (getCachedAccountIdentity().usernameMigration?.state ?? 'legacy') !== 'legacy';
		if (usernameMigrationActive && !user.isBot && !user.isSystem) {
			await timings.time('repair_username_identity', async () => {
				let operationSeen = false;
				try {
					operationSeen = await getUsernameOwnershipService().repair(user.id);
				} catch (error) {
					// Micup: the durable intent stays with the repair sweeper, so a failed repair never blocks the session.
					operationSeen = error instanceof UsernameRepairIncompleteError;
					Logger.warn({error, userId: user.id.toString()}, 'Username identity repair failed during session start');
				}
				if (!operationSeen) return;
				try {
					user = await this.deps.userRepository.findUniqueAssert(user.id);
					userData.user = user;
				} catch (error) {
					Logger.warn({error, userId: user.id.toString()}, 'Username identity reread failed during session start');
				}
			});
		}
		const startedUser = user;
		void emitActivity(
			'session_started',
			startedUser.id.toString(),
			{
				user_id: startedUser.id.toString(),
				is_bot: startedUser.isBot,
				flags: startedUser.flags.toString(),
				has_ever_paid: startedUser.hasEverPurchased,
			},
			{
				ip: clientIp,
				country: geoipCountryIso,
				ua: null,
				locale: startedUser.locale,
				channel: 'other',
				request_id: null,
			},
		);
		timings.timeSync('clear_expired_custom_status', () => {
			const userSettings = userData.settings;
			if (userSettings?.customStatus?.isExpired()) {
				const clearedSettings = Object.assign(Object.create(Object.getPrototypeOf(userSettings)), userSettings, {
					customStatus: null,
				});
				userData.settings = clearedSettings;
			}
		});
		let needsSessionStartedFlag = false;
		let premiumFlagsToUpdate: number | null = null;
		let hadPremium = false;
		let isPremium = false;
		let needsPremiumStrip = false;
		let hasBeenSanitized = false;
		let userBeforePremiumStrip = null as User | null;
		timings.timeSync('compute_session_and_premium_flags', () => {
			if (!(user.flags & UserFlags.HAS_SESSION_STARTED)) {
				needsSessionStartedFlag = true;
			}
			hadPremium = user.premiumType != null && user.premiumType > 0;
			isPremium = user.isPremium();
			needsPremiumStrip = shouldStripExpiredPremium(user);
			hasBeenSanitized = (user.premiumFlags & PremiumFlags.PERKS_SANITIZED) !== 0;
		});
		if (needsPremiumStrip) {
			await timings.time('check_premium_ledger', async () => {
				try {
					const premiumLedgerService = this.deps.premiumLedgerService ?? getPremiumLedgerService();
					if (!(await premiumLedgerService.isActive(user.id))) {
						return;
					}
					needsPremiumStrip = false;
					isPremium = true;
					const {user: repairedUser} = await premiumLedgerService.ensureUserPremium(user.id);
					if (repairedUser) {
						user = repairedUser;
						userData.user = repairedUser;
						this.deps.userCacheService.setUserPartialResponseFromUserInBackground(repairedUser, requestCache);
					}
				} catch (error) {
					// Paid time is never stripped on a guess: the expiration job or the next session settles it.
					needsPremiumStrip = false;
					isPremium = true;
					Logger.warn({userId: user.id.toString(), error}, 'Premium ledger check failed on RPC session start');
				}
			});
		}
		if (needsPremiumStrip) {
			await timings.time('strip_expired_premium', async () => {
				try {
					const strippedUser = await this.deps.userRepository.patchUpsert(
						user.id,
						createPremiumClearPatch(),
						user.toRow(),
					);
					if (strippedUser) {
						userBeforePremiumStrip = user;
						user = strippedUser;
						userData.user = strippedUser;
						// Micup: a changed partial user is refreshed in the users service once, by the announcement below.
						if (hasPartialUserFieldsChanged(userBeforePremiumStrip, strippedUser)) {
							this.deps.userCacheService.setUserPartialResponseFromUserInRequestCache(strippedUser, requestCache);
						} else {
							this.deps.userCacheService.setUserPartialResponseFromUserInBackground(strippedUser, requestCache);
						}
					}
				} catch (error) {
					Logger.warn({userId: user.id.toString(), error}, 'Failed to strip expired premium on RPC session start');
				}
			});
		}
		const freshIdentity = getFreshCachedAccountIdentity();
		const legacyIdentityWritable =
			freshIdentity !== null && (freshIdentity.usernameMigration?.state ?? 'legacy') === 'legacy';
		if (
			!isPremium &&
			(user.isBot || legacyIdentityWritable) &&
			(user.premiumFlags & PremiumFlags.DISCRIMINATOR) !== 0 &&
			getCachedTagStyle() === TagStyles.RANDOM
		) {
			const resetDiscriminatorSteps: RpcTimingSteps = {};
			const resetDiscriminatorStartedAtNs = startRpcTiming();
			try {
				const discriminatorResult = await timeRpcStep(resetDiscriminatorSteps, 'generate_discriminator', async () =>
					this.deps.discriminatorService.generateDiscriminator({
						username: user.username,
						user,
					}),
				);
				if (discriminatorResult.available && discriminatorResult.discriminator !== -1) {
					const updatedUser = await timeRpcStep(resetDiscriminatorSteps, 'persist_discriminator', async () =>
						this.deps.userRepository.patchUpsert(
							user.id,
							{
								discriminator: discriminatorResult.discriminator,
							},
							user.toRow(),
							user.isBot ? undefined : identityDeadlineAt,
						),
					);
					if (updatedUser) {
						Object.assign(user, updatedUser);
						userData.user = user;
						this.deps.userCacheService.setUserPartialResponseFromUserInBackground(user, requestCache);
						premiumFlagsToUpdate = (premiumFlagsToUpdate ?? user.premiumFlags) & ~PremiumFlags.DISCRIMINATOR;
					}
				}
			} catch (error) {
				Logger.error({userId: user.id.toString(), error}, 'Failed to reset discriminator after premium expired');
			} finally {
				timings.record('reset_expired_premium_discriminator', resetDiscriminatorStartedAtNs, resetDiscriminatorSteps);
			}
		}
		if (hadPremium && !isPremium && !hasBeenSanitized) {
			const sanitizePremiumSteps: RpcTimingSteps = {};
			const sanitizePremiumStartedAtNs = startRpcTiming();
			const guildIdsToProcess = userData.guildIds;
			try {
				const members = await timeRpcStep(sanitizePremiumSteps, 'fetch_guild_members', async () =>
					Promise.all(
						guildIdsToProcess.map(async (guildId) => {
							try {
								const member = await this.deps.guildRepository.getMember(guildId, user.id);
								return {guildId, member, error: null};
							} catch (error) {
								Logger.error(
									{userId: user.id.toString(), guildId: guildId.toString(), error},
									'Failed to fetch guild member for premium sanitization',
								);
								return {guildId, member: null, error};
							}
						}),
					),
				);
				const membersToSanitize = timeRpcStepSync(sanitizePremiumSteps, 'select_members_to_sanitize', () =>
					members.filter(
						({member, error}) =>
							!error &&
							member &&
							!member.isPremiumSanitized &&
							(member.avatarHash || member.bannerHash || member.bio || member.accentColor !== null),
					),
				);
				if (membersToSanitize.length > 0) {
					const updatePromises = membersToSanitize.map(({guildId, member}) =>
						this.deps.guildRepository
							.upsertMember({
								...member!.toRow(),
								is_premium_sanitized: true,
							})
							.then((updatedMember) => ({guildId, updatedMember, error: null})),
					);
					const updatedResults = await timeRpcStep(sanitizePremiumSteps, 'upsert_sanitized_guild_members', async () =>
						Promise.all(updatePromises),
					);
					const dispatchPromises = updatedResults.map(async ({guildId, updatedMember, error}) => {
						if (error) return;
						try {
							await this.deps.gatewayService.dispatchGuild({
								guildId,
								event: 'GUILD_MEMBER_UPDATE',
								data: await mapGuildMemberToResponse(updatedMember!, this.deps.userCacheService, requestCache),
							});
						} catch (error) {
							Logger.error(
								{userId: user.id.toString(), guildId: guildId.toString(), error},
								'Failed to dispatch guild member update after premium sanitization',
							);
						}
					});
					await timeRpcStep(sanitizePremiumSteps, 'dispatch_sanitized_member_updates', async () =>
						Promise.all(dispatchPromises),
					);
				}
			} catch (error) {
				Logger.error(
					{userId: user.id.toString(), guildIds: guildIdsToProcess.map(String), error},
					'Failed to sanitize guild member premium perks for multiple guilds',
				);
			}
			premiumFlagsToUpdate = (premiumFlagsToUpdate ?? user.premiumFlags) | PremiumFlags.PERKS_SANITIZED;
			await timeRpcStep(sanitizePremiumSteps, 'dispatch_user_update_after_premium_sanitization', async () => {
				try {
					await this.deps.gatewayService.dispatchPresence({
						userId: user.id,
						event: 'USER_UPDATE',
						data: mapUserToPrivateResponse(user),
					});
				} catch (error) {
					Logger.warn(
						{userId: user.id.toString(), error},
						'Failed to dispatch user update after premium perks sanitization',
					);
				}
			});
			timings.record('sanitize_expired_premium_perks', sanitizePremiumStartedAtNs, sanitizePremiumSteps);
		}
		if (userBeforePremiumStrip) {
			const lapsedUser = userBeforePremiumStrip;
			// Micup: the premium badge leaves the public flags. Announced after the guild member sanitization above, whose
			// own GUILD_MEMBER_UPDATE must not land after it; a failed announcement never fails the session.
			await timings.time('propagate_premium_badge_change', () =>
				propagateIfPartialChanged(
					{userCacheService: this.deps.userCacheService},
					lapsedUser,
					user,
					'on RPC session start',
				),
			);
		}
		if (needsSessionStartedFlag) {
			await timings.time('persist_session_started_flag', async () => {
				try {
					const updatedUser = await this.deps.userRepository.updateFlags(
						user.id,
						(flags) => flags | UserFlags.HAS_SESSION_STARTED,
					);
					if (updatedUser) {
						user = updatedUser;
						userData.user = updatedUser;
					}
				} catch (error) {
					Logger.warn({userId: user.id, error}, 'Failed to persist the session started flag');
				}
			});
		}
		const flagPatch: Partial<UserRow> = {};
		timings.timeSync('build_session_flag_patch', () => {
			if (premiumFlagsToUpdate !== null && premiumFlagsToUpdate !== user.premiumFlags) {
				flagPatch.premium_flags = premiumFlagsToUpdate;
			}
		});
		if (Object.keys(flagPatch).length > 0) {
			await timings.time('persist_session_flags', async () => {
				try {
					const updatedUser = await this.deps.userRepository.patchUpsert(user.id, flagPatch, user.toRow());
					if (updatedUser) {
						user = updatedUser;
						userData.user = updatedUser;
					}
				} catch (error) {
					Logger.warn({userId: user.id, error}, 'Failed to persist flags during session start');
				}
			});
		}
		userData.settings = await this.deps.userRepository.findSettings(user.id, {authoritative: true});
		if (userData.settings?.customStatus?.isExpired()) {
			userData.settings = Object.assign(Object.create(Object.getPrototypeOf(userData.settings)), userData.settings, {
				customStatus: null,
			});
		}
		return {
			user,
			gameActivityPolicy: gameActivityPolicyState(user, userData.settings),
			timings: timings.finalize(),
		};
	}
}
