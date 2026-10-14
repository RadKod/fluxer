// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {z} from 'zod';

export const VoiceRoomConfigSchema = z.object({
	rooms_enabled: z.boolean().default(false).describe('Whether voice channels with a room theme open the 3D room view'),
	games_enabled: z.boolean().default(false).describe('Whether table games are playable; needs rooms_enabled'),
	room_cameras_enabled: z
		.boolean()
		.default(false)
		.describe('Whether cameras show on avatars inside the 3D room; needs rooms_enabled'),
	default_room_theme: z
		.enum(VOICE_ROOM_THEME_IDS)
		.nullable()
		.default(null)
		.describe('Default room theme for voice channels that inherit it; null disables the default'),
});

export type VoiceRoomConfig = z.infer<typeof VoiceRoomConfigSchema>;

export const DEFAULT_VOICE_ROOM_CONFIG: VoiceRoomConfig = VoiceRoomConfigSchema.parse({});

export const VoiceRoomConfigUpdateRequest = z
	.object({
		rooms_enabled: z.boolean(),
		games_enabled: z.boolean(),
		room_cameras_enabled: z.boolean(),
		default_room_theme: z.enum(VOICE_ROOM_THEME_IDS).nullable(),
	})
	.partial();

export type VoiceRoomConfigUpdateRequest = z.infer<typeof VoiceRoomConfigUpdateRequest>;

export const VoiceRoomConfigResponse = VoiceRoomConfigSchema;

export type VoiceRoomConfigResponse = z.infer<typeof VoiceRoomConfigResponse>;

export const VoiceRoomAssignmentResponse = z.object({
	rooms: z.boolean().describe('3D room view is available'),
	games: z.boolean().describe('Table games are available'),
	// Optional on the wire: a server that predates the field still parses; readers treat absent as false.
	cameras: z.boolean().optional().describe('Cameras on avatars inside the 3D room are available'),
	default_room_theme: z
		.string()
		.nullable()
		.optional()
		.describe('Default room theme for voice channels that inherit it; absent or null disables the default'),
});

export type VoiceRoomAssignmentResponse = z.infer<typeof VoiceRoomAssignmentResponse>;
export type VoiceRoomAssignment = Required<VoiceRoomAssignmentResponse>;

export const INERT_VOICE_ROOM_ASSIGNMENT = {
	rooms: false,
	games: false,
	cameras: false,
	default_room_theme: null,
} as const;

export function resolveVoiceRoomAssignment(config: VoiceRoomConfig): VoiceRoomAssignment {
	return {
		rooms: config.rooms_enabled,
		games: config.rooms_enabled && config.games_enabled,
		cameras: config.rooms_enabled && config.room_cameras_enabled,
		default_room_theme: config.default_room_theme,
	};
}
