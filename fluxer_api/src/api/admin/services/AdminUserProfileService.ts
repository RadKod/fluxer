// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {mapUserToAdminResponse} from '@app/api/admin/models/UserTypes';
import type {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import {EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS} from '@app/api/auth/AuthEmail';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {assertMutableUserId} from '@app/api/constants/Core';
import type {EnforcementDecisionRow} from '@app/api/database/types/EnforcementTypes';
import type {EnforcementActor} from '@app/api/enforcement/EnforcementActor';
import {decisionAuditMetadata, type EnforcementDecisionService} from '@app/api/enforcement/EnforcementDecisionService';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {GuildMemberSearchIndexService} from '@app/api/guild/services/member/GuildMemberSearchIndexService';
import type {DiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import type {EntityAssetService, PreparedAssetUpload} from '@app/api/infrastructure/EntityAssetService';
import type {UsernameMigrationConfig} from '@app/api/instance/AccountIdentityModeCache';
import {Logger} from '@app/api/Logger';
import {getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {enqueueStripeCustomerEmailSync} from '@app/api/stripe/StripeCustomer';
import {canHavePublicProfile} from '@app/api/user/profile/ProfilePrivacy';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import {
	type PartialUserChangePropagationDeps,
	propagateUserUpdate,
} from '@app/api/user/services/PartialUserChangePropagation';
import {
	assertBotUsernameAvailable,
	assertNoDiscriminatorChange,
	reserveUsername,
	type UsernameReservation,
} from '@app/api/user/UniqueUsernames';
import {
	USERNAME_CLAIM_ERROR_CODES,
	type UsernameClaimResult,
	type UsernameOwnershipService,
} from '@app/api/user/username/UsernameOwnershipService';
import {UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingACLError} from '@fluxer/errors/src/domains/core/MissingACLError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {TagAlreadyTakenError} from '@fluxer/errors/src/domains/user/TagAlreadyTakenError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {
	AdminUserClearFieldsRequest,
	ChangeDobRequest,
	ChangeEmailRequest,
	ChangeUsernameRequest,
	SetUserBotStatusRequest,
	SetUserSystemStatusRequest,
	UserProfileField,
	VerifyUserEmailRequest,
} from '@fluxer/schema/src/domains/admin/AdminUserSchemas';
import {types} from 'cassandra-driver';

type UsernameAdminOwnershipService = Pick<
	UsernameOwnershipService,
	'adminAssign' | 'adminHold' | 'adminUnhold' | 'forceReselect' | 'listReservations'
>;

function requireUsernameReason(reason: string | null): string {
	if (!reason?.trim()) throw InputValidationError.create('audit_log_reason', 'A reason is required');
	return reason;
}

function requireUsernameSuccess(result: UsernameClaimResult): Extract<UsernameClaimResult, {ok: true}> {
	if (!result.ok) {
		throw new FluxerError({
			code: USERNAME_CLAIM_ERROR_CODES[result.code],
			status: result.code === 'UNAVAILABLE' ? 503 : result.code === 'RATE_LIMITED' ? 429 : 409,
			data: result.availableAt ? {available_at: result.availableAt.toISOString()} : undefined,
		});
	}
	return result;
}

interface AdminUserProfileServiceDeps {
	apiContext: ApiContext;
	discriminatorService: DiscriminatorService;
	entityAssetService: EntityAssetService;
	auditService: AdminAuditService;
	userUpdateDeps: PartialUserChangePropagationDeps;
	guildRepository: GuildRepository;
	usernameOwnershipService?: UsernameAdminOwnershipService;
	enforcement: EnforcementDecisionService;
}

function profileValues(user: User, fields: ReadonlyArray<UserProfileField>): Map<UserProfileField, string> {
	const current: Record<UserProfileField, string | null> = {
		avatar: user.avatarHash,
		banner: user.bannerHash,
		bio: user.bio,
		pronouns: user.pronouns,
		global_name: user.globalName,
	};
	return new Map(fields.flatMap((field) => (current[field] ? [[field, current[field]] as const] : [])));
}

export class AdminUserProfileService {
	private readonly searchIndexService: GuildMemberSearchIndexService;

	constructor(private readonly deps: AdminUserProfileServiceDeps) {
		this.searchIndexService = new GuildMemberSearchIndexService();
	}

	private getUsernameOwnership(): UsernameAdminOwnershipService {
		try {
			return this.deps.usernameOwnershipService ?? getUsernameOwnershipService();
		} catch (cause) {
			throw new FluxerError({
				code: APIErrorCodes.USERNAME_UNAVAILABLE,
				status: 503,
				cause: cause instanceof Error ? cause : undefined,
			});
		}
	}

	async reserveUsername(name: string, note: string, adminUserId: UserID, auditLogReason: string | null) {
		const reason = requireUsernameReason(auditLogReason);
		const result = requireUsernameSuccess(
			await this.getUsernameOwnership().adminHold(name, {adminId: adminUserId, reason, note}),
		);
		await this.deps.auditService.createAuditLog({
			adminUserId,
			targetType: 'username',
			targetId: 0n,
			action: 'reserve_username',
			auditLogReason,
			metadata: new Map([
				['username', result.username],
				['note', note],
			]),
		});
		return result;
	}

	async listUsernameReservations(bucket: number, cursor: string | null, limit: number) {
		return this.getUsernameOwnership().listReservations(bucket, cursor, limit);
	}

	async unreserveUsername(name: string, adminUserId: UserID, auditLogReason: string | null) {
		const reason = requireUsernameReason(auditLogReason);
		await this.getUsernameOwnership().adminUnhold(name, {adminId: adminUserId, reason});
		await this.deps.auditService.createAuditLog({
			adminUserId,
			targetType: 'username',
			targetId: 0n,
			action: 'unreserve_username',
			auditLogReason,
			metadata: new Map([['username', name]]),
		});
	}

	private async requireUsernameTarget(userId: UserID): Promise<User> {
		assertMutableUserId(userId);
		const user = await this.deps.apiContext.services.users.findUnique(userId);
		if (!user || user.isSystem) throw new UnknownUserError();
		if (user.isBot) throw InputValidationError.create('user_id', 'Username ownership requires a human account');
		return user;
	}

	async assignUsername(name: string, userId: UserID, adminUserId: UserID, auditLogReason: string | null) {
		const reason = requireUsernameReason(auditLogReason);
		await this.requireUsernameTarget(userId);
		const result = requireUsernameSuccess(
			await this.getUsernameOwnership().adminAssign(name, userId, {adminId: adminUserId, reason}),
		);
		await this.deps.auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'assign_username',
			auditLogReason,
			metadata: new Map([['username', result.username]]),
		});
		return result;
	}

	async forceUsernameReselect(userId: UserID, banName: boolean, adminUserId: UserID, auditLogReason: string | null) {
		const reason = requireUsernameReason(auditLogReason);
		const user = await this.requireUsernameTarget(userId);
		const suspended =
			(user.flags & UserFlags.DISABLED) !== 0n &&
			(user.tempBannedUntil === null || user.tempBannedUntil.getTime() > Date.now());
		if (suspended) throw new FluxerError({code: APIErrorCodes.USERNAME_UNAVAILABLE, status: 503});
		let migration: UsernameMigrationConfig;
		try {
			migration = await getInstanceConfigRepository().readUsernameMigrationConfig();
		} catch (cause) {
			throw new FluxerError({
				code: APIErrorCodes.USERNAME_UNAVAILABLE,
				status: 503,
				cause: cause instanceof Error ? cause : undefined,
			});
		}
		// Micup: moderation requires an open self-selection path.
		if (migration.state !== 'selecting') throw new FluxerError({code: APIErrorCodes.USERNAME_UNAVAILABLE, status: 503});
		await this.getUsernameOwnership().forceReselect(userId, banName, {adminId: adminUserId, reason});
		await this.deps.auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'force_username_reselect',
			auditLogReason,
			metadata: new Map([['ban_name', String(banName)]]),
		});
	}

	async clearUserFields(userId: UserID, {fields, basis}: AdminUserClearFieldsRequest, actor: EnforcementActor) {
		const {users: userRepository, cache: cacheService} = this.deps.apiContext.services;
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		const resetFields = [...new Set(fields)];
		let updatedUser = user;
		const clear = async () => {
			updatedUser = await this.clearFields(user, resetFields);
		};
		let decision: EnforcementDecisionRow | null = null;
		if (basis.type === 'enforcement') {
			({decision} = await this.deps.enforcement.record(
				{
					subject: {type: 'user', user},
					kind: 'profile_reset',
					input: basis.decision,
					profileReset: {fields: resetFields, values: profileValues(user, resetFields)},
					actor,
				},
				clear,
			));
		} else {
			await clear();
		}
		await this.deps.auditService.createAuditLog({
			adminUserId: actor.adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'clear_fields',
			auditLogReason: actor.internalNote,
			metadata: new Map([
				['fields', resetFields.join(',')],
				['basis', basis.type],
				...(decision ? decisionAuditMetadata(decision) : []),
			]),
		});
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, actor.acls),
		};
	}

	private async clearFields(user: User, fields: ReadonlyArray<UserProfileField>): Promise<User> {
		const {entityAssetService, userUpdateDeps} = this.deps;
		const updates: Record<string, null | string> = {};
		const preparedAssets: Array<PreparedAssetUpload> = [];
		for (const field of fields) {
			if (field === 'avatar' || field === 'banner') {
				const prepared = await entityAssetService.prepareAssetUpload({
					assetType: field,
					entityType: 'user',
					entityId: user.id,
					previousHash: field === 'avatar' ? user.avatarHash : user.bannerHash,
					base64Image: null,
					errorPath: field,
				});
				preparedAssets.push(prepared);
				updates[`${field}_hash`] = prepared.newHash;
			} else {
				updates[field] = null;
			}
		}
		const updatedUser = await this.deps.apiContext.services.users.patchUpsert(user.id, updates, user.toRow());
		await entityAssetService.commitAssetChanges(preparedAssets);
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		return updatedUser;
	}

	async setUserBotStatus(
		data: SetUserBotStatusRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const {users: userRepository, cache: cacheService} = this.deps.apiContext.services;
		const {auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		if (data.bot && user.acls.size > 0) {
			throw new AccessDeniedError();
		}
		const updates: Record<string, boolean> = {bot: data.bot};
		if (!data.bot) {
			updates['system'] = false;
		}
		const updatedUser = await userRepository.patchUpsert(userId, updates, user.toRow());
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		await auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'set_bot_status',
			auditLogReason,
			metadata: new Map([['bot', data.bot.toString()]]),
		});
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}

	async setUserSystemStatus(
		data: SetUserSystemStatusRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const {users: userRepository, cache: cacheService} = this.deps.apiContext.services;
		const {auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		if (data.system && !user.isBot) {
			throw InputValidationError.fromCode(
				'system',
				ValidationErrorCodes.USER_MUST_BE_A_BOT_TO_BE_MARKED_AS_A_SYSTEM_USER,
			);
		}
		const updatedUser = await userRepository.patchUpsert(userId, {system: data.system}, user.toRow());
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		await auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'set_system_status',
			auditLogReason,
			metadata: new Map([['system', data.system.toString()]]),
		});
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}

	async verifyUserEmail(
		data: VerifyUserEmailRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const {users: userRepository, cache: cacheService} = this.deps.apiContext.services;
		const {auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		const updates: {
			email_verified: boolean;
			email_bounced: boolean;
			suspicious_activity_flags?: number;
		} = {
			email_verified: true,
			email_bounced: false,
		};
		if (user.suspiciousActivityFlags !== null && user.suspiciousActivityFlags !== 0) {
			const newFlags = user.suspiciousActivityFlags & ~EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS;
			if (newFlags !== user.suspiciousActivityFlags) {
				updates.suspicious_activity_flags = newFlags;
			}
		}
		const updatedUser = await userRepository.patchUpsert(userId, updates, user.toRow());
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		await auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'verify_email',
			auditLogReason,
			metadata: new Map([['email', user.email ?? 'null']]),
		});
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}

	async changeUsername(
		data: ChangeUsernameRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const deadlineAt = Date.now() + 30_000;
		const {
			users: userRepository,
			cache: cacheService,
			contactChangeLog: contactChangeLogService,
		} = this.deps.apiContext.services;
		const {discriminatorService, auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		if (!user.isBot) {
			const migration = await getInstanceConfigRepository().readUsernameMigrationConfig();
			if (migration.state !== 'legacy') {
				for (const acl of [AdminACLs.USERNAME_RESERVE, AdminACLs.USER_UPDATE_USERNAME]) {
					if (!acls.has(AdminACLs.WILDCARD) && !acls.has(acl)) throw new MissingACLError(acl);
				}
				if (!auditLogReason?.trim()) throw InputValidationError.create('audit_log_reason', 'A reason is required');
				const ownership = this.getUsernameOwnership();
				assertNoDiscriminatorChange(data.discriminator, user.discriminator);
				const result = requireUsernameSuccess(
					await ownership.adminAssign(data.username, userId, {
						adminId: adminUserId,
						reason: auditLogReason,
					}),
				);
				const assignedUser = await userRepository.findUnique(userId);
				if (!assignedUser) throw new UnknownUserError();
				await contactChangeLogService.recordDiff({
					oldUser: user,
					newUser: assignedUser,
					reason: 'admin_action',
					actorUserId: adminUserId,
				});
				await auditService.createAuditLog({
					adminUserId,
					targetType: 'user',
					targetId: BigInt(userId),
					action: 'change_username',
					auditLogReason,
					metadata: new Map([
						['old_username', user.username],
						['new_username', result.username],
						['discriminator', assignedUser.discriminator.toString()],
					]),
				});
				return {user: await mapUserToAdminResponse(assignedUser, cacheService, acls)};
			}
		}
		if (user.isBot) {
			await assertBotUsernameAvailable(userId, data.username, true);
		} else {
			const policy = new UsernamePolicyService();
			const snapshot = await policy.readAuthoritative();
			const rejection = policy.check(data.username.toLowerCase(), {kind: 'human', userId}, true, snapshot, null);
			if (rejection) requireUsernameSuccess({ok: false, code: rejection});
		}
		const uniqueUsernames = !user.isBot && (await getInstanceConfigRepository().usesUniqueUsernames());
		if (uniqueUsernames) {
			assertNoDiscriminatorChange(data.discriminator, user.discriminator);
		}
		const reservation: UsernameReservation | null = uniqueUsernames
			? await reserveUsername({users: userRepository, cache: cacheService}, data.username, userId)
			: null;
		let updatedUser: User;
		let discriminatorResult: {discriminator: number; available: boolean};
		try {
			discriminatorResult = uniqueUsernames
				? {discriminator: user.discriminator, available: user.discriminator > 0}
				: await discriminatorService.generateDiscriminator({
						username: data.username,
						requestedDiscriminator: data.discriminator,
						user,
					});
			if (!discriminatorResult.available || discriminatorResult.discriminator === -1) {
				throw new TagAlreadyTakenError();
			}
			const identity = {username: data.username, discriminator: discriminatorResult.discriminator};
			updatedUser = await userRepository.patchUpsert(
				userId,
				identity,
				user.toRow(),
				user.isBot ? undefined : deadlineAt,
			);
		} finally {
			await reservation?.release();
		}
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		await contactChangeLogService.recordDiff({
			oldUser: user,
			newUser: updatedUser,
			reason: 'admin_action',
			actorUserId: adminUserId,
		});
		await auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'change_username',
			auditLogReason,
			metadata: new Map([
				['old_username', user.username],
				['new_username', data.username],
				['discriminator', discriminatorResult.discriminator.toString()],
			]),
		});
		void this.reindexGuildMembersForUser(updatedUser);
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}

	async changeEmail(
		data: ChangeEmailRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const {
			users: userRepository,
			cache: cacheService,
			contactChangeLog: contactChangeLogService,
			worker: workerService,
		} = this.deps.apiContext.services;
		const {auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		const updatedUser = await userRepository.patchUpsert(
			userId,
			{
				email: data.email,
				email_verified: false,
			},
			user.toRow(),
		);
		await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		await contactChangeLogService.recordDiff({
			oldUser: user,
			newUser: updatedUser,
			reason: 'admin_action',
			actorUserId: adminUserId,
		});
		await enqueueStripeCustomerEmailSync(workerService, user, updatedUser);
		await auditService.createAuditLog({
			adminUserId,
			targetType: 'user',
			targetId: BigInt(userId),
			action: 'change_email',
			auditLogReason,
			metadata: new Map([
				['old_email', user.email ?? 'null'],
				['new_email', data.email],
			]),
		});
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}

	private async reindexGuildMembersForUser(updatedUser: User): Promise<void> {
		try {
			const {users: userRepository} = this.deps.apiContext.services;
			const {guildRepository} = this.deps;
			const guildIds = await userRepository.getUserGuildIds(updatedUser.id);
			await this.searchIndexService.updateUserMembers(updatedUser, guildIds, guildRepository);
		} catch (error) {
			Logger.error(
				{userId: updatedUser.id.toString(), error},
				'Failed to reindex guild members after admin user update',
			);
		}
	}

	private async finalizeDobSettings(
		userId: UserID,
		dateOfBirth: string | null,
		initialSettings: UserSettings | null,
	): Promise<UserSettings> {
		const {users: userRepository} = this.deps.apiContext.services;
		let settings = initialSettings;
		for (let attempt = 0; attempt < 5; attempt++) {
			const expectedPolicyRevision = settings?.gameActivityPolicyRevision ?? 0n;
			try {
				// Micup: Recompute the permanent downgrade after each conflicting policy write.
				return await userRepository.patchSettings(
					userId,
					!canHavePublicProfile(dateOfBirth) && settings?.profilePrivacy === ProfilePrivacyLevels.EVERYONE
						? {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS}
						: {},
					{gameActivityPolicyChanged: true, expectedPolicyRevision},
				);
			} catch (error) {
				if (!(error instanceof ServiceUnavailableError) || attempt === 4) throw error;
				const current = await userRepository.findSettings(userId, {authoritative: true});
				if (!current) throw new UnknownUserError();
				if (current.gameActivityPolicyRevision === expectedPolicyRevision) throw error;
				settings = current;
			}
		}
		throw new ServiceUnavailableError();
	}

	async changeDob(
		data: ChangeDobRequest,
		adminUserId: UserID,
		auditLogReason: string | null,
		acls: ReadonlySet<string>,
	) {
		const {users: userRepository, cache: cacheService} = this.deps.apiContext.services;
		const {auditService, userUpdateDeps} = this.deps;
		const userId = createUserID(data.user_id);
		const user = await userRepository.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		const policyService = new GameActivityPolicyService({
			users: userRepository,
			gateway: this.deps.apiContext.services.gateway,
		});
		const settings = await userRepository.findSettings(userId, {authoritative: true});
		const fence = await policyService.fenceUserPolicy(userId, settings, {
			expectedPolicyRevision: settings?.gameActivityPolicyRevision ?? 0n,
		});
		const updatedUser = await userRepository.patchUpsert(
			userId,
			{
				date_of_birth: types.LocalDate.fromString(data.date_of_birth),
			},
			user.toRow(),
		);
		let auditFailed = false;
		let auditError: unknown;
		try {
			await auditService.createAuditLog({
				adminUserId,
				targetType: 'user',
				targetId: BigInt(userId),
				action: 'change_dob',
				auditLogReason,
				metadata: new Map([
					['old_dob', user.dateOfBirth ?? 'null'],
					['new_dob', data.date_of_birth],
				]),
			});
		} catch (error) {
			auditFailed = true;
			auditError = error;
		}
		try {
			const updatedSettings = await this.finalizeDobSettings(userId, updatedUser.dateOfBirth, settings);
			await policyService.applyUserPolicy(userId, fence, updatedSettings);
			await propagateUserUpdate(userUpdateDeps, user, updatedUser);
		} catch (error) {
			if (!auditFailed) throw error;
			Logger.error({error, userId: userId.toString()}, 'Failed to finalize persisted DOB after an audit failure');
		}
		if (auditFailed) throw auditError;
		return {
			user: await mapUserToAdminResponse(updatedUser, cacheService, acls),
		};
	}
}
