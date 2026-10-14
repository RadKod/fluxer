// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs';
import {resolveAssetPath} from '@app/api/utils/AssetPaths';
import {generateConnectionId} from '@app/api/words/Words';
import {
	GuildMemberUpdateRequest,
	MyGuildMemberUpdateRequest,
} from '@fluxer/schema/src/domains/guild/GuildRequestSchemas';
import {describe, expect, it} from 'vitest';

function longestWord(file: string): string {
	return fs
		.readFileSync(resolveAssetPath('words', file), 'utf-8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.reduce((longest, word) => (word.length > longest.length ? word : longest), '');
}

describe('generateConnectionId', () => {
	it('keeps the readable word pair and ends in 32 random bits', () => {
		expect(generateConnectionId()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
	});

	// A guild's voice server and a gateway node's voice count table key connections by this
	// id alone, so ids live at the same time must not repeat. The word pair alone has
	// 381,276 values: 20,000 ids would repeat about 520 times.
	it('does not repeat across 20,000 ids', () => {
		const ids = new Set(Array.from({length: 20000}, () => generateConnectionId()));
		expect(ids.size).toBe(20000);
	});

	// Moderators move and disconnect a connection by sending its id back in PATCH
	// /guilds/:id/members/:user and /members/@me.
	it('the longest id it can generate passes the guild member update schemas', () => {
		const longest = `${longestWord('tails.txt')}-${longestWord('scales.txt')}-ffffffff`;
		expect(GuildMemberUpdateRequest.safeParse({connection_id: longest}).success).toBe(true);
		expect(MyGuildMemberUpdateRequest.safeParse({connection_id: longest}).success).toBe(true);
	});
});
