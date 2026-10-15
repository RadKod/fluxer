// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));

import {SoundboardLibrary} from './SoundboardLibrary';

function sound(id = '1', version = 1, guildId = 'guild-a'): GuildSoundboardSoundResponse {
	return {
		id,
		guild_id: guildId,
		creator_id: 'actor',
		name: `sound-${version}`,
		asset_hash: 'a'.repeat(64),
		extension: 'mp3',
		size_bytes: 12,
		duration_ms: 200,
		volume: 1,
		created_at: '2026-10-14T00:00:00.000Z',
		version,
		url: 'https://cdn.example/sound.mp3',
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return {promise, resolve};
}

describe('lazy single guild soundboard library', () => {
	afterEach(() => vi.restoreAllMocks());

	it('backs off automatic loads for thirty monotonic seconds after a failed request', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
		const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([sound()]);
		const library = new SoundboardLibrary(fetch);
		await library.load('guild-a');
		await library.load('guild-a');
		now.mockReturnValue(30999);
		await library.load('guild-a');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(library.error?.message).toBe('offline');
		now.mockReturnValue(31000);
		await library.load('guild-a');
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(library.getSound('1')).not.toBeNull();
		expect(library.error).toBeNull();
	});

	it('allows explicit refresh and clears failed-load backoff with its guild ownership', async () => {
		vi.spyOn(performance, 'now').mockReturnValue(1000);
		const fetch = vi.fn().mockRejectedValue(new Error('offline'));
		const library = new SoundboardLibrary(fetch);
		await library.load('guild-a');
		await library.load('guild-a', true);
		expect(fetch).toHaveBeenCalledTimes(2);
		await library.load('guild-b');
		expect(fetch).toHaveBeenCalledTimes(3);
		library.reset();
		await library.load('guild-b');
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it('ignores unloaded guild updates without fetching', () => {
		const fetch = vi.fn();
		const library = new SoundboardLibrary(fetch);
		library.applyUpdate({guild_id: 'guild-a', operation: 'create', sound_id: '1', version: 1, sound: sound()});
		expect(library.guildId).toBeNull();
		expect(library.sounds).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does not let a late list resurrect a deleted or older sound', async () => {
		const request = deferred<Array<GuildSoundboardSoundResponse>>();
		const library = new SoundboardLibrary(() => request.promise);
		const loading = library.load('guild-a');
		library.applyUpdate({guild_id: 'guild-a', operation: 'delete', sound_id: '1', version: 2});
		library.applyUpdate({guild_id: 'guild-a', operation: 'update', sound_id: '2', version: 3, sound: sound('2', 3)});
		request.resolve([sound('1'), sound('2')]);
		await loading;
		expect(library.sounds.map((entry) => [entry.id, entry.version])).toEqual([['2', 3]]);
		library.applyUpdate({guild_id: 'guild-a', operation: 'create', sound_id: '1', version: 1, sound: sound()});
		expect(library.getSound('1')).toBeNull();
	});

	it('drops old guild and account requests and aborts their ownership', async () => {
		const requests = [deferred<Array<GuildSoundboardSoundResponse>>(), deferred<Array<GuildSoundboardSoundResponse>>()];
		const signals: Array<AbortSignal> = [];
		let index = 0;
		const library = new SoundboardLibrary((_guildId, signal) => {
			signals.push(signal);
			return requests[index++].promise;
		});
		const oldLoad = library.load('guild-a');
		const newLoad = library.load('guild-b');
		expect(signals[0].aborted).toBe(true);
		requests[0].resolve([sound()]);
		requests[1].resolve([sound('2', 1, 'guild-b')]);
		await Promise.all([oldLoad, newLoad]);
		expect(library.sounds.map((entry) => entry.id)).toEqual(['2']);
		library.reset();
		library.applyUpdate({
			guild_id: 'guild-b',
			operation: 'create',
			sound_id: '2',
			version: 2,
			sound: sound('2', 2, 'guild-b'),
		});
		expect(library.sounds).toEqual([]);
	});

	it('deduplicates lazy loads and bounds metadata while keeping legacy overflow', async () => {
		const fetch = vi.fn(async () => Array.from({length: 300}, (_, id) => sound(String(id))));
		const library = new SoundboardLibrary(fetch);
		await Promise.all([library.load('guild-a'), library.load('guild-a')]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(library.sounds.length).toBe(256);
		expect(library.getSound('48')).not.toBeNull();
	});

	it('reconciles a forced list while preserving a concurrent new event', async () => {
		const request = deferred<Array<GuildSoundboardSoundResponse>>();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce([sound('1'), sound('2')])
			.mockReturnValueOnce(request.promise);
		const library = new SoundboardLibrary(fetch);
		await library.load('guild-a');
		const refreshing = library.load('guild-a', true);
		library.applyUpdate({guild_id: 'guild-a', operation: 'create', sound_id: '3', version: 1, sound: sound('3')});
		request.resolve([sound('2', 2)]);
		await refreshing;
		expect(library.sounds.map((entry) => entry.id).sort()).toEqual(['2', '3']);
		expect(library.getSound('2')?.version).toBe(2);
	});
});
