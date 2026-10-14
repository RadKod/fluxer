// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {
	MicupBotAutomodUpdateRequest as automod,
	MicupBotLeaderboardQuery as leaderboard,
	MicupBotReactionRolePanelCreateRequest as panel,
	MicupBotLevelRewardsUpdateRequest as rewards,
	MicupBotAutomodRuleRequest as rule,
	MicupBotSettingsUpdateRequest as settings,
} from './MicupBotRequestSchemas';

const id = '1490000000000000001';
const entry = (n: number) => ({emoji: {name: `emoji${n}`}, role_id: (BigInt(id) + BigInt(n)).toString()});
describe('MicupBotSchemas', () => {
	it('settings update needs at least one field', () => {
		expect(settings.safeParse({}).success).toBe(false);
		expect(settings.safeParse({unknown: true}).success).toBe(false);
		expect(settings.safeParse({commands_enabled: false}).success).toBe(true);
	});
	it('templates are 1..1000 characters or null', () => {
		for (const field of ['welcome_message', 'goodbye_message', 'level_up_message']) {
			for (const value of [null, 'a', 'a'.repeat(1000)])
				expect(settings.safeParse({[field]: value}).success).toBe(true);
			for (const value of ['', 'a'.repeat(1001)]) expect(settings.safeParse({[field]: value}).success).toBe(false);
		}
	});
	it('autorole_ids holds at most 5 distinct roles', () => {
		const ids = Array.from({length: 6}, (_, n) => entry(n).role_id);
		expect(settings.safeParse({autorole_ids: ids.slice(0, 5)}).success).toBe(true);
		expect(settings.safeParse({autorole_ids: ids}).success).toBe(false);
		expect(settings.safeParse({autorole_ids: [id, id]}).success).toBe(false);
	});
	it("automod thresholds stay in their rule's range", () => {
		for (const [name, min, max] of [
			['spam', 3, 20],
			['mentions', 3, 50],
			['caps', 50, 100],
		] as const) {
			for (const threshold of [min, max])
				expect(rule.safeParse({rule: name, enabled: true, threshold}).success).toBe(true);
			for (const threshold of [min - 1, max + 1])
				expect(rule.safeParse({rule: name, enabled: true, threshold}).success).toBe(false);
		}
		expect(rule.safeParse({rule: 'links', enabled: true, threshold: 1}).success).toBe(false);
		expect(
			automod.safeParse({
				rules: [
					{rule: 'links', enabled: true, threshold: 0},
					{rule: 'links', enabled: false, threshold: 0},
				],
			}).success,
		).toBe(false);
	});
	it('words are 3..64 characters and at most 200', () => {
		const parse = (words: Array<string>) => rule.safeParse({rule: 'words', enabled: true, threshold: 0, words}).success;
		expect(parse(['abc', 'a'.repeat(64)])).toBe(true);
		expect(parse(['ab'])).toBe(false);
		expect(parse(['a'.repeat(65)])).toBe(false);
		expect(parse(Array(200).fill('abc'))).toBe(true);
		expect(parse(Array(201).fill('abc'))).toBe(false);
		expect(parse(['göt*', '*göt', '*göt*'])).toBe(true);
		for (const word of ['*ab', 'ab*', '*ab*', '**abc', 'abc**', 'a*bc']) expect(parse([word]), word).toBe(false);
	});
	it('a panel has 1..20 entries with distinct emojis and roles', () => {
		const parse = (entries: Array<ReturnType<typeof entry>>) =>
			panel.safeParse({channel_id: id, title: 'Roles', entries}).success;
		expect(parse([entry(0)])).toBe(true);
		expect(parse(Array.from({length: 20}, (_, n) => entry(n)))).toBe(true);
		expect(parse([])).toBe(false);
		expect(parse(Array.from({length: 21}, (_, n) => entry(n)))).toBe(false);
		expect(parse([entry(0), {...entry(1), emoji: entry(0).emoji}])).toBe(false);
		expect(parse([entry(0), {...entry(1), role_id: id}])).toBe(false);
	});
	it('level rewards hold at most 25 distinct levels in 1..500', () => {
		const parse = (levels: Array<number>) =>
			rewards.safeParse({rewards: levels.map((level) => ({level, role_id: id}))}).success;
		expect(parse([1, 500])).toBe(true);
		for (const levels of [[0], [501], [1, 1], Array.from({length: 26}, (_, n) => n + 1)])
			expect(parse(levels)).toBe(false);
	});
	it('leaderboard offset stays in 0..900', () => {
		expect(leaderboard.parse({})).toEqual({offset: 0, limit: 100});
		for (const offset of ['0', '900']) expect(leaderboard.safeParse({offset}).success).toBe(true);
		for (const offset of [-1, 901, 1.5]) expect(leaderboard.safeParse({offset}).success).toBe(false);
	});
});
