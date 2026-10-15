// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, GuildSoundID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, fetchMany, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {GuildSoundRow} from '@app/api/database/types/GuildSoundTypes';
import {GuildSound} from '@app/api/models/GuildSound';
import {GuildSounds} from '@app/api/Tables';

const LIST_SOUNDS = GuildSounds.select({where: GuildSounds.where.eq('guild_id')});
const FETCH_SOUND = GuildSounds.select({
	where: [GuildSounds.where.eq('guild_id'), GuildSounds.where.eq('sound_id')],
	limit: 1,
});

export class GuildSoundboardRepository {
	async listSounds(guildId: GuildID, authoritative = false): Promise<Array<GuildSound>> {
		const rows = await fetchMany<GuildSoundRow>(
			LIST_SOUNDS.bind({guild_id: guildId}),
			undefined,
			authoritative ? {consistency: 'all'} : undefined,
		);
		return rows.map((row) => new GuildSound(row));
	}
	async getSound(guildId: GuildID, soundId: GuildSoundID): Promise<GuildSound | null> {
		const [row] = await fetchMany<GuildSoundRow>(FETCH_SOUND.bind({guild_id: guildId, sound_id: soundId}));
		return row ? new GuildSound(row) : null;
	}
	async upsertSound(sound: GuildSound): Promise<void> {
		await upsertOne(GuildSounds.upsertAll(sound.toRow()));
	}
	async deleteSound(guildId: GuildID, soundId: GuildSoundID): Promise<void> {
		await deleteOneOrMany(GuildSounds.deleteByPk({guild_id: guildId, sound_id: soundId}));
	}
}
