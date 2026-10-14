// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {currentAccountKey: 'account', userId: 'me'}}));

const {default: Users} = await import('@app/features/user/state/Users');
const wire = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	username: 'newname',
	discriminator: '0000',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	identity_version: '9007199254740993',
	...extra,
});

describe('username identity updates', () => {
	beforeEach(() => {
		Users.resetAccountState();
		Users.handleGatewayReady('account', wire('me', {email: 'me@example.test', username_state: 'selected'}) as never);
		Users.cacheUsers([wire('other')]);
	});
	for (const viaCache of [false, true]) {
		it(`keeps newer identity while merging old public fields through ${viaCache ? 'cacheUsers' : 'handleUserUpdate'}`, () => {
			const old = wire('other', {
				username: 'oldname',
				discriminator: '1234',
				identity_version: '9007199254740992',
				global_name: 'Updated',
			});
			if (viaCache) Users.cacheUsers([old]);
			else Users.handleUserUpdate(old);
			expect(Users.getUser('other')).toMatchObject({
				username: 'newname',
				discriminator: '0000',
				identityVersion: '9007199254740993',
				globalName: 'Updated',
			});
		});
		it(`ignores a public-only current user payload through ${viaCache ? 'cacheUsers' : 'handleUserUpdate'}`, () => {
			const update = wire('me', {username: 'stale', identity_version: '9007199254740994', global_name: 'Current'});
			if (viaCache) Users.cacheUsers([update]);
			else Users.handleUserUpdate(update);
			expect(Users.currentUser).toMatchObject({
				username: 'newname',
				globalName: null,
				usernameState: 'selected',
				email: 'me@example.test',
			});
		});
	}
	it('does not restore an older private selection state', () => {
		Users.handleUserUpdate(
			wire('me', {
				username: 'oldname',
				discriminator: '1234',
				identity_version: '1',
				username_state: 'legacy',
				email: 'me@example.test',
				bio: 'updated',
			}) as never,
		);
		expect(Users.currentUser).toMatchObject({username: 'newname', usernameState: 'selected', bio: 'updated'});
	});
	it('finds selected humans by bare or at-prefixed name but never by legacy zero tag', () => {
		expect(Users.getUserByTag('@NEWNAME')?.id).toBe('me');
		expect(Users.getUserByTag('newname')?.id).toBe('me');
		expect(Users.getUserByTag('newname#0000')).toBeUndefined();
	});
});
