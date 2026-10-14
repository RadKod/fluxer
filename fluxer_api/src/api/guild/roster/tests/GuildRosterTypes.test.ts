// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createMessageID} from '@app/api/BrandedTypes';
import {
	ROSTER_SLOT_COUNT,
	rosterHourOf,
	rosterKeys,
	rosterSlotOf,
	rosterStartSeconds,
} from '@app/api/database/types/GuildRosterTypes';
import {describe, expect, it} from 'vitest';

describe('Guild roster types', () => {
	it('rosterSlotOf stays in 0..4095 and spreads consecutive snowflakes', () => {
		const slots = Array.from({length: 4096}, (_, i) => rosterSlotOf(createGuildID((100000n + BigInt(i)) << 22n)));
		expect(ROSTER_SLOT_COUNT).toBe(4096);
		expect(new Set(slots).size).toBe(4096);
		expect(Math.min(...slots)).toBe(0);
		expect(Math.max(...slots)).toBe(4095);
	});
	it('rosterSlotOf is stable for a guild', () => {
		const guildId = createGuildID(1490000000000000001n);
		expect(rosterSlotOf(guildId)).toBe(Number((guildId >> 22n) % 4096n));
		expect(rosterSlotOf(guildId)).toBe(rosterSlotOf(guildId));
	});
	it('rosterStartSeconds is :35 of the hour', () => {
		const start = Date.parse('2026-10-02T10:00:00Z');
		expect(rosterHourOf(start + 3_599_999)).toBe(rosterHourOf(start));
		expect(rosterHourOf(start + 3_600_000)).toBe(rosterHourOf(start) + 1);
		expect(rosterStartSeconds(rosterHourOf(start))).toBe(Date.parse('2026-10-02T10:35:00Z') / 1000);
	});
	it('keys carry the event and the hour', () => {
		expect(rosterKeys.members(12n, 34)).toBe('roster:z:12:34');
		expect(rosterKeys.state(12n, 34)).toBe('roster:s:12:34');
		expect(rosterKeys.message(createMessageID(56n))).toBe('roster:m:56');
		expect(rosterKeys.announce(12n, 34)).toBe('roster:o:12:34:announce');
		expect(rosterKeys.warn(12n, 34)).toBe('roster:o:12:34:warn');
		expect(rosterKeys.check(12n, 34)).toBe('roster:l:12:34:check');
	});
});
