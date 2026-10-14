// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {micupBotLevelBucket, micupBotSlotOf, micupBotXpCounterId} from '@app/api/database/types/MicupBotTypes';
import {expect, it} from 'vitest';

it('slot and bucket use the snowflake time bits', () => {
	for (const sequence of [0n, 1n, 4095n]) {
		expect(micupBotSlotOf(createGuildID((4101n << 22n) + sequence))).toBe(5);
		expect(micupBotLevelBucket(createUserID((19n << 22n) + sequence))).toBe(3);
	}
});
it('xp counter id joins guild and user', () => {
	expect(micupBotXpCounterId(createGuildID(1n), createUserID(2n))).toBe('1:2');
});
