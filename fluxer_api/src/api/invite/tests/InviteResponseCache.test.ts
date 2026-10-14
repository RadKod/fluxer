// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createInviteCode} from '@app/api/BrandedTypes';
import {createChannelInvite, createGuild, deleteInvite, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {InviteRepository} from '@app/api/invite/InviteRepository';
import {InviteService} from '@app/api/invite/InviteService';
import {getCacheService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const cacheKey = (code: string) => `invite:response:${code}`;

describe('Invite response cache', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});

	async function createInvite() {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Invite Cache Guild');
		const systemChannel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, systemChannel.id);
		return {owner, code: invite.code};
	}

	function getInvite(code: string, status: number) {
		return createBuilderWithoutAuth<{code: string}>(harness).get(`/invites/${code}`).expect(status).execute();
	}

	test('serves a repeated GET /invites/:code from the 30 s cache', async () => {
		const {code} = await createInvite();
		await getInvite(code, HTTP_STATUS.OK);
		expect(await getCacheService().exists(cacheKey(code))).toBe(true);
		const ttl = await getCacheService().ttl(cacheKey(code));
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(30);
		const lookup = vi.spyOn(InviteService.prototype, 'getInvite');
		const again = await getInvite(code, HTTP_STATUS.OK);
		expect(again.code).toBe(code);
		expect(lookup).not.toHaveBeenCalled();
	});

	test('never caches a missing invite', async () => {
		const code = 'nosuchinvite';
		await getInvite(code, HTTP_STATUS.NOT_FOUND);
		expect(await getCacheService().exists(cacheKey(code))).toBe(false);
		const lookup = vi.spyOn(InviteService.prototype, 'getInvite');
		await getInvite(code, HTTP_STATUS.NOT_FOUND);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	test('forgets the cached answer when the invite is deleted', async () => {
		const {owner, code} = await createInvite();
		await getInvite(code, HTTP_STATUS.OK);
		expect(await getCacheService().exists(cacheKey(code))).toBe(true);
		await deleteInvite(harness, owner.token, code);
		await getInvite(code, HTTP_STATUS.NOT_FOUND);
	});

	test('accepting an invite still reads the invite from the database', async () => {
		const {code} = await createInvite();
		const joiner = await createTestAccount(harness);
		await getInvite(code, HTTP_STATUS.OK);
		expect(await getCacheService().exists(cacheKey(code))).toBe(true);
		await new InviteRepository().delete(createInviteCode(code));
		const accept = vi.spyOn(InviteService.prototype, 'acceptInvite');
		await createBuilder(harness, joiner.token)
			.post(`/invites/${code}`)
			.body(null)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_INVITE)
			.execute();
		expect(accept).toHaveBeenCalledTimes(1);
	});
});
