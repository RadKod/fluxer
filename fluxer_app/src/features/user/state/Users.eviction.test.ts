// SPDX-License-Identifier: AGPL-3.0-or-later

import {autorun} from 'mobx';
import {beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {userId: 'me', currentUserId: 'me'},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: 'me'},
}));

const {default: Users} = await import('@app/features/user/state/Users');

function wireUser(id: string) {
	return {
		id,
		username: `user-${id}`,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	};
}

describe('Users retention', () => {
	beforeEach(() => {
		Users.handleGatewayReady('micup-test-account', {...wireUser('me')} as never);
		Users.cacheUsers(['a', 'b', 'c'].map(wireUser));
	});

	it('drops only candidates that no store retains and the caller does not keep', () => {
		Users.retainUsers(['a']);
		Users.evictUsers(['a', 'b', 'c'], new Set(['c']));
		expect(Users.getUser('a')).toBeDefined();
		expect(Users.getUser('b')).toBeUndefined();
		expect(Users.getUser('c')).toBeDefined();
		expect(Users.userCount).toBe(3);
		Users.releaseUsers(['a']);
	});

	it('keeps a user until every retain is released', () => {
		Users.retainUsers(['a']);
		Users.retainUsers(['a']);
		Users.releaseUsers(['a']);
		Users.evictUsers(['a'], new Set());
		expect(Users.getUser('a')).toBeDefined();
		Users.releaseUsers(['a']);
		Users.evictUsers(['a'], new Set());
		expect(Users.getUser('a')).toBeUndefined();
	});

	it('never lets an extra release free a user that is retained again', () => {
		Users.releaseUsers(['a']);
		Users.retainUsers(['a']);
		Users.evictUsers(['a'], new Set());
		expect(Users.getUser('a')).toBeDefined();
		Users.releaseUsers(['a']);
	});

	it('never evicts the current user', () => {
		Users.evictUsers(['me'], new Set());
		expect(Users.currentUser?.id).toBe('me');
	});

	it('keeps users that something on screen is still reading', () => {
		const stopRendering = autorun(() => Users.getUser('b')?.username);
		Users.evictUsers(['b'], new Set());
		expect(Users.getUser('b')).toBeDefined();
		stopRendering();
		Users.evictUsers(['b'], new Set());
		expect(Users.getUser('b')).toBeUndefined();
	});

	it('still evicts while something observes the whole users list', () => {
		onTestFinished(autorun(() => Users.usersList.length));
		Users.evictUsers(['a', 'b', 'c'], new Set());
		expect(Users.getUser('a')).toBeUndefined();
		expect(Users.getUser('b')).toBeUndefined();
		expect(Users.getUser('c')).toBeUndefined();
		expect(Users.userCount).toBe(1);
	});

	it.each([
		['voice call layout', (onScreenId: string) => Users.userCount + Number(Boolean(Users.getUser(onScreenId)))],
		['collapsed voice category', (onScreenId: string) => [Users.userCount, Users.getUser(onScreenId)]],
		['upstream users list pattern', (onScreenId: string) => [Users.usersList.length, Users.getUser(onScreenId)]],
	])('keeps only the user a %s actually renders', (_view, render) => {
		onTestFinished(autorun(() => render('a')));
		Users.evictUsers(['a', 'b', 'c'], new Set());
		expect(Users.getUser('a')).toBeDefined();
		expect(Users.getUser('b')).toBeUndefined();
		expect(Users.getUser('c')).toBeUndefined();
		expect(Users.userCount).toBe(2);
	});

	it('leaves users that were not offered as candidates alone', () => {
		Users.evictUsers(['b'], new Set());
		expect(Users.getUser('a')).toBeDefined();
		expect(Users.getUser('c')).toBeDefined();
	});
});
