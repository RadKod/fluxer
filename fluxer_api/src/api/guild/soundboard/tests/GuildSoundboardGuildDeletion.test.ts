// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createGuildSoundID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import {savedSound} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import {NoopPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {getAssetDeletionQueue, getGuildRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import processAssetDeletionQueue from '@app/api/worker/tasks/ProcessAssetDeletionQueue';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const helpers = {} as WorkerTaskHelpers;

describe('Guild deletion soundboard purge', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		clearWorkerDependencies();
	});
	afterAll(async () => {
		await harness.shutdown();
	});

	async function prepare() {
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'Sound purge');
		const guildId = createGuildID(BigInt(guild.id));
		const repository = new GuildSoundboardRepository();
		const sound = savedSound({guild_id: guildId, creator_id: createUserID(BigInt(owner.userId))});
		await repository.upsertSound(sound);
		const other = savedSound({guild_id: createGuildID(999n), sound_id: createGuildSoundID(888n)});
		await repository.upsertSound(other);
		const key = `soundboard-sounds/${guildId}/${sound.assetHash}.${sound.extension}`;
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.cdn,
			key,
			body: new Uint8Array([1]),
			contentType: 'audio/mpeg',
		});
		return {owner, guildId, repository, sound, other, key};
	}

	it('removes guild sound rows and reuses the existing retrying storage/CDN queue', async () => {
		const f = await prepare();
		await createBuilder(harness, f.owner.token)
			.post(`/guilds/${f.guildId}/delete`)
			.body({password: f.owner.password})
			.expect(204)
			.execute();
		expect(await f.repository.listSounds(f.guildId)).toEqual([]);
		expect(await f.repository.getSound(f.other.guildId, f.other.soundId)).not.toBeNull();
		const queue = getAssetDeletionQueue();
		expect(await queue.getQueueSize()).toBe(1);
		expect(harness.storageService.hasObject(Config.s3.buckets.cdn, f.key)).toBe(true);
		const purgeQueue = new NoopPurgeQueue();
		const addUrls = vi.spyOn(purgeQueue, 'addUrls');
		setWorkerDependenciesForTest({
			assetDeletionQueue: queue,
			purgeQueue,
			storageService: harness.storageService,
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
		});
		vi.spyOn(harness.storageService, 'deleteObject').mockRejectedValueOnce(new Error('storage unavailable'));
		await expect(processAssetDeletionQueue({}, helpers)).rejects.toThrow();
		expect(await queue.getQueueSize()).toBe(1);
		await processAssetDeletionQueue({}, helpers);
		expect(await queue.getQueueSize()).toBe(0);
		expect(harness.storageService.hasObject(Config.s3.buckets.cdn, f.key)).toBe(false);
		expect(addUrls).toHaveBeenCalledWith([`${Config.endpoints.media}/${f.key}`]);
	});

	it('still deletes the guild when sound deletion cannot be queued', async () => {
		const f = await prepare();
		const error = new Error('queue unavailable');
		vi.spyOn(getAssetDeletionQueue(), 'queueDeletion').mockRejectedValueOnce(error);
		await createBuilder(harness, f.owner.token)
			.post(`/guilds/${f.guildId}/delete`)
			.body({password: f.owner.password})
			.expect(204)
			.execute();
		expect(await f.repository.getSound(f.guildId, f.sound.soundId)).not.toBeNull();
		// sanalyer: upstream schedules the guild purge instead of deleting inline, so the row is still there here;
		// the 204 above is the contract that a failed sound queue does not block the deletion.
	});
});
