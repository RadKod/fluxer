// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {ROSTER_TEXT} from '@app/api/guild/roster/GuildRosterConstants';
import {
	buildMoveWarning,
	buildRosterEmbed,
	rosterComponents,
	splitRoster,
} from '@app/api/guild/roster/GuildRosterEmbed';
import {ANNOUNCE_AT, START, USER_A, USER_B, USER_C} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {describe, expect, it} from 'vitest';

const input = {
	name: 'izmir ışık',
	startSeconds: START,
	announcedAt: ANNOUNCE_AT,
	main: [USER_A],
	subs: [USER_B],
	mainSize: 2,
	subSize: 2,
	closed: false,
};
describe('GuildRosterEmbed', () => {
	it('open embed lists main then subs with numbered slots and dashes', () => {
		const embed = buildRosterEmbed(input);
		expect(embed.description).toBe(
			[
				ROSTER_TEXT.startsAt(START),
				ROSTER_TEXT.howTo,
				'',
				ROSTER_TEXT.mainHeader(1, 2),
				ROSTER_TEXT.slot(1, '101'),
				ROSTER_TEXT.slot(2, null),
				'',
				ROSTER_TEXT.subHeader(1, 2),
				ROSTER_TEXT.slot(1, '102'),
				ROSTER_TEXT.slot(2, null),
			].join('\n'),
		);
	});
	it('title keeps the name as written', () => {
		expect(buildRosterEmbed(input).title).toBe('🚀 izmir ışık İÇİN KATIL');
	});
	it('start line uses <t:S:t> and <t:S:R> of :35', () => {
		expect(new Date(START * 1000).getUTCMinutes()).toBe(35);
		expect(buildRosterEmbed(input).description).toContain(`<t:${START}:t> · <t:${START}:R>`);
		expect(buildRosterEmbed(input).timestamp).toEqual(new Date(ANNOUNCE_AT));
	});
	it('closed embed says the event is no longer active with the event time and the final lists', () => {
		const embed = buildRosterEmbed({...input, closed: true});
		expect(embed.description).toContain(ROSTER_TEXT.closed);
		expect(embed.description).toContain(ROSTER_TEXT.closedAt(START));
		expect(embed.description).toContain('<@101>');
		expect(embed.description).toContain('<@102>');
		expect(embed.description).not.toContain(ROSTER_TEXT.howTo);
	});
	it('sub section is left out when sub_size is 0', () => {
		expect(buildRosterEmbed({...input, subSize: 0, subs: []}).description).not.toContain('Yedek');
	});
	it('50 + 25 slots stay under 4096 characters', () => {
		const members = Array.from({length: 75}, (_, i) => createUserID(9999999999999999900n + BigInt(i)));
		expect(
			buildRosterEmbed({...input, ...splitRoster(members, 50, 25), mainSize: 50, subSize: 25}).description!.length,
		).toBeLessThan(4096);
	});
	it('splitRoster puts the first N in main, the next M in subs and drops the rest', () => {
		expect(splitRoster([USER_A, USER_B, USER_C], 1, 1)).toEqual({main: [USER_A], subs: [USER_B]});
	});
	it('every render keeps the buttons and a closed card disables both', () => {
		const join = {type: 2, style: 3, label: 'Katıl', emoji_name: '✅', emoji_id: null, emoji_animated: null};
		const leave = {type: 2, style: 2, label: 'Ayrıl', emoji_name: null, emoji_id: null, emoji_animated: null};
		expect(rosterComponents(false)).toEqual([
			{
				type: 1,
				components: [
					{...join, custom_id: 'roster:join', disabled: false},
					{...leave, custom_id: 'roster:leave', disabled: false},
				],
			},
		]);
		expect(rosterComponents(true)[0]!.components!.map((b) => b.disabled)).toEqual([true, true]);
	});
	it('howTo names both the buttons and the reaction', () => {
		expect(ROSTER_TEXT.howTo).toBe(
			'**Katıl** düğmesiyle ya da ✅ tepkisiyle katıl; **Ayrıl** düğmesiyle ya da tepkini geri alarak ayrıl.',
		);
	});
	it('move warning mentions nobody', () => {
		const warning = buildMoveWarning('*raid* <@123> @everyone', 2);
		expect(warning.allowed_mentions).toEqual({parse: []});
		expect(warning.content).toBe(ROSTER_TEXT.moveWarning('\\*raid\\* \\<\\@123\\> \\@everyone', 2));
	});
});
