// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const stored = vi.hoisted(() => ({profile: null as unknown}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/UserProfile', () => ({default: {getProfile: () => stored.profile}}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {User} = await import('@app/features/user/models/User');
const {createMockProfile} = await import('@app/features/user/utils/ProfileUtils');

const user = new User({
	id: '7',
	username: 'user7',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
});
const badges = [{id: '1', icon: 'hash1', description: 'Early supporter'}];
const storedEffect = {asset: 'hash31', item_id: '31'};

describe('createMockProfile', () => {
	beforeEach(() => {
		stored.profile = {badges, profileEffect: storedEffect};
	});

	it('keeps the badges and profile effect of the loaded profile, so the preview shows them', () => {
		const profile = createMockProfile(user);
		expect(profile.badges).toEqual(badges);
		expect(profile.profileEffect).toEqual(storedEffect);
	});

	it('shows the profile effect being picked instead of the saved one, including none', () => {
		const picked = {asset: 'hash32', item_id: '32'};
		expect(createMockProfile(user, {previewProfileEffect: picked}).profileEffect).toEqual(picked);
		expect(createMockProfile(user, {previewProfileEffect: null}).profileEffect).toBeNull();
	});

	it('has no badges or effect when no profile is loaded', () => {
		stored.profile = null;
		const profile = createMockProfile(user);
		expect(profile.badges).toBeNull();
		expect(profile.profileEffect).toBeNull();
	});
});
