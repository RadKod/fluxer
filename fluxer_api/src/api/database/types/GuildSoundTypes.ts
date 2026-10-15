// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, GuildSoundID, UserID} from '@app/api/BrandedTypes';

export interface GuildSoundRow {
	guild_id: GuildID;
	sound_id: GuildSoundID;
	creator_id: UserID;
	name: string;
	asset_hash: string;
	extension: 'mp3' | 'ogg';
	size_bytes: number;
	duration_ms: number;
	volume: number;
	created_at: Date;
	version: number;
}

export const GUILD_SOUND_COLUMNS = [
	'guild_id',
	'sound_id',
	'creator_id',
	'name',
	'asset_hash',
	'extension',
	'size_bytes',
	'duration_ms',
	'volume',
	'created_at',
	'version',
] as const satisfies ReadonlyArray<keyof GuildSoundRow>;
