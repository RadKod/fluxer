// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, GuildSoundID, UserID} from '@app/api/BrandedTypes';
import type {GuildSoundRow} from '@app/api/database/types/GuildSoundTypes';

export class GuildSound {
	readonly guildId: GuildID;
	readonly soundId: GuildSoundID;
	readonly creatorId: UserID;
	readonly name: string;
	readonly assetHash: string;
	readonly extension: 'mp3' | 'ogg';
	readonly sizeBytes: number;
	readonly durationMs: number;
	readonly volume: number;
	readonly createdAt: Date;
	readonly version: number;

	constructor(row: GuildSoundRow) {
		this.guildId = row.guild_id;
		this.soundId = row.sound_id;
		this.creatorId = row.creator_id;
		this.name = row.name;
		this.assetHash = row.asset_hash;
		this.extension = row.extension;
		this.sizeBytes = row.size_bytes;
		this.durationMs = row.duration_ms;
		this.volume = row.volume;
		this.createdAt = row.created_at;
		this.version = row.version;
	}

	toRow(): GuildSoundRow {
		return {
			guild_id: this.guildId,
			sound_id: this.soundId,
			creator_id: this.creatorId,
			name: this.name,
			asset_hash: this.assetHash,
			extension: this.extension,
			size_bytes: this.sizeBytes,
			duration_ms: this.durationMs,
			volume: this.volume,
			created_at: this.createdAt,
			version: this.version,
		};
	}
}
