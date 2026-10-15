// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminRepository} from '@app/api/admin/AdminRepository';
import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {GuildRow} from '@app/api/database/types/GuildTypes';
import {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {GuildBoostService} from '@app/api/guild/boost/GuildBoostService';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import * as ServiceSingletons from '@app/api/middleware/ServiceSingletons';
import {Guild} from '@app/api/models/Guild';
import {MockSnowflakeService} from '@app/api/test/mocks/MockSnowflakeService';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import backfillGuildBoosts from '@app/api/worker/tasks/admin_bulk/BackfillGuildBoosts';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
	clearWorkerDependencies();
});

test('backfills new boost markers once while preserving grandfather assets and admin suppression', async () => {
	const guildId = createGuildID(920001n);
	const repository = new GuildBoostRepository();
	const guildRepository = new GuildRepository();
	const kvClient = new MockKVProvider();
	const dispatchGuild = vi.fn(async () => {});
	const grandfather = [GuildFeatures.ANIMATED_ICON, GuildFeatures.ANIMATED_BANNER];
	const guild = new Guild({
		guild_id: guildId,
		owner_id: createUserID(1n),
		name: 'Existing boosted guild',
		features: new Set([...grandfather, GuildFeatures.AUDIO_BITRATE_128_KBPS]),
		premium_tier: 1,
		version: 1,
	} as GuildRow);
	await guildRepository.upsertPartial(guildId, guild.toRow());
	await repository.putState({
		guild_id: guildId,
		boost_count: 2,
		premium_tier: 1,
		granted_features: new Set([GuildFeatures.AUDIO_BITRATE_128_KBPS]),
		suppressed_features: new Set([GuildFeatures.MORE_EMOJI]),
		downgrade_at: null,
		vanity_release_at: null,
		updated_at: new Date(),
		version: 1,
	});
	const service = new GuildBoostService({
		repository,
		guildRepository,
		kvClient,
		cacheService: new KVCacheProvider({client: kvClient}),
		kvCounterService: {get: async () => 2},
		gatewayService: {dispatchGuild},
	} as unknown as ConstructorParameters<typeof GuildBoostService>[0]);
	vi.spyOn(ServiceSingletons, 'getGuildBoostService').mockReturnValue(service);
	setWorkerDependenciesForTest({
		kvClient,
		adminRepository: new AdminRepository(),
		snowflakeService: new MockSnowflakeService(),
	});
	const helpers: WorkerTaskHelpers = {
		jobId: 500n,
		logger: new NoopLogger(),
		addJob: async () => 0n,
		reportProgress: async () => {},
		shouldCancel: async () => false,
		setContextLink: async () => {},
	};
	const payload = {admin_user_id: '1', audit_log_reason: null};
	expect(await backfillGuildBoosts(payload, helpers)).toMatchObject({successful_count: 1, failed_count: 0});
	const updated = (await guildRepository.findUnique(guildId))!;
	expect(updated.features).toContain(GuildFeatures.BOOST_LEVEL_1);
	expect(updated.features).not.toContain(GuildFeatures.MORE_EMOJI);
	for (const feature of grandfather) {
		expect(updated.features).toContain(feature);
		expect((await repository.getState(guildId))!.granted_features).not.toContain(feature);
	}
	expect((await repository.getState(guildId))!.suppressed_features).toContain(GuildFeatures.MORE_EMOJI);
	expect(dispatchGuild).toHaveBeenCalledTimes(1);
	expect(dispatchGuild).toHaveBeenCalledWith(expect.objectContaining({event: 'GUILD_UPDATE', guildId}));
	expect(await backfillGuildBoosts(payload, {...helpers, jobId: 501n})).toMatchObject({
		successful_count: 1,
		failed_count: 0,
	});
	expect((await guildRepository.findUnique(guildId))!.features).toEqual(updated.features);
	expect(dispatchGuild).toHaveBeenCalledTimes(1);
});
