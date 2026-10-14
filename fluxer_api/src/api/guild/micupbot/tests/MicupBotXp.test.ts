// SPDX-License-Identifier: AGPL-3.0-or-later

import {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {levelFromXp, rollMessageXp, totalXpForLevel, xpToNextLevel} from '@app/api/guild/micupbot/MicupBotXp';
import {createMicupBotXpCounterFlusher} from '@app/api/guild/micupbot/MicupBotXpCounters';
import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => vi.restoreAllMocks());
it('level 0 needs 100 xp, level 1 needs 155', () => {
	expect(xpToNextLevel(0)).toBe(100);
	expect(xpToNextLevel(1)).toBe(155);
});
it('levelFromXp inverts totalXpForLevel', () => {
	for (let level = 0; level <= 500; level++) {
		expect(levelFromXp(totalXpForLevel(level))).toEqual({level, current: 0, next: xpToNextLevel(level)});
		expect(levelFromXp(totalXpForLevel(level + 1) - 1)).toEqual({
			level,
			current: xpToNextLevel(level) - 1,
			next: xpToNextLevel(level),
		});
	}
});
it('message xp stays in 15..25', () => {
	expect(rollMessageXp(() => 0)).toBe(15);
	expect(rollMessageXp(() => 0.999999)).toBe(25);
	for (let i = 0; i < 100; i++) expect(rollMessageXp(() => i / 100)).toBeGreaterThanOrEqual(15);
});
it('seeding an xp counter never writes the user guild index', async () => {
	const repository = new MicupBotRepository();
	const read = vi.spyOn(repository, 'getMemberXp').mockResolvedValue(null);
	const write = vi.spyOn(repository, 'addUserGuild');
	const flusher = createMicupBotXpCounterFlusher(repository);
	expect(await flusher.readBase('1:2')).toBe(0);
	expect(await flusher.recount('1:2')).toBe(0);
	expect(read).toHaveBeenCalledTimes(2);
	expect(write).not.toHaveBeenCalled();
});
