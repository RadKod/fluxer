// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminGuildUpdateService} from '@app/api/admin/services/guild/AdminGuildUpdateService';
import {createGuildID, createUserID, createVanityURLCode} from '@app/api/BrandedTypes';
import type {GuildBoostStateRow} from '@app/api/database/types/GuildBoostTypes';
import type {GuildRow} from '@app/api/database/types/GuildTypes';
import {guildBoostFeatures} from '@app/api/guild/boost/GuildBoostLevels';
import {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {GuildBoostService} from '@app/api/guild/boost/GuildBoostService';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {Logger} from '@app/api/Logger';
import * as ServiceSingletons from '@app/api/middleware/ServiceSingletons';
import {Guild} from '@app/api/models/Guild';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, describe, expect, it, vi} from 'vitest';

const guildId = createGuildID(910001n);
const deadline = new Date('2026-10-01T00:00:00Z');

async function recoveryFixture(count = 0) {
	const repository = new GuildBoostRepository();
	const guildRepository = new GuildRepository();
	const kvClient = new MockKVProvider();
	const counter = {get: vi.fn(async () => count)};
	const dispatchGuild = vi.fn(async () => {});
	const guild = new Guild({
		guild_id: guildId,
		owner_id: createUserID(1n),
		name: 'Recovery',
		features: guildBoostFeatures(3),
		premium_tier: 3,
		version: 1,
	} as GuildRow);
	await guildRepository.upsertPartial(guildId, guild.toRow());
	await repository.putState({
		guild_id: guildId,
		boost_count: 0,
		premium_tier: 3,
		granted_features: guildBoostFeatures(3),
		suppressed_features: new Set(),
		downgrade_at: deadline,
		vanity_release_at: null,
		updated_at: deadline,
		version: 10,
	});
	const restart = () =>
		new GuildBoostService({
			repository,
			guildRepository,
			kvClient,
			cacheService: new KVCacheProvider({client: kvClient}),
			kvCounterService: counter,
			gatewayService: {dispatchGuild},
		} as unknown as ConstructorParameters<typeof GuildBoostService>[0]);
	const adminUpdate = async (addFeatures: Array<string>, removeFeatures: Array<string>) => {
		vi.spyOn(ServiceSingletons, 'getCacheService').mockReturnValue(new KVCacheProvider({client: kvClient}));
		vi.spyOn(ServiceSingletons, 'getGuildBoostService').mockReturnValue(restart());
		const admin = new AdminGuildUpdateService({
			guildRepository,
			auditService: {createAuditLog: vi.fn()},
			updatePropagator: {dispatchGuildUpdate: vi.fn()},
		} as unknown as ConstructorParameters<typeof AdminGuildUpdateService>[0]);
		return admin.updateGuildFeatures({
			guildId,
			addFeatures,
			removeFeatures,
			adminUserId: createUserID(1n),
			auditLogReason: null,
		});
	};
	return {repository, guildRepository, kvClient, counter, restart, dispatchGuild, guildId, adminUpdate};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('durable boost recovery', () => {
	it('admin grant supersedes a pending boost removal and survives repeated recompute', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date(deadline.getTime() + 1));
		const f = await recoveryFixture();
		vi.spyOn(f.guildRepository, 'upsertPartial').mockRejectedValueOnce(new Error('crash'));
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		await f.adminUpdate([GuildFeatures.MORE_EMOJI, GuildFeatures.VERIFIED], []);
		await f.restart().recompute(guildId);
		await f.restart().recompute(guildId);
		expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(
			new Set([GuildFeatures.MORE_EMOJI, GuildFeatures.VERIFIED]),
		);
		expect((await f.repository.getState(guildId))!.granted_features).not.toContain(GuildFeatures.MORE_EMOJI);
	});

	it('admin removal supersedes a pending boost addition and remains suppressed', async () => {
		const f = await recoveryFixture(14);
		const state = (await f.repository.getState(guildId))!;
		await f.repository.putState({...state, premium_tier: 0, granted_features: new Set(), downgrade_at: null});
		const guild = (await f.guildRepository.findUnique(guildId))!;
		await f.guildRepository.upsertPartial(guildId, {features: new Set(), premium_tier: 0}, guild.toRow());
		vi.spyOn(f.guildRepository, 'upsertPartial').mockRejectedValueOnce(new Error('crash'));
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		await f.adminUpdate([], [GuildFeatures.MORE_EMOJI]);
		await f.restart().recompute(guildId);
		await f.restart().recompute(guildId);
		expect((await f.guildRepository.findUnique(guildId))!.features).not.toContain(GuildFeatures.MORE_EMOJI);
		expect((await f.repository.getState(guildId))!.suppressed_features).toContain(GuildFeatures.MORE_EMOJI);
	});

	it('explicit admin grant of an existing boost feature survives a failed final state write', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date(deadline.getTime() + 1));
		const f = await recoveryFixture();
		const put = f.repository.putState.bind(f.repository);
		let writes = 0;
		vi.spyOn(f.repository, 'putState').mockImplementation(async (row) => {
			if (++writes === 2) throw new Error('crash');
			await put(row);
		});
		await expect(f.adminUpdate([GuildFeatures.MORE_EMOJI], [])).rejects.toThrow('crash');
		await f.restart().recompute(guildId);
		await f.restart().recompute(guildId);
		expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(new Set([GuildFeatures.MORE_EMOJI]));
		expect((await f.repository.getState(guildId))!.granted_features).not.toContain(GuildFeatures.MORE_EMOJI);
	});

	it('mixed admin update preserves unrelated changes when boost ownership is unchanged', async () => {
		const f = await recoveryFixture(14);
		await f.adminUpdate([GuildFeatures.MORE_EMOJI], []);
		await f.adminUpdate([GuildFeatures.MORE_EMOJI, GuildFeatures.VERIFIED], []);
		expect((await f.guildRepository.findUnique(guildId))!.features).toContain(GuildFeatures.VERIFIED);
	});
	const validIntent = {
		format_version: 1,
		operation_version: 11,
		previous_granted: [],
		previous_suppressed: [],
		add: [],
		remove: [GuildFeatures.MORE_EMOJI],
		granted: [],
		suppressed: [],
		boost_count: 0,
		premium_tier: 0,
		downgrade_at: null,
		vanity_release_at: null,
		updated_at: deadline.getTime(),
		release_vanity: false,
	};

	it.each([
		['malformed JSON', '{'],
		['obsolete feature', JSON.stringify({...validIntent, add: ['REMOVED_BOOST_FEATURE']})],
		['stale version', JSON.stringify({...validIntent, operation_version: 10})],
		['unsupported format', JSON.stringify({...validIntent, format_version: 99})],
	])('discards %s intent and preserves independent admin grants and suppressions', async (_name, pending) => {
		const f = await recoveryFixture(14);
		const guild = (await f.guildRepository.findUnique(guildId))!;
		await f.guildRepository.upsertPartial(
			guildId,
			{features: new Set([GuildFeatures.MORE_EMOJI, GuildFeatures.VERIFIED]), premium_tier: 0},
			guild.toRow(),
		);
		const old = (await f.repository.getState(guildId))!;
		await f.repository.putState({
			...old,
			premium_tier: 0,
			granted_features: new Set(),
			suppressed_features: new Set([GuildFeatures.MORE_STICKERS]),
			downgrade_at: null,
			pending_feature_changes: pending,
		});
		const warning = vi.spyOn(Logger.child({}), 'warn');
		await expect(f.restart().isVanityHeld(guildId)).resolves.toBe(false);
		await expect(f.restart().recompute(guildId)).resolves.toBeUndefined();
		const state = (await f.repository.getState(guildId))!;
		const updated = (await f.guildRepository.findUnique(guildId))!;
		expect(state.pending_feature_changes).toBeNull();
		expect(state.granted_features).not.toContain(GuildFeatures.MORE_EMOJI);
		expect(state.suppressed_features).toContain(GuildFeatures.MORE_STICKERS);
		expect(updated.features).toContain(GuildFeatures.MORE_EMOJI);
		expect(updated.features).toContain(GuildFeatures.VERIFIED);
		expect(updated.features).not.toContain(GuildFeatures.MORE_STICKERS);
		expect(updated.premiumTier).toBe(3);
		expect(warning).toHaveBeenCalledWith(
			expect.objectContaining({guildId: guildId.toString()}),
			expect.stringContaining('invalid guild boost feature intent'),
		);
	});

	it('clears invalid intent even when recomputation has no state change', async () => {
		const f = await recoveryFixture(14);
		const old = (await f.repository.getState(guildId))!;
		await f.repository.putState({...old, boost_count: 14, downgrade_at: null, pending_feature_changes: '{'});
		await expect(f.restart().recompute(guildId)).resolves.toBeUndefined();
		expect((await f.repository.getState(guildId))?.pending_feature_changes).toBeNull();
		expect(f.dispatchGuild).not.toHaveBeenCalled();
	});

	it('keeps vanity joins closed when the feature removal lands before the final state', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date(deadline.getTime() + 1));
		const f = await recoveryFixture();
		const guild = (await f.guildRepository.findUnique(guildId))!;
		await f.guildRepository.upsertPartial(guildId, {vanity_url_code: createVanityURLCode('held-code')}, guild.toRow());
		const put = f.repository.putState.bind(f.repository);
		let writes = 0;
		vi.spyOn(f.repository, 'putState').mockImplementation(async (row) => {
			if (++writes === 2) throw new Error('crash');
			await put(row);
		});
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		expect((await f.guildRepository.findUnique(guildId))!.features.size).toBe(0);
		expect(await f.restart().isVanityHeld(guildId)).toBe(true);
	});

	for (const boundary of [
		'intent-before',
		'intent-after',
		'guild-before',
		'guild-after',
		'final-before',
		'final-after',
	]) {
		it(`remove_intent_survives_each_write_boundary: ${boundary}`, async () => {
			vi.useFakeTimers({toFake: ['Date']});
			vi.setSystemTime(new Date(deadline.getTime() + 1));
			const f = await recoveryFixture();
			const originalState = f.repository.putState.bind(f.repository);
			let writes = 0;
			const stateWrite = vi.spyOn(f.repository, 'putState').mockImplementation(async (row) => {
				const step = ++writes === 1 ? 'intent' : 'final';
				if (boundary === `${step}-before`) throw new Error('crash');
				await originalState(row);
				if (boundary === `${step}-after`) throw new Error('crash');
			});
			const originalGuild = f.guildRepository.upsertPartial.bind(f.guildRepository);
			const guildWrite = vi.spyOn(f.guildRepository, 'upsertPartial').mockImplementation(async (...args) => {
				if (boundary === 'guild-before') throw new Error('crash');
				const result = await originalGuild(...args);
				if (boundary === 'guild-after') throw new Error('crash');
				return result;
			});
			await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
			if (boundary === 'intent-before') expect(guildWrite).not.toHaveBeenCalled();
			stateWrite.mockRestore();
			guildWrite.mockRestore();
			await f.kvClient.del(`boost:features:pending:{${guildId}}`);
			await f.restart().recompute(guildId);
			await f.restart().recompute(guildId);
			expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(new Set());
			const final = await f.repository.getState(guildId);
			expect(final?.granted_features).toEqual(new Set());
			expect(final?.suppressed_features).toEqual(new Set());
			expect(
				(final as GuildBoostStateRow & {pending_feature_changes: string | null}).pending_feature_changes,
			).toBeNull();
			f.counter.get.mockResolvedValue(14);
			await f.restart().recompute(guildId);
			expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(guildBoostFeatures(3));
		});
	}

	it('reupgrade_during_retry_preserves_new_entitlement', async () => {
		const f = await recoveryFixture();
		const write = vi.spyOn(f.guildRepository, 'upsertPartial').mockRejectedValueOnce(new Error('crash'));
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		write.mockRestore();
		f.counter.get.mockResolvedValue(14);
		await f.restart().recompute(guildId);
		expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(guildBoostFeatures(3));
		expect((await f.repository.getState(guildId))?.suppressed_features).toEqual(new Set());
	});

	it('legacy_add_pending_survives', async () => {
		const f = await recoveryFixture(14);
		const state = (await f.repository.getState(guildId))!;
		await f.repository.putState({...state, granted_features: null});
		await f.kvClient.setex(`boost:features:pending:{${guildId}}`, 100, JSON.stringify([...guildBoostFeatures(3)]));
		await f.restart().recompute(guildId);
		expect((await f.repository.getState(guildId))?.granted_features).toEqual(guildBoostFeatures(3));
	});

	it('add_intent_survives_restart_and_kv_pending_expiry', async () => {
		const f = await recoveryFixture(14);
		const old = (await f.repository.getState(guildId))!;
		await f.repository.putState({...old, premium_tier: 0, granted_features: new Set(), downgrade_at: null});
		const guild = (await f.guildRepository.findUnique(guildId))!;
		await f.guildRepository.upsertPartial(guildId, {features: new Set(), premium_tier: 0}, guild.toRow());
		const put = f.repository.putState.bind(f.repository);
		let writes = 0;
		vi.spyOn(f.repository, 'putState').mockImplementation(async (row) => {
			if (++writes === 2) throw new Error('crash');
			await put(row);
		});
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		await f.kvClient.del(`boost:features:pending:{${guildId}}`);
		await f.restart().recompute(guildId);
		expect((await f.repository.getState(guildId))?.granted_features).toEqual(guildBoostFeatures(3));
	});

	it('canceled recovered downgrade does not fan out when no public change ever landed', async () => {
		const f = await recoveryFixture();
		vi.spyOn(f.guildRepository, 'upsertPartial').mockRejectedValueOnce(new Error('crash'));
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		f.counter.get.mockResolvedValue(14);
		await f.restart().recompute(guildId);
		expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(guildBoostFeatures(3));
		expect(f.dispatchGuild).not.toHaveBeenCalled();
	});

	it('recovery still synchronizes a guild change that landed before final state failed', async () => {
		const f = await recoveryFixture();
		const put = f.repository.putState.bind(f.repository);
		let writes = 0;
		vi.spyOn(f.repository, 'putState').mockImplementation(async (row) => {
			if (++writes === 2) throw new Error('crash');
			await put(row);
		});
		await expect(f.restart().recompute(guildId)).rejects.toThrow('crash');
		expect((await f.guildRepository.findUnique(guildId))!.features).toEqual(new Set());
		await f.restart().recompute(guildId);
		expect(f.dispatchGuild).toHaveBeenCalledTimes(1);
	});
});
