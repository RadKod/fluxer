// SPDX-License-Identifier: AGPL-3.0-or-later

import {setTimeout as delay} from 'node:timers/promises';
import {createGuildID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	grantMicupBotRole,
	type MicupBotRoleGrantDeps,
	revokeMicupBotRole,
} from '@app/api/guild/micupbot/MicupBotRoleGrant';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {GuildRole} from '@app/api/models/GuildRole';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {afterEach, expect, it, vi} from 'vitest';

const guildId = createGuildID(1n),
	targetId = createUserID(2n),
	roleId = createRoleID(3n);
const previousId = Config.instance.micupBotApplicationId;
afterEach(() => {
	Config.instance.micupBotApplicationId = previousId;
	vi.restoreAllMocks();
});
it('two grants for one member keep both roles', async () => {
	Config.instance.micupBotApplicationId = '1490000000000000001';
	let held: string | null = null;
	let roles = new Set<bigint>();
	const deps: MicupBotRoleGrantDeps = {
		kvClient: {
			acquireLock: async (_key, token) => {
				if (held) return false;
				held = token;
				return true;
			},
			releaseLock: async (_key, token) => {
				if (held !== token) return false;
				held = null;
				return true;
			},
			extendLock: async (_key, token) => held === token,
		},
		guildRepository: {
			getRole: async (id) =>
				new GuildRole({
					guild_id: guildId,
					role_id: id,
					name: 'Role',
					permissions: 0n,
					position: 1,
					hoist_position: null,
					color: 0,
					icon_hash: null,
					unicode_emoji: null,
					hoist: false,
					mentionable: false,
					version: 0,
				}),
		},
		guildService: {
			members: {
				addMemberRole: async (p) => {
					const current = new Set(roles);
					await delay(1100);
					current.add(p.roleId);
					roles = current;
				},
				removeMemberRole: async (p) => {
					roles.delete(p.roleId);
				},
			},
		},
	};
	const params = {guildId, targetId, roleId, requestCache: createRequestCache(), auditLogReason: 'Test', deps};
	const renewal = vi.spyOn(deps.kvClient, 'extendLock');
	expect(
		await Promise.all([grantMicupBotRole(params), grantMicupBotRole({...params, roleId: createRoleID(4n)})]),
	).toEqual(['applied', 'applied']);
	expect(roles).toEqual(new Set([3n, 4n]));
	expect(renewal).toHaveBeenCalledWith('micupbot:mlock:1:2', expect.any(String), 5);
	expect(held).toBeNull();
	expect(await revokeMicupBotRole(params)).toBe('applied');
	expect(roles).toEqual(new Set([4n]));
	vi.spyOn(deps.guildService.members, 'addMemberRole').mockRejectedValue(new MissingPermissionsError());
	expect(await grantMicupBotRole(params)).toBe('skipped');
	expect(held).toBeNull();
	vi.spyOn(deps.guildService.members, 'addMemberRole').mockRejectedValue(new MfaNotEnabledError());
	expect(await grantMicupBotRole(params)).toBe('skipped');
	vi.spyOn(deps.guildRepository, 'getRole').mockResolvedValue(null);
	expect(await grantMicupBotRole(params)).toBe('skipped');
});
