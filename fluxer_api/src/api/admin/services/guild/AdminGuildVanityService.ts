// SPDX-License-Identifier: AGPL-3.0-or-later

import {mapGuildToAdminResponse} from '@app/api/admin/models/GuildTypes';
import type {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import type {AdminGuildUpdatePropagator} from '@app/api/admin/services/guild/AdminGuildUpdatePropagator';
import {createGuildID, type UserID} from '@app/api/BrandedTypes';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import {setGuildVanityCode, withGuildVanityLock} from '@app/api/guild/services/data/GuildVanityService';
import type {InviteRepository} from '@app/api/invite/InviteRepository';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import type {UpdateGuildVanityRequest} from '@fluxer/schema/src/domains/admin/AdminGuildSchemas';
import {isReservedVanityCode} from '@fluxer/schema/src/primitives/MicupBrandGuard';

interface AdminGuildVanityServiceDeps {
	guildRepository: IGuildRepositoryAggregate;
	inviteRepository: InviteRepository;
	auditService: AdminAuditService;
	updatePropagator: AdminGuildUpdatePropagator;
}

export class AdminGuildVanityService {
	constructor(private readonly deps: AdminGuildVanityServiceDeps) {}

	async updateGuildVanity(data: UpdateGuildVanityRequest, adminUserId: UserID, auditLogReason: string | null) {
		const {guildRepository, auditService, updatePropagator} = this.deps;
		const guildId = createGuildID(data.guild_id);
		if (data.vanity_url_code && isReservedVanityCode(data.vanity_url_code)) {
			throw InputValidationError.fromCode('vanity_url_code', ValidationErrorCodes.VANITY_URL_CODE_RESERVED);
		}
		return withGuildVanityLock(guildId, async () => {
			const guild = await guildRepository.findUnique(guildId);
			if (!guild) {
				throw new UnknownGuildError();
			}
			const oldVanity = guild.vanityUrlCode;
			const updatedGuild = await setGuildVanityCode(this.deps, guild, data.vanity_url_code || null);
			if (!updatedGuild) {
				throw InputValidationError.fromCode('vanity_url_code', ValidationErrorCodes.THIS_VANITY_URL_IS_ALREADY_TAKEN);
			}
			await updatePropagator.dispatchGuildUpdate(guildId, updatedGuild);
			await auditService.createAuditLog({
				adminUserId,
				targetType: 'guild',
				targetId: BigInt(guildId),
				action: 'update_vanity',
				auditLogReason,
				metadata: new Map([
					['old_vanity', oldVanity ?? ''],
					['new_vanity', data.vanity_url_code ?? ''],
				]),
			});
			return {
				guild: mapGuildToAdminResponse(updatedGuild),
			};
		});
	}
}
