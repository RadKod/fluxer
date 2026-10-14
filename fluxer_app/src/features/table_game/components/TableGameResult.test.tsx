// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testPlayer, testSummary} from '@app/features/table_game/state/TableGameTestViews';
import type {TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));

const {TableGameResult} = await import('@app/features/table_game/components/TableGameResult');

const CHANNEL = {id: '500', guildId: '9'} as never;
let root: Root | null = null;
let host: HTMLDivElement;

async function render(game: TableGameSummary['game'], result: TableGameSummary['result']): Promise<string> {
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	const summary = testSummary({game, status: 'ended', players: [testPlayer(1), testPlayer(3)], result});
	await act(async () => root!.render(createElement(TableGameResult, {channel: CHANNEL, summary})));
	return host.querySelector('[data-result]')?.textContent ?? '';
}

afterEach(() => {
	act(() => root?.unmount());
	host.remove();
});

describe('TableGameResult', () => {
	it('dama and tavla results name the winner and say why', async () => {
		const cases: Array<[TableGameSummary['game'], NonNullable<TableGameSummary['result']>, string]> = [
			['tavla', {kind: 'win', winners: [1], reason: 'bear_off', finish: 'normal'}, 'All checkers borne off'],
			['tavla', {kind: 'win', winners: [3], reason: 'bear_off', finish: 'mars'}, 'Gammon'],
			['dama', {kind: 'win', winners: [1], reason: 'no_pieces'}, 'No pieces left'],
			['dama_normal', {kind: 'win', winners: [3], reason: 'blocked'}, 'No moves left'],
			['dama', {kind: 'draw', reason: 'move_limit'}, '25 moves without progress'],
			['dama', {kind: 'draw', reason: 'lone_kings'}, 'One king each'],
		];
		for (const [game, result, detail] of cases) {
			const text = await render(game, result);
			if (result.kind === 'win') expect(text).toContain(`user${99 + result.winners[0]!} won`);
			else expect(text).toContain('Draw');
			expect(text).toContain(detail);
			act(() => root!.unmount());
			host.remove();
		}
		expect(await render('dama', {kind: 'win', winners: [3], reason: 'timeout'})).toContain('On time');
	});
});
