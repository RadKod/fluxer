// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {Guild} from '@app/features/guild/models/Guild';
import type {User} from '@app/features/user/models/User';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {userId: 'me', currentUserId: 'me'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: 'me'},
}));
vi.mock('@app/features/voice/engine/v2/VoiceEngineV2AppVoiceStateAdapter', () => ({
	useVoiceGatewayStateVersion: () => 0,
}));
vi.mock('@app/features/voice/components/VoiceParticipantSortUtils', () => ({
	createVoiceParticipantSortSnapshot: () => ({}),
	sortVoiceParticipantItemsWithSnapshot: (userIds: Array<string>) => userIds,
}));
const CHANNEL_STATES = {'conn-a': {user_id: 'a', connection_id: 'conn-a'}};
const ALL_VOICE_STATES = {g: {c: CHANNEL_STATES}};
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		getAllVoiceStates: () => ALL_VOICE_STATES,
		getAllVoiceStatesInChannel: () => CHANNEL_STATES,
	},
}));
vi.mock('@app/features/ui/avatars/StackUserAvatar', () => ({StackUserAvatar: () => null}));
// AvatarStack takes the tooltip name and the profile popout user from the users prop, not from the store.
vi.mock('@app/features/ui/avatars/AvatarStack', async () => {
	const {createElement: h} = await import('react');
	return {
		AvatarStack: ({users}: {users: ReadonlyArray<User>}) =>
			h(
				'ul',
				null,
				users.map((user) => h('li', {key: user.id}, `${user.username}:${user.avatar}`)),
			),
	};
});

const {default: Users} = await import('@app/features/user/state/Users');
const {CollapsedCategoryVoiceParticipants, CollapsedChannelAvatarStack} = await import(
	'@app/features/app/components/layout/CollapsedCategoryVoiceParticipants'
);

function wireUser(id: string, avatar: string | null) {
	return {id, username: `user-${id}`, discriminator: '0001', global_name: null, avatar, avatar_color: null, flags: 0};
}

const guild = {id: 'g'} as Guild;
const channel = {id: 'c'} as Channel;

describe('collapsed voice avatar stacks', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Users.handleGatewayReady('micup-test-account', wireUser('me', null) as never);
		Users.cacheUsers([wireUser('a', 'oldhash')]);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it.each([
		['a collapsed channel', () => createElement(CollapsedChannelAvatarStack, {guild, channel})],
		[
			'a collapsed category',
			() => createElement(CollapsedCategoryVoiceParticipants, {guild, voiceChannels: [channel]}),
		],
	])('hands %s the updated user after an avatar and name change', (_name, render) => {
		act(() => root.render(render()));
		expect(container.textContent).toBe('user-a:oldhash');

		act(() => Users.handleUserUpdate({...wireUser('a', 'newhash'), username: 'renamed'}));
		expect(container.textContent).toBe('renamed:newhash');

		act(() => Users.handleUserUpdate(wireUser('a', null)));
		expect(container.textContent).toBe('user-a:null');
	});

	it('keeps the shown user cached without pinning users that are not in voice', () => {
		Users.cacheUsers([wireUser('b', null)]);
		act(() => root.render(createElement(CollapsedChannelAvatarStack, {guild, channel})));

		Users.evictUsers(['a', 'b'], new Set());

		expect(Users.getUser('a')).toBeDefined();
		expect(Users.getUser('b')).toBeUndefined();
	});
});
