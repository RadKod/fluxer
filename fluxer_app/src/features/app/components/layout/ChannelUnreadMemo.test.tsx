// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import * as Unread from '@app/features/app/components/layout/utils/ChannelUnreadState';
import {parse} from '@babel/parser';
import {transformSync} from 'esbuild';
import {act, createElement, useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, test, vi} from 'vitest';

// Mount the production row's unread expression without its menus, DnD, and navigation dependencies.
function unreadRow(path: string) {
	const source = readFileSync(new URL(path, import.meta.url), 'utf8');
	const ast = parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx']});
	let expression = '';
	function visit(node: unknown): void {
		if (!node || typeof node !== 'object') return;
		const value = node as {type?: string; id?: {name?: string}; init?: {start: number; end: number}};
		if (value.type === 'VariableDeclarator' && value.id?.name === 'unreadState' && value.init) {
			expression = source.slice(value.init.start, value.init.end);
			return;
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}
	visit(ast.program);
	if (!expression) throw new Error(`Unread expression not found in ${path}`);
	const calculate = vi.fn(
		path.includes('GuildListDMItem') ? Unread.getDMListItemUnreadState : Unread.getChannelUnreadState,
	);
	const Row = new Function(
		'useMemo',
		'getChannelUnreadState',
		'getDMListItemUnreadState',
		transformSync(
			`
		return function Row({input, report}) {
			const {hasUnread, unreadCount, mentionCount, isMuted, showFadedUnreadOnMutedChannels, unreadBadgesLevel} = input;
			const isChannelDirectlyMuted = isMuted;
			const Accessibility = {showFadedUnreadOnMutedChannels};
			const channel = {id: 'channel'};
			const ReadStates = {hasUnread: () => hasUnread, getUnreadCount: () => unreadCount};
			report(${expression});
			return null;
		};`,
			{loader: 'ts'},
		).code,
	)(useMemo, calculate, calculate);
	return {Row, calculate};
}

const initial: Unread.ChannelUnreadStateInput = {
	hasUnread: true,
	unreadCount: 1,
	mentionCount: 0,
	isMuted: false,
	showFadedUnreadOnMutedChannels: false,
	unreadBadgesLevel: null,
};

test.each([
	'./ChannelItem.tsx',
	'./FavoritesChannelListContent.tsx',
	'./sidebar_nav/GuildListDMItem.tsx',
	'../../../channel/components/direct_message/DMListItem.tsx',
])('%s reuses unread state for equal inputs and recomputes for each changed input', (path) => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const {Row, calculate} = unreadRow(path);
	const root = createRoot(document.createElement('div'));
	let state: Unread.ChannelUnreadState | undefined;
	const report = (value: Unread.ChannelUnreadState) => {
		state = value;
	};
	try {
		act(() => root.render(createElement(Row, {input: {...initial}, report})));
		expect(calculate).toHaveBeenCalledTimes(1);
		act(() => root.render(createElement(Row, {input: {...initial}, report})));
		expect(calculate).toHaveBeenCalledTimes(1);
		const changed: Unread.ChannelUnreadStateInput = {...initial};
		const changes: Array<Partial<Unread.ChannelUnreadStateInput>> = [
			{hasUnread: false},
			{unreadCount: 2},
			{mentionCount: 1},
			{isMuted: true},
			{showFadedUnreadOnMutedChannels: true},
		];
		if (!path.includes('DM')) changes.push({unreadBadgesLevel: 1});
		for (const change of changes) {
			Object.assign(changed, change);
			const before = calculate.mock.calls.length;
			act(() => root.render(createElement(Row, {input: {...changed}, report})));
			expect(calculate).toHaveBeenCalledTimes(before + 1);
			expect(state).toEqual(Unread.getChannelUnreadState(changed));
		}
	} finally {
		act(() => root.unmount());
	}
});

test('DM sidebar row and layout resolver share one pure unread input helper', () => {
	const path = './sidebar_nav/GuildListDMItem.tsx';
	const source = readFileSync(new URL(path, import.meta.url), 'utf8');
	const ast = parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx']});
	const resolver = ast.program.body.find(
		(node) =>
			node.type === 'ExportNamedDeclaration' &&
			node.declaration?.type === 'FunctionDeclaration' &&
			node.declaration.id?.name === 'resolveDMListItemUnreadState',
	);
	expect(resolver).toBeDefined();
	const resolverSource = source.slice(resolver!.start!, resolver!.end!);
	expect(resolverSource).toContain('getDMListItemUnreadState(');
	expect(source.split('getDMListItemUnreadState(')).toHaveLength(3);
});
