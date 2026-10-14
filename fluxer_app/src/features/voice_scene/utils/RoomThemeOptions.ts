// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const ROOM_THEME_LABEL_DESCRIPTOR = msg({
	message: 'Room theme',
	comment: 'Voice channel setting label for the 3D room the voice channel is shown as.',
});
const ROOM_THEME_DEFAULT_DESCRIPTOR = msg({
	message: 'Default ({themeName})',
	comment: 'Room theme option that inherits the current instance default; themeName is the theme name or Disabled.',
});
const ROOM_THEME_DISABLED_DESCRIPTOR = msg({
	message: 'Disabled',
	comment: 'Current instance default has no 3D room theme; used inside Default (Disabled).',
});
const ROOM_THEME_NONE_DESCRIPTOR = msg({
	message: 'None',
	comment: 'Room theme option: the voice channel is not shown as a 3D room.',
});
// Names of the room themes in the generated manifest (@fluxer/constants VoiceRoomThemeManifest).
const ROOM_THEME_NAME_DESCRIPTORS: Readonly<Record<string, MessageDescriptor>> = {
	'gece-lounge': msg({message: 'Night Lounge', comment: 'Name of a 3D voice room theme: a lounge at night.'}),
	kahvehane: msg({message: 'Coffeehouse', comment: 'Name of a 3D voice room theme: a Turkish coffeehouse.'}),
	'oyun-odasi': msg({message: 'Game Room', comment: 'Name of a 3D voice room theme: a game room.'}),
};

export function roomThemeOptions(i18n: I18n, defaultTheme: string | null | undefined) {
	const name = defaultTheme ? ROOM_THEME_NAME_DESCRIPTORS[defaultTheme] : null;
	const themeName = name ? i18n._(name) : i18n._(ROOM_THEME_DISABLED_DESCRIPTOR);
	return [
		{value: null, label: i18n._(ROOM_THEME_DEFAULT_DESCRIPTOR, {themeName})},
		{value: 'none', label: i18n._(ROOM_THEME_NONE_DESCRIPTOR)},
		...VOICE_ROOM_THEME_IDS.map((id) => {
			const descriptor = ROOM_THEME_NAME_DESCRIPTORS[id];
			return {value: id, label: descriptor ? i18n._(descriptor) : id};
		}),
	];
}
