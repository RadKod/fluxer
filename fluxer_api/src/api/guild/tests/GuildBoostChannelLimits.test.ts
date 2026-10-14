// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {createChannel, createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {getChannelRepository, getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {MAX_CHANNELS_PER_CATEGORY} from '@fluxer/constants/src/LimitConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('Guild channel limit scope', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guildId: string;
	let nextChannelId = 1000000000000000000n;

	beforeEach(async () => {
		harness = await createApiTestHarness();
		owner = await createTestAccount(harness);
		guildId = (await createGuild(harness, owner.token, 'Channel limits')).id;
		// The test gateway has no channel counter; derive it from persisted channels.
		vi.spyOn(NoopGatewayService.prototype, 'getChannelCount').mockImplementation(async ({guildId}) => {
			return (await getChannelRepository().listGuildChannels(guildId, 'complete')).length;
		});
		vi.spyOn(NoopGatewayService.prototype, 'getCategoryChannelCount').mockImplementation(
			async ({guildId, categoryId}) => {
				return (await getChannelRepository().listGuildChannels(guildId, 'complete')).filter(
					(channel) => channel.parentId === categoryId,
				).length;
			},
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});

	async function setFeatures(features: Array<string>, removeFeatures: Array<string> = []): Promise<void> {
		await createBuilder(harness, '')
			.post(`/test/guilds/${guildId}/features`)
			.body({add_features: features, remove_features: removeFeatures})
			.execute();
	}

	function setOperatorLimit(limit: number, unfilteredLimit = 500): void {
		const limits = getLimitConfigService();
		const snapshot = limits.getConfigSnapshot();
		vi.spyOn(limits, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [
				...snapshot.rules,
				{id: 'operator_default_channel_capacity', limits: {max_guild_channels: unfilteredLimit}},
				{
					id: 'operator_channel_capacity',
					filters: {guildFeatures: [GuildFeatures.MORE_EMOJI]},
					limits: {max_guild_channels: limit},
				},
			],
		});
	}

	async function seedChannels(count: number, targetGuildId = guildId): Promise<void> {
		const repository = getChannelRepository();
		const channels = await repository.listGuildChannels(createGuildID(BigInt(targetGuildId)), 'complete');
		const row = channels[0].toRow();
		for (let index = channels.length; index < count; index++) {
			await repository.upsert({
				...row,
				channel_id: createChannelID(nextChannelId++),
				name: `existing-${index}`,
				position: index,
			});
		}
	}

	async function expectLimitRejected(targetGuildId = guildId): Promise<void> {
		await createBuilder(harness, owner.token)
			.post(`/guilds/${targetGuildId}/channels`)
			.body({name: 'over-limit', type: ChannelTypes.GUILD_TEXT})
			.expect(400, APIErrorCodes.MAX_GUILD_CHANNELS)
			.execute();
	}

	test('guild_override_allows_channel_501', async () => {
		setOperatorLimit(600);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(500);
		const channel = await createChannel(harness, owner.token, guildId, 'channel-501');
		expect(channel.guild_id).toBe(guildId);
		expect(await getChannelRepository().listGuildChannels(createGuildID(BigInt(guildId)), 'complete')).toHaveLength(
			501,
		);
	});

	test('foreign_guild_does_not_inherit_limit', async () => {
		setOperatorLimit(600);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		const foreignGuild = await createGuild(harness, owner.token, 'Other guild');
		await seedChannels(500, foreignGuild.id);
		await expectLimitRejected(foreignGuild.id);
		expect(
			await getChannelRepository().listGuildChannels(createGuildID(BigInt(foreignGuild.id)), 'complete'),
		).toHaveLength(500);
	});

	test.each([500, 600, 750])('operator_limit_%i_accepts_last_channel_and_rejects_next', async (limit) => {
		setOperatorLimit(limit);
		if (limit > 500) await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(limit - 1);
		await createChannel(harness, owner.token, guildId, 'last-channel');
		await expectLimitRejected();
		expect(await getChannelRepository().listGuildChannels(createGuildID(BigInt(guildId)), 'complete')).toHaveLength(
			limit,
		);
	});

	test('higher_admin_limit_survives_lower_feature_override', async () => {
		setOperatorLimit(750, 900);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(899);
		await createChannel(harness, owner.token, guildId, 'last-admin-channel');
		await expectLimitRejected();
		expect(await getChannelRepository().listGuildChannels(createGuildID(BigInt(guildId)), 'complete')).toHaveLength(
			900,
		);
	});

	test('category_limit_is_unchanged', async () => {
		setOperatorLimit(600);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		const category = await createChannel(harness, owner.token, guildId, 'Category', ChannelTypes.GUILD_CATEGORY);
		const repository = getChannelRepository();
		const [template] = await repository.listGuildChannels(createGuildID(BigInt(guildId)), 'complete');
		for (let index = 0; index < MAX_CHANNELS_PER_CATEGORY - 1; index++) {
			await repository.upsert({
				...template.toRow(),
				channel_id: createChannelID(nextChannelId++),
				type: ChannelTypes.GUILD_TEXT,
				parent_id: createChannelID(BigInt(category.id)),
			});
		}
		const request = () =>
			createBuilder<ChannelResponse>(harness, owner.token)
				.post(`/guilds/${guildId}/channels`)
				.body({name: 'category-child', type: ChannelTypes.GUILD_TEXT, parent_id: category.id});
		await request().execute();
		await request().expect(400, APIErrorCodes.MAX_CATEGORY_CHANNELS).execute();
	});

	test('guild_category_override_allows_channel_past_default', async () => {
		const limits = getLimitConfigService();
		const snapshot = limits.getConfigSnapshot();
		vi.spyOn(limits, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [
				...snapshot.rules,
				{
					id: 'operator_category_capacity',
					filters: {guildFeatures: [GuildFeatures.MORE_EMOJI]},
					limits: {max_channels_per_category: MAX_CHANNELS_PER_CATEGORY + 1},
				},
			],
		});
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		const category = await createChannel(harness, owner.token, guildId, 'Category', ChannelTypes.GUILD_CATEGORY);
		const repository = getChannelRepository();
		const [template] = await repository.listGuildChannels(createGuildID(BigInt(guildId)), 'complete');
		for (let index = 0; index < MAX_CHANNELS_PER_CATEGORY; index++) {
			await repository.upsert({
				...template.toRow(),
				channel_id: createChannelID(nextChannelId++),
				type: ChannelTypes.GUILD_TEXT,
				parent_id: createChannelID(BigInt(category.id)),
			});
		}
		const request = () =>
			createBuilder<ChannelResponse>(harness, owner.token)
				.post(`/guilds/${guildId}/channels`)
				.body({name: 'category-child', type: ChannelTypes.GUILD_TEXT, parent_id: category.id});
		await request().execute();
		await request().expect(400, APIErrorCodes.MAX_CATEGORY_CHANNELS).execute();
	});

	test('manage_channels_permission_is_unchanged', async () => {
		const fixture = await setupTestGuildWithMembers(harness, 1);
		guildId = fixture.guild.id;
		setOperatorLimit(600);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(500);
		await createBuilder(harness, fixture.members[0].token)
			.post(`/guilds/${guildId}/channels`)
			.body({name: 'unauthorized', type: ChannelTypes.GUILD_TEXT})
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		expect(await getChannelRepository().listGuildChannels(createGuildID(BigInt(guildId)), 'complete')).toHaveLength(
			500,
		);
	});

	test('downgrade_keeps_existing_channels', async () => {
		setOperatorLimit(750);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(750);
		const repository = getChannelRepository();
		const before = await repository.listGuildChannels(createGuildID(BigInt(guildId)), 'complete');
		await setFeatures([], [GuildFeatures.MORE_EMOJI]);
		await expectLimitRejected();
		const after = await repository.listGuildChannels(createGuildID(BigInt(guildId)), 'complete');
		expect(after.map((channel) => channel.toRow())).toEqual(before.map((channel) => channel.toRow()));
	});

	test('concurrent_last_slot_currently_allows_two_creates', async () => {
		setOperatorLimit(600);
		await setFeatures([GuildFeatures.MORE_EMOJI]);
		await seedChannels(599);
		let releaseCounts!: () => void;
		const bothCountsRead = new Promise<void>((resolve) => {
			releaseCounts = resolve;
		});
		let reads = 0;
		vi.spyOn(NoopGatewayService.prototype, 'getChannelCount').mockImplementation(async ({guildId}) => {
			const count = (await getChannelRepository().listGuildChannels(guildId, 'complete')).length;
			if (++reads === 2) releaseCounts();
			await bothCountsRead;
			return count;
		});
		// Characterize the existing read/write race; guild scope does not reserve the last slot.
		const results = await Promise.all([
			createChannel(harness, owner.token, guildId, 'concurrent-one'),
			createChannel(harness, owner.token, guildId, 'concurrent-two'),
		]);
		expect(results[0].id).not.toBe(results[1].id);
		expect(await getChannelRepository().listGuildChannels(createGuildID(BigInt(guildId)), 'complete')).toHaveLength(
			601,
		);
	});
});
