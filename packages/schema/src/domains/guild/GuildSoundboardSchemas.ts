// SPDX-License-Identifier: AGPL-3.0-or-later

import {SOUNDBOARD_MAX_DURATION_MS, SOUNDBOARD_MAX_SIZE_BYTES} from '@fluxer/constants/src/SoundboardConstants';
import {isValidBase64} from '@fluxer/schema/src/primitives/FileValidators';
import {createStringType, SnowflakeStringType, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const name = createStringType(1, 32);
const volume = z.number().min(0).max(1);
export const GuildSoundboardUploadRequest = z.object({
	name,
	audio: z
		.string()
		.min(1)
		.max(4 * Math.ceil(SOUNDBOARD_MAX_SIZE_BYTES / 3))
		.refine(isValidBase64, 'Invalid base64 audio'),
	volume: volume.optional(),
});
export const GuildSoundboardUpdateRequest = z
	.object({name: name.optional(), volume: volume.optional()})
	.refine((value) => value.name !== undefined || value.volume !== undefined, 'Provide a name or volume');
export const GuildSoundboardPlayRequest = z.object({
	session_id: z.string().min(1).max(128),
	connection_id: z.string().min(1).max(128),
});
export const GuildSoundboardGuildParam = z.object({guild_id: SnowflakeType});
export const GuildSoundboardSoundParam = z.object({guild_id: SnowflakeType, sound_id: SnowflakeType});
export const GuildSoundboardPlayParam = z.object({channel_id: SnowflakeType, sound_id: SnowflakeType});
export const GuildSoundboardSoundResponse = z.object({
	id: SnowflakeStringType,
	guild_id: SnowflakeStringType,
	creator_id: SnowflakeStringType,
	name: z.string(),
	asset_hash: z.string().regex(/^[a-f0-9]{64}$/),
	extension: z.enum(['mp3', 'ogg']),
	size_bytes: z.number().int().positive().max(SOUNDBOARD_MAX_SIZE_BYTES),
	duration_ms: z.number().int().positive().max(SOUNDBOARD_MAX_DURATION_MS),
	volume,
	created_at: z.iso.datetime(),
	version: z.number().int().positive(),
	url: z.url(),
});
export const GuildSoundboardListResponse = z.object({sounds: z.array(GuildSoundboardSoundResponse)});
export type GuildSoundboardSoundResponse = z.infer<typeof GuildSoundboardSoundResponse>;
export type GuildSoundboardUploadRequest = z.infer<typeof GuildSoundboardUploadRequest>;
export type GuildSoundboardUpdateRequest = z.infer<typeof GuildSoundboardUpdateRequest>;
export type GuildSoundboardPlayRequest = z.infer<typeof GuildSoundboardPlayRequest>;
