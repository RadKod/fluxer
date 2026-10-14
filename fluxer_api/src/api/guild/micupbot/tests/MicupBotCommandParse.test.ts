// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseMicupBotCommand} from '@app/api/guild/micupbot/MicupBotCommandParse';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {renderMicupBotTemplate} from '@app/api/guild/micupbot/MicupBotTemplate';
import {expect, it} from 'vitest';

const id = '1490000000000000001';
it('masked links in display names and community names are rendered as plain text', () => {
	expect(
		renderMicupBotTemplate('{user.name} {server}', {
			userId: id,
			userName: '[Ödül](https://x)',
			guildName: '[Ödül](https://x)',
		}),
	).toBe('\\[Ödül\\]\\(https://x\\) \\[Ödül\\]\\(https://x\\)');
});

it('users, channels, roles and durations in every accepted form', () => {
	for (const target of [id, `<@${id}>`, `<@!${id}>`]) {
		expect(parseMicupBotCommand(`#kick ${target} reason`)).toMatchObject({
			name: 'kick',
			userId: BigInt(id),
			reason: 'reason',
		});
	}
	for (const channel of [id, `<#${id}>`]) {
		expect(parseMicupBotCommand(`#lock ${channel}`)).toMatchObject({name: 'lock', channelId: BigInt(id)});
	}
	for (const role of [id, `<@&${id}>`, 'İZMİR Ekibi']) {
		expect(parseMicupBotCommand(`#role ${id} ${role}`)).toMatchObject({name: 'role', role});
	}
	for (const [unit, seconds] of [
		['s', 1],
		['sn', 1],
		['m', 60],
		['dk', 60],
		['h', 3600],
		['sa', 3600],
		['d', 86400],
		['g', 86400],
	] as const) {
		expect(parseMicupBotCommand(`#mute ${id} 2${unit}`)).toMatchObject({name: 'mute', duration: 2 * seconds});
	}
	for (const off of ['kapat', 'off', '0']) expect(parseMicupBotCommand(`#slowmode ${off}`)).toMatchObject({seconds: 0});
});

it('unknown words are usage errors', () => {
	for (const content of [
		'#unknown',
		'#ban',
		'#mute abc 10m',
		`#mute ${id} forever`,
		'#clear 101',
		'#clear 0',
		'#help extra',
		'#move 1',
		'#lock <@1>',
		'#role 1',
	]) {
		expect(() => parseMicupBotCommand(content)).toThrow(MICUPBOT_TEXT.usage('').split('`')[0]);
	}
});
