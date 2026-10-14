// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {GuildID, RoleID, UserID} from '@app/api/BrandedTypes';
import {micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {micupBotRoleProblem} from '@app/api/guild/micupbot/MicupBotRoleRules';
import type {IGuildRoleRepository} from '@app/api/guild/repositories/IGuildRoleRepository';
import type {GuildService} from '@app/api/guild/services/GuildService';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
export interface MicupBotRoleGrantDeps {
	kvClient: Pick<IKVProvider, 'acquireLock' | 'releaseLock' | 'extendLock'>;
	guildRepository: Pick<IGuildRoleRepository, 'getRole'>;
	guildService: {members: Pick<GuildService['members'], 'addMemberRole' | 'removeMemberRole'>};
}
export interface MicupBotRoleGrantParams {
	guildId: GuildID;
	targetId: UserID;
	roleId: RoleID;
	requestCache: RequestCache;
	auditLogReason: string;
	deps: MicupBotRoleGrantDeps;
}
export type MicupBotRoleGrantResult = 'applied' | 'skipped';
async function changeRole(p: MicupBotRoleGrantParams, grant: boolean): Promise<MicupBotRoleGrantResult> {
	const bot = micupBotUserId();
	if (bot === null) return 'skipped';
	const key = `micupbot:mlock:${p.guildId}:${p.targetId}`,
		token = randomUUID(),
		deadline = Date.now() + 5000;
	let retryMs = 25;
	while (!(await p.deps.kvClient.acquireLock(key, token, 5))) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new ResourceLockedError();
		await delay(Math.min(retryMs / 2 + Math.random() * (retryMs / 2), remaining));
		retryMs = Math.min(retryMs * 2, 250);
	}
	let lockHeld = true;
	const renewal = setInterval(() => {
		p.deps.kvClient.extendLock(key, token, 5).then(
			(held) => {
				if (!held) {
					lockHeld = false;
					Logger.warn({key}, 'Lost MicupBOT member role lock');
				}
			},
			(error: unknown) => {
				lockHeld = false;
				Logger.warn({error, key}, 'Failed to renew MicupBOT member role lock');
			},
		);
	}, 1000);
	try {
		const role = await p.deps.guildRepository.getRole(p.roleId, p.guildId);
		if (!lockHeld) throw new ResourceLockedError();
		const problem = role ? (role.guildId !== p.guildId ? 'foreign' : micupBotRoleProblem(role, p.guildId)) : 'missing';
		if (problem) {
			Logger.warn(
				{guildId: p.guildId.toString(), roleId: p.roleId.toString(), problem},
				'MicupBOT role is no longer assignable',
			);
			return 'skipped';
		}
		// TEMPORARY: a KV outage or event-loop pause over 5 s can lose the lease; fencing needs the shared member write path.
		const params = {
			userId: bot,
			targetId: p.targetId,
			guildId: p.guildId,
			roleId: p.roleId,
			requestCache: p.requestCache,
		};
		if (grant) await p.deps.guildService.members.addMemberRole(params, p.auditLogReason);
		else await p.deps.guildService.members.removeMemberRole(params, p.auditLogReason);
		if (!lockHeld) throw new ResourceLockedError();
		return 'applied';
	} catch (error) {
		if (error instanceof MissingPermissionsError || error instanceof MfaNotEnabledError) {
			Logger.warn({error, guildId: p.guildId.toString(), roleId: p.roleId.toString()}, 'MicupBOT role change denied');
			return 'skipped';
		}
		throw error;
	} finally {
		clearInterval(renewal);
		await p.deps.kvClient.releaseLock(key, token);
	}
}
export function grantMicupBotRole(p: MicupBotRoleGrantParams): Promise<MicupBotRoleGrantResult> {
	return changeRole(p, true);
}
export function revokeMicupBotRole(p: MicupBotRoleGrantParams): Promise<MicupBotRoleGrantResult> {
	return changeRole(p, false);
}
