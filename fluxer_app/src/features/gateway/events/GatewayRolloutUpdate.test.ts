// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {PresenceRecord} from '@app/features/gateway/types/GatewayPresenceTypes';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const calls = vi.hoisted(() => ({setAccount: vi.fn(), syncPolicy: vi.fn()}));
vi.mock('@app/features/game_activity/utils/DesktopGameActivityBridge', () => ({default: calls}));
vi.mock('@app/features/feed/events/FeedNotificationReady', () => ({handleFeedNotificationReady: vi.fn()}));
vi.mock('@app/features/premium/commands/PremiumCommands', () => ({refreshPremiumState: async () => {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
		info() {}
		error() {}
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/app/domain_migration/DomainMigrationTrigger', () => ({startDomainMigrationTrigger: vi.fn()}));
vi.mock('@app/features/gateway/events/AccountReadyWork', () => ({scheduleAccountReadyWork: vi.fn()}));
vi.mock('@app/features/voice/VoiceGatewayLifecycle', () => ({seedVoiceStatesFromReady: vi.fn()}));

for (const path of [
	'@app/features/app/state/Initialization',
	'@app/features/auth/state/AccountStorage',
	'@app/features/auth/state/Accounts',
	'@app/features/auth/state/Authentication',
	'@app/features/auth/state/AuthSession',
	'@app/features/channel/state/ChannelPins',
	'@app/features/channel/state/Channels',
	'@app/features/connection/state/UserConnection',
	'@app/features/emoji/state/Emoji',
	'@app/features/emoji/state/EmojiSticker',
	'@app/features/expressions/state/FavoriteMemes',
	'@app/features/feed/state/FeedTimeline',
	'@app/features/forum/state/ForumPosts',
	'@app/features/forum/state/ForumReadState',
	'@app/features/guild/state/ChannelMemberCount',
	'@app/features/guild/state/GuildAvailability',
	'@app/features/guild/state/GuildCount',
	'@app/features/guild/state/GuildList',
	'@app/features/guild/state/GuildReadState',
	'@app/features/guild/state/Guilds',
	'@app/features/guild/state/GuildVerification',
	'@app/features/member/state/GuildMembers',
	'@app/features/member/state/MemberSearch',
	'@app/features/member/state/MemberSidebar',
	'@app/features/messaging/state/MessageReactions',
	'@app/features/messaging/state/MessagingMessages',
	'@app/features/messaging/state/SavedMessages',
	'@app/features/navigation/state/NavigationSideEffects',
	'@app/features/notification/state/MentionFeed',
	'@app/features/permissions/state/Permission',
	'@app/features/presence/state/Presence',
	'@app/features/read_state/state/ReadStates',
	'@app/features/relationship/state/Relationships',
	'@app/features/threads/state/ChannelThreads',
	'@app/features/threads/state/ThreadGuilds',
	'@app/features/threads/state/ThreadSubscriptions',
	'@app/features/user/state/UserGuildSettings',
	'@app/features/user/state/UserNote',
	'@app/features/user/state/UserPinnedDM',
	'@app/features/user/state/UserSettings',
	'@app/features/user/state/Users',
	'@app/features/user/state/WebAuthnCredentials',
	'@app/features/voice/state/RtcRegions',
]) {
	vi.doMock(path, () => ({default: new Proxy({}, {get: () => vi.fn(async () => {})})}));
}

const {handleReady} = await import('@app/features/gateway/events/GatewayReady');
const {handleGatewayRolloutUpdate} = await import('@app/features/gateway/events/GatewayRolloutUpdate');
const game = {game_id: 'test-game', started_at: 1000};
const presence = {user: {id: 'friend'}, game_activity: game} as PresenceRecord;
const context = {
	accountKey: 'micup.test::owner',
	expectedUserId: 'owner',
	setPreviousSessionId: vi.fn(),
	setConnectionGeoip: vi.fn(),
	setReady: vi.fn(),
} as unknown as GatewayHandlerContext;

describe('gateway game activity authority', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		GameActivityStore.resetRollout();
		calls.setAccount.mockImplementation(async () => GameActivityStore.enabled);
	});
	it('READY installs rollout authority before desktop account configuration', async () => {
		handleReady(
			{
				session_id: 'new',
				user: {id: 'owner'},
				guilds: [],
				presences: [presence],
				gateway_rollout: {game_activity_enabled: true, game_activity_epoch: 1},
			} as never,
			context,
		);
		expect(calls.setAccount).toHaveBeenCalledWith('owner');
		await expect(calls.setAccount.mock.results[0].value).resolves.toBe(true);
		expect(GameActivityStore.get('friend')).toEqual(game);
	});

	it.each([undefined, {game_activity_enabled: true}, {game_activity_enabled: 'true', game_activity_epoch: 2}])(
		'missing or malformed READY rollout closes old activity before desktop starts: %j',
		async (rollout) => {
			GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
			GameActivityStore.update(presence);
			handleReady(
				{session_id: 'new', user: {id: 'owner'}, guilds: [], presences: [presence], gateway_rollout: rollout} as never,
				context,
			);
			await expect(calls.setAccount.mock.results[0].value).resolves.toBe(false);
			expect(GameActivityStore.enabled).toBe(false);
			expect(GameActivityStore.get('friend')).toBeNull();
		},
	);

	it('live update clears received games and synchronizes desktop immediately', () => {
		handleGatewayRolloutUpdate({game_activity_enabled: true, game_activity_epoch: 1});
		GameActivityStore.update(presence);
		handleGatewayRolloutUpdate({game_activity_enabled: false, game_activity_epoch: 2});
		expect(GameActivityStore.get('friend')).toBeNull();
		expect(calls.syncPolicy).toHaveBeenCalledTimes(2);
		handleGatewayRolloutUpdate({game_activity_enabled: true, game_activity_epoch: 1});
		expect(GameActivityStore.enabled).toBe(false);
		handleGatewayRolloutUpdate({game_activity_enabled: true, game_activity_epoch: 2});
		expect(GameActivityStore.enabled).toBe(true);
		expect(GameActivityStore.get('friend')).toBeNull();
	});
});
