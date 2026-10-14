// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserPartial} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'self'}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getPrivateChannels: () => []}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/member/state/MemberSidebar', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));
vi.mock('@app/features/platform/utils/DeferUntilModulesLoaded', () => ({deferUntilModulesLoaded: () => {}}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({default: {getStatus: () => 'offline'}}));
vi.mock('@app/features/presence/state/TransientPresence', () => ({default: {clear: vi.fn(), clearPresence: vi.fn()}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {getRelationships: () => []}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/expressions/utils/UnicodeEmojis', () => ({
	default: {normalizeEmojiNameToSurrogate: (name: string) => name},
}));
vi.mock('@app/features/user/state/CustomStatusEmitter', () => ({
	CustomStatusEmitter: {emitPresenceChange: vi.fn()},
}));

const {default: Presence} = await import('@app/features/presence/state/Presence');
const {default: GameActivityStore} = await import('@app/features/game_activity/state/GameActivityStore');
const user = {
	id: 'friend',
	username: 'friend',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
} satisfies UserPartial;

describe('Presence game projections', () => {
	beforeEach(() => {
		Presence.handleSessionInvalidated();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
	});
	it.each([false, true])('start/change/null/replay preserve normal presence with guild=%s', (inGuild) => {
		Presence.handlePresenceUpdate({user, status: 'online', mobile: true, custom_status: {text: 'hello'}});
		if (inGuild)
			Presence.handlePresenceUpdate({
				user,
				guild_id: 'guild',
				status: 'online',
				mobile: true,
				custom_status: {text: 'hello'},
			});
		const before = {
			status: Presence.getStatus(user.id),
			custom: Presence.getCustomStatus(user.id),
			mobile: Presence.isMobile(user.id),
			count: Presence.getPresenceCount('guild'),
			version: Presence.presenceVersion,
		};
		for (const game_activity of [
			{game_id: 'first-game', started_at: 1000},
			{game_id: 'second-game', started_at: 2000},
			null,
			{game_id: 'second-game', started_at: 2000},
			{game_id: 'second-game', started_at: 2000},
		]) {
			Presence.handlePresenceUpdate({user, game_activity});
			expect(GameActivityStore.get(user.id)).toEqual(game_activity);
			expect({
				status: Presence.getStatus(user.id),
				custom: Presence.getCustomStatus(user.id),
				mobile: Presence.isMobile(user.id),
				count: Presence.getPresenceCount('guild'),
				version: Presence.presenceVersion,
			}).toEqual(before);
		}
	});
	it('mixed presence still applies explicit offline/custom null/mobile false', () => {
		Presence.handlePresenceUpdate({user, status: 'online', mobile: true, custom_status: {text: 'hello'}});
		Presence.handlePresenceUpdate({
			user,
			guild_id: 'guild',
			status: 'online',
			mobile: true,
			custom_status: {text: 'hello'},
		});
		Presence.handlePresenceUpdate({user, status: 'offline', mobile: false, custom_status: null, game_activity: null});
		expect(Presence.getStatus(user.id)).toBe('offline');
		expect(Presence.getCustomStatus(user.id)).toBeNull();
		expect(Presence.isMobile(user.id)).toBe(false);
		expect(Presence.getPresenceCount('guild')).toBe(0);
		expect(GameActivityStore.get(user.id)).toBeNull();
	});
});
