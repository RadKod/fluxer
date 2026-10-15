// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Cassandra from '@app/api/database/CassandraQueryExecution';
import {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import {GUILD_ID, SOUND_ID, savedSound} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('Guild soundboard read consistency', () => {
	it('reads a playback sound with the default read consistency', async () => {
		const repository = new GuildSoundboardRepository();
		await repository.upsertSound(savedSound());
		const read = vi.spyOn(Cassandra, 'fetchMany');
		expect((await repository.getSound(GUILD_ID, SOUND_ID))?.soundId).toBe(SOUND_ID);
		expect(read).toHaveBeenCalledOnce();
		expect(read.mock.calls[0][2]).toBeUndefined();
	});
	it('retains all-replica reads for the guarded authoritative count', async () => {
		const read = vi.spyOn(Cassandra, 'fetchMany');
		await new GuildSoundboardRepository().listSounds(GUILD_ID, true);
		expect(read.mock.calls[0][2]).toEqual({consistency: 'all'});
	});
});
