// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveEffectiveVoiceRoomTheme} from '@app/api/voice_seat/VoiceRoomTheme';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {describe, expect, it} from 'vitest';

const DEFAULT = VOICE_ROOM_THEME_IDS[0];
const EXPLICIT = VOICE_ROOM_THEME_IDS[1]!;

describe('effective voice room theme', () => {
	it('inherits only for a missing channel theme', () => {
		expect(resolveEffectiveVoiceRoomTheme(null, {default_room_theme: DEFAULT}, ChannelTypes.GUILD_VOICE)).toBe(DEFAULT);
		expect(resolveEffectiveVoiceRoomTheme(undefined, {default_room_theme: DEFAULT}, ChannelTypes.GUILD_VOICE)).toBe(
			DEFAULT,
		);
		expect(resolveEffectiveVoiceRoomTheme(null, {default_room_theme: null}, ChannelTypes.GUILD_VOICE)).toBeNull();
	});

	it.each([...Object.values(ChannelTypes).filter((type) => type !== ChannelTypes.GUILD_VOICE), 1000])(
		'channel type %s does not inherit the instance default',
		(channelType) => {
			expect(resolveEffectiveVoiceRoomTheme(null, {default_room_theme: DEFAULT}, channelType)).toBeNull();
			expect(resolveEffectiveVoiceRoomTheme(undefined, {default_room_theme: DEFAULT}, channelType)).toBeNull();
		},
	);

	it('explicit none stays flat despite the default', () => {
		for (const channelType of Object.values(ChannelTypes)) {
			expect(resolveEffectiveVoiceRoomTheme('none', {default_room_theme: DEFAULT}, channelType)).toBeNull();
		}
	});

	it('explicit theme overrides the default', () => {
		for (const channelType of Object.values(ChannelTypes)) {
			expect(resolveEffectiveVoiceRoomTheme(EXPLICIT, {default_room_theme: DEFAULT}, channelType)).toBe(EXPLICIT);
			expect(resolveEffectiveVoiceRoomTheme('unknown', {default_room_theme: DEFAULT}, channelType)).toBeNull();
		}
	});
});
