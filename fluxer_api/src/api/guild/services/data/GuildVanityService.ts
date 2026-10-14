// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createInviteCode,
	createVanityURLCode,
	type GuildID,
	type UserID,
	vanityCodeToInviteCode,
} from '@app/api/BrandedTypes';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import type {GuildDataHelpers} from '@app/api/guild/services/data/GuildDataHelpers';
import {type InviteRepository, isUnownedInvite} from '@app/api/invite/InviteRepository';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getCacheService} from '@app/api/middleware/ServiceSingletons';
import type {Guild} from '@app/api/models/Guild';
import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {InviteTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import type {GuildVanityURLResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {isReservedVanityCode} from '@fluxer/schema/src/primitives/MicupBrandGuard';

const VANITY_AUDIT_KEYS: ReadonlySet<string> = new Set(['vanity_url_code']);
const VANITY_LOCK_TTL_SECONDS = 30;

interface VanityRepositories {
	guildRepository: IGuildRepositoryAggregate;
	inviteRepository: InviteRepository;
}

export async function withGuildVanityLock<T>(guildId: GuildID, fn: () => Promise<T>): Promise<T> {
	const cacheService = getCacheService();
	const lockKey = `guild:${guildId}:vanity`;
	const lockToken = await cacheService.acquireLock(lockKey, VANITY_LOCK_TTL_SECONDS);
	if (!lockToken) {
		throw new ResourceLockedError();
	}
	try {
		return await fn();
	} finally {
		await cacheService.releaseLock(lockKey, lockToken);
	}
}

// Points the guild at `code` (null clears it); resolves to null when another guild holds the code.
// Run it under withGuildVanityLock with a guild read inside the lock.
export async function setGuildVanityCode(
	repositories: VanityRepositories,
	guild: Guild,
	code: string | null,
): Promise<Guild | null> {
	const {guildRepository, inviteRepository} = repositories;
	const guildId = guild.id;
	const releaseClaimAndRethrow = async (error: unknown): Promise<never> => {
		if (code != null) await releaseClaim(repositories, guildId, code);
		throw error;
	};
	if (code != null) {
		const existingInvite = await inviteRepository.findUnique(createInviteCode(code));
		// This guild's own leftover claim, or a row no one owns, goes on to createIfAbsent, which completes or takes it.
		if (existingInvite != null && existingInvite.guildId !== guildId && !isUnownedInvite(existingInvite)) return null;
		const claimed = await inviteRepository
			.createIfAbsent({
				code: createInviteCode(code),
				type: InviteTypes.GUILD,
				guild_id: guildId,
				channel_id: null,
				inviter_id: null,
				uses: 0,
				max_uses: 0,
				max_age: 0,
			})
			.catch(releaseClaimAndRethrow);
		if (!claimed) return null;
	}
	const updatedGuild = await guildRepository
		.upsertPartial(guildId, {vanity_url_code: code == null ? null : createVanityURLCode(code)}, guild.toRow())
		.catch(releaseClaimAndRethrow);
	if (guild.vanityUrlCode != null && guild.vanityUrlCode !== code) {
		await inviteRepository
			.deleteVanity(vanityCodeToInviteCode(guild.vanityUrlCode), guildId)
			.catch((error: unknown) => {
				Logger.error({error, guildId}, 'Failed to release the previous vanity URL code after a successful update');
			});
	}
	return updatedGuild;
}

async function releaseClaim(repositories: VanityRepositories, guildId: GuildID, code: string): Promise<void> {
	try {
		// A failed write may still have landed; a claim the guild now points at is in use.
		const guild = await repositories.guildRepository.findUnique(guildId);
		if (guild?.vanityUrlCode === code) return;
		await repositories.inviteRepository.deleteVanity(createInviteCode(code), guildId);
	} catch (error) {
		Logger.error({error, guildId}, 'Failed to release an unused vanity URL claim; the guild can reclaim it on retry');
	}
}

export class GuildVanityService {
	constructor(
		private readonly guildRepository: IGuildRepositoryAggregate,
		private readonly inviteRepository: InviteRepository,
		private readonly helpers: GuildDataHelpers,
	) {}

	async getVanityURL(params: {userId: UserID; guildId: GuildID}): Promise<GuildVanityURLResponse> {
		const {userId, guildId} = params;
		const {guildData, checkPermission} = await this.helpers.getGuildAuthenticated({userId, guildId});
		await checkPermission(Permissions.MANAGE_GUILD);
		if (!guildData) throw new UnknownGuildError();
		const vanityCodeString = guildData.vanity_url_code;
		if (!vanityCodeString) {
			return {code: null, uses: 0};
		}
		const vanityCode = createVanityURLCode(vanityCodeString);
		const invite = await this.inviteRepository.findUnique(vanityCodeToInviteCode(vanityCode));
		return {
			code: vanityCodeString,
			uses: invite?.uses ?? 0,
		};
	}

	async updateVanityURL(
		params: {
			userId: UserID;
			guildId: GuildID;
			code: string | null;
			requestCache: RequestCache;
		},
		auditLogReason?: string | null,
	): Promise<{
		code: string | null;
	}> {
		const {userId, guildId, code, requestCache} = params;
		const {checkPermission} = await this.helpers.getGuildAuthenticated({userId, guildId});
		await checkPermission(Permissions.MANAGE_GUILD);
		return withGuildVanityLock(guildId, async () => {
			requestCache.guilds.delete(guildId);
			const guild = await this.guildRepository.findUnique(guildId);
			if (!guild) throw new UnknownGuildError();
			const previousSnapshot = this.helpers.serializeGuildForAudit(guild);
			if (code && !guild.features.has(GuildFeatures.VANITY_URL)) {
				throw InputValidationError.fromCode('code', ValidationErrorCodes.VANITY_URL_REQUIRES_FEATURE);
			}
			if (code?.includes('fluxer')) {
				throw InputValidationError.fromCode('code', ValidationErrorCodes.VANITY_URL_CODE_CANNOT_CONTAIN_FLUXER);
			}
			if (code != null && isReservedVanityCode(code)) {
				throw InputValidationError.fromCode('code', ValidationErrorCodes.VANITY_URL_CODE_RESERVED);
			}
			if (guild.vanityUrlCode === code) {
				return {code};
			}
			const updatedGuild = await setGuildVanityCode(
				{guildRepository: this.guildRepository, inviteRepository: this.inviteRepository},
				guild,
				code,
			);
			if (!updatedGuild) {
				throw InputValidationError.fromCode('code', ValidationErrorCodes.VANITY_URL_CODE_ALREADY_TAKEN);
			}
			await this.helpers.dispatchGuildUpdate(updatedGuild);
			await this.helpers.recordAuditLog({
				guildId,
				userId,
				action: AuditLogActionType.GUILD_UPDATE,
				targetId: guildId,
				auditLogReason: auditLogReason ?? null,
				changes: this.helpers.computeGuildChanges(previousSnapshot, updatedGuild, VANITY_AUDIT_KEYS),
			});
			return {code};
		});
	}
}
