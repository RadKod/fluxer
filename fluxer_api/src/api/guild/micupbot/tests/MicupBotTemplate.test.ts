// SPDX-License-Identifier: AGPL-3.0-or-later

import {renderMicupBotTemplate} from '@app/api/guild/micupbot/MicupBotTemplate';
import {expect, it} from 'vitest';

const vars = {userId: '123', userName: '*A*_~|`>@<', guildName: 'Guild'};
it('{user} becomes a mention and names are markdown escaped', () => {
	expect(
		renderMicupBotTemplate('{user} {user.name} {server} {user.id} {server.members} {level}', {
			...vars,
			memberCount: 12,
			level: 3,
		}),
	).toBe('<@123> \\*A\\*\\_\\~\\|\\`\\>\\@\\< Guild 123 12 3');
});
it('@everyone and @here in a name cannot ping', () => {
	const text = renderMicupBotTemplate('{user.name} {server}', {...vars, userName: '@everyone', guildName: '@here'});
	expect(text).not.toContain('@everyone');
	expect(text).not.toContain('@here');
});
it('unknown placeholders stay as written', () => {
	expect(renderMicupBotTemplate('{unknown} {constructor} {server.members} {level}', vars)).toBe(
		'{unknown} {constructor}  ',
	);
});
it('output is cut at 2000 characters', () => {
	expect(renderMicupBotTemplate('{server}'.repeat(1000), vars)).toHaveLength(2000);
});
