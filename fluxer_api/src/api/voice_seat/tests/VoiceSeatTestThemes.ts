// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';
import type {VoiceRoomTheme} from '@fluxer/constants/src/VoiceRoomThemes';
import {afterAll, beforeAll} from 'vitest';

// Until the room manifest includes watch seats, these tests give the theme its own. The api test project
// shares modules between files (isolate: false), so the shipped list comes back after the file.
export function useThemeWatchSeats(theme: VoiceRoomTheme, seats: ReadonlyArray<string>): void {
	const entry = VOICE_ROOM_THEME_MANIFEST[theme] as {watch_seats: ReadonlyArray<string>};
	const shipped = entry.watch_seats;
	beforeAll(() => {
		entry.watch_seats = seats;
	});
	afterAll(() => {
		entry.watch_seats = shipped;
	});
}
