// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID} from '@app/api/BrandedTypes';
import {createChannel, createGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {
	ALL_THREADS_ACTIVE,
	resetChannelThreadsConfig,
	setChannelThreadsConfig,
	threadsRequest,
} from '@app/api/channel/tests/ThreadTestUtils';
import {getChannelRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {ListGuildThreadsResponse} from '@fluxer/schema/src/domains/admin/AdminThreadSchemas';
import type {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('admin thread HTTP pagination', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.resetData();
		resetChannelThreadsConfig();
	});
	afterAll(async () => {
		resetChannelThreadsConfig();
		await harness.shutdown();
	});

	it('walks active and archived threads in bounded pages even when the experiment is disabled', async () => {
		await setChannelThreadsConfig(ALL_THREADS_ACTIVE);
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'paged-threads');
		const parent = await createChannel(harness, owner.token, guild.id, 'thread-parent');
		const expected: Array<string> = [];
		for (let index = 0; index < 3; index++) {
			const thread = await threadsRequest<ThreadChannelResponse>(harness, owner.token)
				.post(`/channels/${parent.id}/threads`)
				.body({name: `thread-${index}`, type: ChannelTypes.PUBLIC_THREAD})
				.expect(201)
				.execute();
			expected.push(thread.id);
			if (index === 1) {
				await getChannelRepository().threads.updateState(createChannelID(BigInt(thread.id)), () => ({archived: true}));
			}
		}
		await setChannelThreadsConfig({...ALL_THREADS_ACTIVE, enabled: false});
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.GUILD_LOOKUP,
		]);
		const seen: Array<string> = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
			const page: ListGuildThreadsResponse = await createBuilder<ListGuildThreadsResponse>(harness, admin.token)
				.get(`/admin/guilds/${guild.id}/threads?limit=1${suffix}`)
				.expect(200)
				.execute();
			expect(page.threads.length).toBeLessThanOrEqual(1);
			expect(page.next_cursor === null || typeof page.next_cursor === 'string').toBe(true);
			seen.push(...page.threads.map((thread) => thread.id));
			cursor = page.next_cursor;
			pages += 1;
			expect(pages).toBeLessThan(12);
		} while (cursor !== null);
		expect(seen).toEqual(expected);
	});

	it('rejects an oversized page and an invalid cursor while retaining the lookup ACL', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'invalid-page');
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.GUILD_LOOKUP,
		]);
		await createBuilder(harness, admin.token).get(`/admin/guilds/${guild.id}/threads?limit=101`).expect(400).execute();
		await createBuilder(harness, admin.token)
			.get(`/admin/guilds/${guild.id}/threads?cursor=invalid!`)
			.expect(400)
			.execute();
		await createBuilder(harness, owner.token).get(`/admin/guilds/${guild.id}/threads?limit=1`).expect(403).execute();
	});
});
