// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {PresenceRecord} from '@app/features/gateway/types/GatewayPresenceTypes';
import {handleGuildDelete} from '@app/features/guild/events/GuildDelete';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const stub = vi.hoisted(() => () => {
	const methods: Record<string | symbol, unknown> = {};
	return {default: new Proxy(methods, {get: (target, key) => (target[key] ??= () => undefined)})};
});
vi.mock('@app/features/channel/state/Channels', stub);
vi.mock('@app/features/emoji/state/Emoji', stub);
vi.mock('@app/features/emoji/state/EmojiSticker', stub);
vi.mock('@app/features/guild/state/ChannelMemberCount', stub);
vi.mock('@app/features/guild/state/GuildAvailability', stub);
vi.mock('@app/features/guild/state/GuildCount', stub);
vi.mock('@app/features/guild/state/GuildList', stub);
vi.mock('@app/features/guild/state/GuildReadState', stub);
vi.mock('@app/features/guild/state/Guilds', stub);
vi.mock('@app/features/guild/state/GuildVerification', stub);
vi.mock('@app/features/invite/state/Invites', stub);
vi.mock('@app/features/member/state/GuildMembers', stub);
vi.mock('@app/features/member/state/MemberSearch', stub);
vi.mock('@app/features/member/state/MemberSidebar', stub);
vi.mock('@app/features/messaging/state/MessagingMessages', stub);
vi.mock('@app/features/notification/state/MentionFeed', stub);
vi.mock('@app/features/permissions/state/Permission', stub);
vi.mock('@app/features/presence/state/Presence', stub);
vi.mock('@app/features/search/state/QuickSwitcher', stub);
vi.mock('@app/features/threads/state/ThreadGuilds', stub);
vi.mock('@app/features/user/state/UserProfile', stub);
vi.mock('@app/features/voice/engine/MediaEngineFacade', stub);
vi.mock('@app/features/webhook/state/Webhooks', stub);
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({currentInstanceTarget: () => null}));

const game = {game_id: 'league-of-legends', started_at: 1000};
const record = (userId: string, guildId?: string): PresenceRecord => ({
	guild_id: guildId,
	user: {
		id: userId,
		username: userId,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	},
	game_activity: game,
});

describe('guild delete and game activity scopes', () => {
	beforeEach(() => {
		GameActivityStore.resetRollout();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
	});

	it.each([{}, {unavailable: true}])('t8_guild_delete_clears_scope %o', (extra) => {
		GameActivityStore.update(record('member', 'g1'));
		GameActivityStore.update(record('friend'));
		GameActivityStore.update(record('other', 'g2'));
		handleGuildDelete({id: 'g1', ...extra}, {} as GatewayHandlerContext);
		expect(GameActivityStore.get('member')).toBeNull();
		expect(GameActivityStore.get('friend')).toEqual(game);
		expect(GameActivityStore.get('other')).toEqual(game);
	});
});
