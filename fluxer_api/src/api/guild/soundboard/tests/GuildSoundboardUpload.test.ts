// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildSoundID} from '@app/api/BrandedTypes';
import * as Probe from '@app/api/guild/soundboard/GuildSoundboardDurationProbe';
import {actor, fixture, GUILD_ID, savedSound, upload} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

beforeEach(() => {
	vi.spyOn(Probe, 'resolveGuildSoundboardDurationMs').mockResolvedValue(1000);
});
afterEach(() => vi.restoreAllMocks());

describe('Guild soundboard upload trust boundary', () => {
	it('accepts exactly 512000 bytes and 5.2 seconds with no audio in metadata', async () => {
		const f = fixture();
		vi.mocked(Probe.resolveGuildSoundboardDurationMs).mockResolvedValue(5200);
		const result = await f.service.upload({...upload, audio: Buffer.alloc(512000).toString('base64')});
		expect(result).toMatchObject({size_bytes: 512000, duration_ms: 5200, version: 1});
		expect(result.asset_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.url).toContain(`/soundboard-sounds/${GUILD_ID}/${result.asset_hash}.mp3`);
		expect(result).not.toHaveProperty('audio');
		expect((await f.repository.listSounds(GUILD_ID))[0].toRow()).not.toHaveProperty('audio');
	});
	it('rejects 512001 bytes before media or storage work', async () => {
		const f = fixture();
		await expect(f.service.upload({...upload, audio: Buffer.alloc(512001).toString('base64')})).rejects.toThrow();
		expect(f.media.getMetadata).not.toHaveBeenCalled();
		expect(f.storage.uploadObject).not.toHaveBeenCalled();
	});
	it.each([null, NaN, 0, 5200.1])('rejects invalid precise duration %s before storage', async (duration) => {
		const f = fixture();
		vi.mocked(Probe.resolveGuildSoundboardDurationMs).mockResolvedValue(duration);
		await expect(f.service.upload(upload)).rejects.toThrow();
		expect(f.storage.uploadObject).not.toHaveBeenCalled();
	});
	it.each(['', 'YWJj!', 'a==='])('rejects invalid base64 %s', async (audio) => {
		const f = fixture();
		await expect(f.service.upload({...upload, audio})).rejects.toThrow();
		expect(f.media.getMetadata).not.toHaveBeenCalled();
	});
	it('rechecks permissions after media preparation', async () => {
		const f = fixture();
		f.gateway.checkPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(f.service.upload(upload)).rejects.toThrow();
		expect(f.storage.uploadObject).not.toHaveBeenCalled();
	});
	// sanalyer: Micup's per-guild write guard (guild/capacity) is not ported; one API process on Postgres.
	it.skip('serializes two service instances competing for the last slot', async () => {
		const f = fixture();
		for (let id = 1; id <= 7; id++)
			await f.repository.upsertSound(savedSound({sound_id: createGuildSoundID(BigInt(id))}));
		const other = fixture();
		const results = await Promise.allSettled([f.service.upload(upload), other.service.upload(upload)]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(await f.repository.listSounds(GUILD_ID)).toHaveLength(8);
	});
	it('retains the asset when the database write outcome is unknown and releases the guard', async () => {
		const f = fixture();
		vi.spyOn(f.repository, 'upsertSound').mockRejectedValueOnce(new Error('write timeout'));
		await expect(f.service.upload(upload)).rejects.toThrow('write timeout');
		expect(f.storage.deleteObject).not.toHaveBeenCalled();
		await expect(f.service.upload(upload)).resolves.toMatchObject({name: upload.name});
	});
	it('preserves a shared asset until its last reference is deleted', async () => {
		const f = fixture();
		const first = await f.service.upload(upload);
		const second = await f.service.upload(upload);
		await f.service.delete({...actor, soundId: createGuildSoundID(BigInt(first.id))});
		expect(f.storage.deleteObject).not.toHaveBeenCalled();
		await f.service.delete({...actor, soundId: createGuildSoundID(BigInt(second.id))});
		expect(f.storage.deleteObject).toHaveBeenCalledOnce();
	});
	it('invalidates a committed deletion when the asset reference read fails', async () => {
		const f = fixture();
		await f.repository.upsertSound(savedSound());
		vi.spyOn(f.repository, 'listSounds').mockRejectedValueOnce(new Error('read timeout'));
		await expect(f.service.delete({...actor, soundId: savedSound().soundId})).resolves.toBeUndefined();
		expect(f.storage.deleteObject).not.toHaveBeenCalled();
		expect(f.gateway.dispatchGuild).toHaveBeenCalledWith(
			expect.objectContaining({data: expect.objectContaining({operation: 'delete'})}),
		);
	});
});
