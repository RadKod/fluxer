// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User as WireUser} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key}: {key: string}) =>
			({max_following: 11, max_feed_posts_per_day: 12, max_boost_slots: 13})[key] ?? -1,
	},
}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));

const {User} = await import('@app/features/user/models/User');

const FRAME = {asset: 'frame-hash', item_id: '101'};
const ULTRA = {asset: 'ultra-hash', item_id: '303'};
const PLATE = {asset: 'plate-hash', item_id: '202'};

function wireUser(extra: Partial<WireUser> = {}): WireUser {
	return {
		id: '1',
		username: 'ayse',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
		...extra,
	};
}

describe('User cosmetics', () => {
	it('reads null when the server sends no cosmetics', () => {
		const user = new User(wireUser());
		expect(user.avatarDecoration).toBeNull();
		expect(user.nameplate).toBeNull();
	});

	it('keeps worn cosmetics through an update that does not mention them', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME, nameplate_data: PLATE}));
		const updated = user.withUpdates({global_name: 'Ayşe'});
		expect(updated.avatarDecoration).toEqual(FRAME);
		expect(updated.nameplate).toEqual(PLATE);
		expect(updated.globalName).toBe('Ayşe');
	});

	it('takes cosmetics off when the update sends null', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME, nameplate_data: PLATE}));
		const updated = user.withUpdates({avatar_decoration_data: null, nameplate_data: null});
		expect(updated.avatarDecoration).toBeNull();
		expect(updated.nameplate).toBeNull();
	});

	it('clears cosmetics an authoritative payload leaves out', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME, nameplate_data: PLATE}));
		const updated = user.withUpdates({}, {clearMissingOptionalFields: true});
		expect(updated.avatarDecoration).toBeNull();
		expect(updated.nameplate).toBeNull();
	});

	it('counts a different cosmetic as a change and the same one as none', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME}));
		expect(user.equals(user.withUpdates({avatar_decoration_data: {...FRAME}}))).toBe(true);
		expect(user.equals(user.withUpdates({avatar_decoration_data: {...FRAME, item_id: '102'}}))).toBe(false);
		expect(user.equals(user.withUpdates({nameplate_data: PLATE}))).toBe(false);
	});

	it('writes worn cosmetics back to the wire shape', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME}));
		expect(user.toJSON()).toMatchObject({avatar_decoration_data: FRAME, nameplate_data: null});
	});

	it('reads the worn ultra decoration next to the frame and keeps it through an update without it', () => {
		const user = new User(wireUser({avatar_decoration_data: FRAME, avatar_ultra_data: ULTRA}));
		const updated = user.withUpdates({global_name: 'Ayşe'});
		expect(updated.avatarUltra).toEqual(ULTRA);
		expect(updated.avatarDecoration).toEqual(FRAME);
	});

	it('takes the ultra decoration off with null and clears it when an authoritative payload leaves it out', () => {
		const user = new User(wireUser({avatar_ultra_data: ULTRA}));
		expect(user.withUpdates({avatar_ultra_data: null}).avatarUltra).toBeNull();
		expect(user.withUpdates({}, {clearMissingOptionalFields: true}).avatarUltra).toBeNull();
	});

	it('counts a different ultra decoration as a change and writes it back to the wire shape', () => {
		const user = new User(wireUser({avatar_ultra_data: ULTRA}));
		expect(user.equals(user.withUpdates({avatar_ultra_data: {...ULTRA}}))).toBe(true);
		expect(user.equals(user.withUpdates({avatar_ultra_data: {...ULTRA, item_id: '304'}}))).toBe(false);
		expect(user.toJSON()).toMatchObject({avatar_ultra_data: ULTRA});
	});
});

describe('User username selection privacy', () => {
	it('preserves the private state in private snapshots and never invents it on public users', () => {
		const user = new User(wireUser({username_state: 'selected', identity_version: '2'} as never));
		expect(user.usernameState).toBe('selected');
		expect(user.identityVersion).toBe('2');
		expect(user.withUpdates({global_name: 'Ayse'}).toJSON()).toMatchObject({
			username_state: 'selected',
			identity_version: '2',
		});
		expect(new User(wireUser({identity_version: '2'} as never)).toJSON()).not.toHaveProperty('username_state');
	});
});

describe('User Micup limits', () => {
	it('resolves the follow, feed and boost limits by their own keys', () => {
		const user = new User(wireUser());
		expect([user.maxFollowing, user.maxFeedPostsPerDay, user.maxBoostSlots]).toEqual([11, 12, 13]);
	});
});

// Micup profile privacy: the settings screen offers Everyone only while the server allows it (16+ with a date
// of birth); the flag rides on the current user's private payload like nsfw_allowed.
describe('User public profile flag', () => {
	it('reads public_profile_allowed, keeps it through an update and writes it back', () => {
		const user = new User(wireUser({public_profile_allowed: true}));
		expect(user.publicProfileAllowed).toBe(true);
		const updated = user.withUpdates({global_name: 'Ayşe'});
		expect(updated.publicProfileAllowed).toBe(true);
		expect(updated.toJSON().public_profile_allowed).toBe(true);
		expect(user.equals(new User(wireUser({public_profile_allowed: false})))).toBe(false);
	});

	it('is unknown on a public payload', () => {
		expect(new User(wireUser()).publicProfileAllowed).toBeUndefined();
	});
});
