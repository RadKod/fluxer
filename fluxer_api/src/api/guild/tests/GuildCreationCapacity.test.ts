// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {BatchBuilder} from '@app/api/database/CassandraQueryExecution';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {EntityAssetService} from '@app/api/infrastructure/EntityAssetService';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

function template(channels: Array<object>, roles: Array<object> = []) {
	return {
		name: 'Capacity',
		description: null,
		verification_level: 0,
		default_message_notifications: 0,
		explicit_content_filter: 0,
		afk_timeout: 300,
		system_channel_flags: 0,
		channels,
		roles,
	};
}

function channel(id: number, type: number, parent_id?: number) {
	return {id, type, name: `channel-${id}`, position: 0, parent_id};
}

describe('guild creation resource capacity', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	function limit(key: LimitKey, value: number) {
		const limits = getLimitConfigService();
		const snapshot = limits.getConfigSnapshot();
		vi.spyOn(limits, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [...snapshot.rules, {id: 'creation_limit', limits: {[key]: value}}],
		});
	}

	it('retains an uploaded icon when the guild write has an unknown outcome', async () => {
		const account = await createTestAccount(harness);
		vi.spyOn(BatchBuilder.prototype, 'execute').mockRejectedValueOnce(new Error('write timeout'));
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');
		await createBuilder(harness, account.token)
			.post('/guilds')
			.body({name: 'Unknown Write', icon: getPngDataUrl()})
			.expect(500)
			.execute();
		expect(rollback).not.toHaveBeenCalled();
	});

	it.each([
		['max_guild_channels', 3, undefined],
		['max_guild_channels', 1, template([channel(1, ChannelTypes.GUILD_VOICE)])],
		['max_guild_roles', 1, template([], [{id: 1, name: 'Moderator', permissions: '0'}])],
		[
			'max_channels_per_category',
			1,
			template([
				channel(1, ChannelTypes.GUILD_CATEGORY),
				channel(2, ChannelTypes.GUILD_TEXT, 1),
				channel(3, ChannelTypes.GUILD_TEXT, 1),
			]),
		],
	] as const)('rejects generated resources above %s=%s before either batch writes', async (key, value, imported) => {
		const account = await createTestAccount(harness);
		limit(key, value);
		const execute = vi.spyOn(BatchBuilder.prototype, 'execute');
		const chunked = vi.spyOn(BatchBuilder.prototype, 'executeChunked');
		await createBuilder(harness, account.token)
			.post('/guilds')
			.body({name: 'Capacity', template: imported})
			.expect(400)
			.execute();
		expect(execute).not.toHaveBeenCalled();
		expect(chunked).not.toHaveBeenCalled();
	});

	it.each([
		['max_guild_channels', template([channel(1, ChannelTypes.GUILD_TEXT), channel(2, ChannelTypes.GUILD_TEXT)])],
		[
			'max_guild_roles',
			template(
				[],
				[
					{id: 0, name: '@everyone', permissions: '0'},
					{id: 1, name: 'Mod', permissions: '0'},
				],
			),
		],
	] as const)('rejects oversized template %s before generating ids or batch entries', async (key, imported) => {
		const account = await createTestAccount(harness);
		limit(key, 1);
		const generate = vi.spyOn(getSnowflakeService(), 'generate');
		const add = vi.spyOn(BatchBuilder.prototype, 'addPrepared');
		await createBuilder(harness, account.token)
			.post('/guilds')
			.body({name: 'Oversized', template: imported})
			.expect(400)
			.execute();
		expect(generate).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
	});
});
