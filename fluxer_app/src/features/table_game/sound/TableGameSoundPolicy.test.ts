// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The real Fluxer one-shot sound queue (ui/state/Sound) with the player underneath it mocked.
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/streamer_mode/state/StreamerMode', () => ({default: {shouldDisableSounds: false}}));
vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));
vi.mock('@app/features/notification/utils/SoundUtils', async (importOriginal) => ({
	...(await importOriginal<object>()),
	playSound: vi.fn(async () => null),
	stopSound: vi.fn(async () => {}),
	stopAllSounds: vi.fn(async () => {}),
}));

const SoundUtils = await import('@app/features/notification/utils/SoundUtils');
const {SoundType} = SoundUtils;
const {default: Sound} = await import('@app/features/ui/state/Sound');
const {TABLE_GAME_SOUND_TYPES} = await import('@app/features/table_game/sound/TableGameSoundFiles');

function played(): Array<string> {
	return vi.mocked(SoundUtils.playSound).mock.calls.map(([type]) => type);
}

describe('table game sounds through the Fluxer one-shot queue', () => {
	let now = Date.parse('2026-10-03T12:00:00.000Z');

	beforeEach(() => {
		vi.useFakeTimers();
		now += 60_000;
		vi.setSystemTime(now);
		vi.mocked(SoundUtils.playSound).mockClear();
		Sound.setSelfDeafenedResolver(() => false);
		Sound.updateSettings({allSoundsDisabled: false});
		for (const type of TABLE_GAME_SOUND_TYPES) Sound.updateSettings({soundType: type, enabled: true});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('table-game policy group throttles bursts', () => {
		Sound.playSound(SoundType.TableGameTilePick);
		Sound.playSound(SoundType.TableGameTilePlace);
		Sound.playSound(SoundType.TableGameTileDrag);
		vi.advanceTimersByTime(59);
		expect(played()).toEqual([]);
		vi.advanceTimersByTime(1);
		// One group 'table-game': the burst plays once, the last request (equal priority) wins.
		expect(played()).toEqual([SoundType.TableGameTileDrag]);
		// The group cools down for 120 ms (the global one-shot floor of 260 ms is longer and applies too).
		Sound.playSound(SoundType.TableGameChessMove);
		vi.advanceTimersByTime(100);
		expect(played()).toHaveLength(1);
		vi.advanceTimersByTime(200);
		expect(played()).toEqual([SoundType.TableGameTileDrag, SoundType.TableGameChessMove]);
	});

	it('table sounds play at half the sound volume', () => {
		Sound.playSound(SoundType.TableGameChessMove);
		Sound.playSound(SoundType.Message);
		vi.advanceTimersByTime(1_000);
		const volumes = new Map(vi.mocked(SoundUtils.playSound).mock.calls.map(([type, , volume]) => [type, volume]));
		expect(volumes.get(SoundType.TableGameChessMove)).toBeCloseTo((volumes.get(SoundType.Message) ?? 0) * 0.5);
	});

	it('deafened suppresses table sounds', () => {
		Sound.setSelfDeafenedResolver(() => true);
		for (const type of TABLE_GAME_SOUND_TYPES) {
			Sound.playSound(type);
			vi.advanceTimersByTime(1_000);
		}
		expect(played()).toEqual([]);
	});

	it('allSoundsDisabled and per-type disable apply', () => {
		Sound.updateSettings({allSoundsDisabled: true});
		Sound.playSound(SoundType.TableGameYourTurn);
		vi.advanceTimersByTime(1_000);
		expect(played()).toEqual([]);

		Sound.updateSettings({allSoundsDisabled: false});
		Sound.updateSettings({soundType: SoundType.TableGameYourTurn, enabled: false});
		Sound.playSound(SoundType.TableGameYourTurn);
		vi.advanceTimersByTime(1_000);
		Sound.playSound(SoundType.TableGameWon);
		vi.advanceTimersByTime(1_000);
		expect(played()).toEqual([SoundType.TableGameWon]);
	});
});
