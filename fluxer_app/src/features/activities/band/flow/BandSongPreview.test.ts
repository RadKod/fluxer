// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {AudioStem, SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {
	type BandPreviewPlayer,
	BandSongPreview,
	PREVIEW_LENGTH_MS,
	previewStartMs,
	previewStems,
} from '@app/features/activities/band/flow/BandSongPreview';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn = vi.fn();
	},
}));
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({acquireSharedVoiceAudioContext: () => null}));

function song(id: string, overrides: Partial<BandSongSummary> = {}): BandSongSummary {
	return {
		id,
		name: id,
		artist: '',
		lengthMs: 200_000,
		parts: {},
		stems: true,
		coverUrl: null,
		packageUrl: '',
		packageBytes: 0,
		addedBy: null,
		groups: [],
		genre: null,
		year: null,
		previewStartMs: 60_000,
		...overrides,
	};
}

function stem(role: AudioStem['role']): AudioStem {
	return {role, fileName: `${role}.opus`, format: 'opus', data: new Uint8Array(1)};
}

describe('previewStartMs', () => {
	it('starts at the preview point and keeps the whole preview inside the song', () => {
		expect(previewStartMs({lengthMs: 200_000, previewStartMs: 60_000})).toBe(60_000);
		expect(previewStartMs({lengthMs: 200_000, previewStartMs: 195_000})).toBe(200_000 - PREVIEW_LENGTH_MS);
		expect(previewStartMs({lengthMs: 200_000, previewStartMs: null})).toBe(60_000);
		expect(previewStartMs({lengthMs: 9_000, previewStartMs: 3_000})).toBe(0);
	});
});

describe('previewStems', () => {
	it('prefers the packaged preview clip', () => {
		const result = previewStems({stems: [stem('guitar'), stem('preview'), stem('backing')]}, true);
		expect(result).toEqual({stems: [stem('preview')], clip: true});
	});

	it('plays every stem of the song without the crowd', () => {
		const result = previewStems({stems: [stem('guitar'), stem('crowd'), stem('backing'), stem('drums')]}, true);
		expect(result.stems.map((entry) => entry.role)).toEqual(['guitar', 'backing', 'drums']);
		expect(result.clip).toBe(false);
	});
});

describe('BandSongPreview', () => {
	function setup(onDevice: ReadonlyArray<string>) {
		const playbacks: Array<{songOffset: number; stop: ReturnType<typeof vi.fn>; end: () => void}> = [];
		const player: BandPreviewPlayer = vi.fn(async ({offsetMs, onEnded}) => {
			const playback = {songOffset: offsetMs, stop: vi.fn(), end: onEnded};
			playbacks.push(playback);
			return playback;
		});
		const library = {
			isOnDevice: (songId: string) => onDevice.includes(songId),
			openStored: vi.fn(async () => ({stems: [stem('backing')]}) as unknown as SongPackage),
		};
		const preview = new BandSongPreview({library, volume: () => 1, player});
		return {preview, player, library, playbacks};
	}

	it('never touches a song that is not on this device', () => {
		const {preview, library} = setup([]);
		preview.play(song('a'));
		expect(library.openStored).not.toHaveBeenCalled();
		expect(preview.state).toEqual({status: 'idle'});
	});

	it('plays a stored song from its preview point and stops when asked', async () => {
		const {preview, playbacks} = setup(['a']);
		preview.play(song('a'));
		expect(preview.state).toEqual({status: 'loading', songId: 'a'});
		await vi.waitFor(() => expect(preview.state).toEqual({status: 'playing', songId: 'a'}));
		expect(playbacks[0].songOffset).toBe(60_000);
		preview.stop();
		expect(playbacks[0].stop).toHaveBeenCalled();
		expect(preview.state).toEqual({status: 'idle'});
	});

	it('never starts a preview whose song was replaced while it loaded', async () => {
		const {preview, playbacks} = setup(['a', 'b']);
		preview.play(song('a'));
		preview.play(song('b', {previewStartMs: 30_000}));
		await vi.waitFor(() => expect(preview.state).toEqual({status: 'playing', songId: 'b'}));
		expect(playbacks.map((playback) => playback.songOffset)).toEqual([30_000]);
	});

	it('goes idle when the preview runs out', async () => {
		const {preview, playbacks} = setup(['a']);
		preview.play(song('a'));
		await vi.waitFor(() => expect(preview.state.status).toBe('playing'));
		playbacks[0].end();
		expect(preview.state).toEqual({status: 'idle'});
	});
});
