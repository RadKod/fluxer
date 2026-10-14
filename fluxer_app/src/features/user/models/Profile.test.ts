// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ProfileWire} from '@app/features/user/models/Profile';
import {describe, expect, it, vi} from 'vitest';

const WIRE_USER = {
	id: '1',
	username: 'ayse',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
};

vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: () => ({toJSON: () => WIRE_USER})}}));

const {Profile} = await import('@app/features/user/models/Profile');

const EFFECT = {asset: 'effect-hash', item_id: '301'};
const BADGE = {id: '401', icon: 'badge-hash', description: 'Kurucu'};

function wireProfile(extra: Partial<ProfileWire> = {}): ProfileWire {
	return {
		user: WIRE_USER,
		user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
		timezone_offset: null,
		...extra,
	};
}

describe('Profile Micup fields', () => {
	it('reads null when the server sends none of them', () => {
		const profile = new Profile(wireProfile());
		expect(profile.profileEffect).toBeNull();
		expect(profile.badges).toBeNull();
		expect(profile.followerCount).toBeNull();
		expect(profile.followingCount).toBeNull();
		expect(profile.isFollowing).toBeNull();
	});

	it('maps the effect, badges and follow state', () => {
		const profile = new Profile(
			wireProfile({
				profile_effect_data: EFFECT,
				badges: [BADGE],
				follower_count: 5,
				following_count: 3,
				is_following: false,
			}),
		);
		expect(profile.profileEffect).toEqual(EFFECT);
		expect(profile.badges).toEqual([BADGE]);
		expect([profile.followerCount, profile.followingCount, profile.isFollowing]).toEqual([5, 3, false]);
	});

	it('keeps the fields an update leaves out and applies the ones it sends', () => {
		const profile = new Profile(
			wireProfile({profile_effect_data: EFFECT, badges: [BADGE], follower_count: 5, is_following: false}),
		);
		const followed = profile.withUpdates({follower_count: 6, is_following: true});
		expect(followed.profileEffect).toEqual(EFFECT);
		expect(followed.badges).toEqual([BADGE]);
		expect([followed.followerCount, followed.isFollowing]).toEqual([6, true]);
		expect(profile.equals(followed)).toBe(false);
		expect(followed.equals(followed.withUpdates({}))).toBe(true);
	});
});
