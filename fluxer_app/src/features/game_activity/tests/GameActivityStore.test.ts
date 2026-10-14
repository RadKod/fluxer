// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStoreSingleton, {GameActivityStore} from '@app/features/game_activity/state/GameActivityStore';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {GameActivity, PresenceRecord} from '@app/features/gateway/types/GatewayPresenceTypes';
import {handlePresenceUpdate} from '@app/features/presence/events/PresenceUpdate';
import {handlePresenceUpdateBulk} from '@app/features/presence/events/PresenceUpdateBulk';
import Presence from '@app/features/presence/state/Presence';
import {handleRelationshipAdd} from '@app/features/relationship/events/RelationshipAdd';
import {handleRelationshipRemove} from '@app/features/relationship/events/RelationshipRemove';
import {handleRelationshipUpdate} from '@app/features/relationship/events/RelationshipUpdate';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'self'}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getPrivateChannels: () => []}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/member/state/MemberSidebar', () => ({default: {handleLocalPresenceUpdate: vi.fn()}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));
vi.mock('@app/features/platform/utils/DeferUntilModulesLoaded', () => ({deferUntilModulesLoaded: vi.fn()}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({
	default: {getStatus: () => 'online', customStatus: null},
}));
vi.mock('@app/features/presence/state/TransientPresence', () => ({default: {clear: vi.fn(), clearPresence: vi.fn()}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/expressions/utils/UnicodeEmojis', () => ({
	default: {normalizeEmojiNameToSurrogate: (s: string) => s},
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({
	default: {getRelationships: () => [], updateRelationship: vi.fn(), removeRelationship: vi.fn()},
}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {handleFriendshipChange: vi.fn()}}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {handleRelationshipNotification: vi.fn()}}));

const game: GameActivity = {game_id: 'league-of-legends', started_at: 1000};
const context = {} as GatewayHandlerContext;

function record(userId: string, fields: Partial<PresenceRecord> = {}): PresenceRecord {
	return {
		user: {
			id: userId,
			username: userId,
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		status: 'online',
		...fields,
	};
}

describe('GameActivityStore', () => {
	let store: GameActivityStore;
	beforeEach(() => {
		store = new GameActivityStore();
		GameActivityStoreSingleton.reset();
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		GameActivityStoreSingleton.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
	});

	it('absent_preserves_friend_game', () => {
		store.update(record('friend', {game_activity: game}));
		store.update(record('friend'));
		store.update(record('friend', {guild_id: 'guild'}));
		expect(store.get('friend')).toEqual(game);
	});

	it('guild_field_never_grants_game', () => {
		store.update(record('guild-only', {guild_id: 'guild', game_activity: game}));
		expect(store.get('guild-only')).toBeNull();
		store.update(record('friend', {game_activity: game}));
		store.update(record('friend', {guild_id: 'guild', game_activity: {manual_name: 'Wrong', started_at: 2000}}));
		store.update(record('friend', {guild_id: 'guild', game_activity: null}));
		expect(store.get('friend')).toEqual(game);
	});

	it('guild_absent_preserves_friend_game', () => {
		store.update(record('friend', {game_activity: game}));
		store.update(record('friend', {guild_id: 'guild'}));
		expect(store.get('friend')).toEqual(game);
	});

	it('null_clears', () => {
		store.update(record('friend', {game_activity: game}));
		const listener = vi.fn();
		store.subscribe('friend', listener);
		store.update(record('friend', {game_activity: null}));
		expect(store.get('friend')).toBeNull();
		expect(listener).toHaveBeenCalledOnce();
	});

	it('ready_replaces_old_map', () => {
		store.update(record('old', {game_activity: game}));
		const listener = vi.fn();
		store.subscribe('old', listener);
		store.replaceReady([record('new', {game_activity: game}), record('guild', {guild_id: 'g', game_activity: game})]);
		expect(store.get('old')).toBeNull();
		expect(store.get('new')).toEqual(game);
		expect(store.get('guild')).toBeNull();
		expect(listener).toHaveBeenCalledOnce();
		store.replaceReady([]);
		expect(store.get('new')).toBeNull();
	});

	it('account_switch_drops_old_data', () => {
		store.update(record('old-friend', {game_activity: game}));
		const listener = vi.fn();
		store.subscribe('old-friend', listener);
		store.reset();
		expect(store.get('old-friend')).toBeNull();
		expect(listener).toHaveBeenCalledOnce();
	});

	it('ready_null_clears_an_earlier_snapshot_entry', () => {
		store.replaceReady([record('friend', {game_activity: game}), record('friend', {game_activity: null})]);
		expect(store.get('friend')).toBeNull();
	});

	it('only_changed_user_is_notified_and_renewals_keep_snapshot_identity', () => {
		const friendListener = vi.fn();
		const otherListener = vi.fn();
		const unsubscribe = store.subscribe('friend', friendListener);
		store.subscribe('other', otherListener);
		store.update(record('friend', {game_activity: game}));
		const snapshot = store.get('friend');
		store.update(record('friend', {game_activity: {...game}}));
		expect(store.get('friend')).toBe(snapshot);
		expect(friendListener).toHaveBeenCalledOnce();
		expect(otherListener).not.toHaveBeenCalled();
		unsubscribe();
		store.clear('friend');
		expect(friendListener).toHaveBeenCalledOnce();
	});

	it('manual_activity_and_nullable_global_context_are_supported', () => {
		const manual: GameActivity = {manual_name: '<b>my game</b>', started_at: 100};
		store.update(record('friend', {guild_id: null, game_activity: manual}));
		expect(store.get('friend')).toEqual(manual);
	});

	it('single_presence_routes_game_without_replacing_custom_status', () => {
		handlePresenceUpdate(record('friend', {game_activity: game, custom_status: {text: 'My status'}}), context);
		expect(GameActivityStoreSingleton.get('friend')).toEqual(game);
		expect(Presence.getCustomStatus('friend')?.text).toBe('My status');
		expect(Presence.getStatus('friend')).toBe('online');
	});

	it('bulk_preserves_record_guild_scope_and_envelope_guild_scope', () => {
		handlePresenceUpdateBulk({presences: [record('friend', {game_activity: game})]}, context);
		expect(GameActivityStoreSingleton.get('friend')).toEqual(game);
		handlePresenceUpdateBulk({guild_id: 'g', presences: [record('friend', {game_activity: null})]}, context);
		handlePresenceUpdateBulk({presences: [record('friend', {guild_id: 'g', game_activity: null})]}, context);
		expect(GameActivityStoreSingleton.get('friend')).toEqual(game);
	});

	it('block_unfriend_clear', () => {
		for (const [handler, payload] of [
			[handleRelationshipAdd, {id: 'friend', type: RelationshipTypes.BLOCKED}],
			[handleRelationshipUpdate, {id: 'friend', type: RelationshipTypes.INCOMING_REQUEST}],
			[handleRelationshipRemove, {id: 'friend', type: RelationshipTypes.FRIEND}],
		] as const) {
			GameActivityStoreSingleton.update(record('friend', {game_activity: game}));
			expect(GameActivityStoreSingleton.get('friend')).toEqual(game);
			handler(payload, context);
			expect(GameActivityStoreSingleton.get('friend')).toBeNull();
		}
	});

	it('friend_relationship_update_preserves_game', () => {
		GameActivityStoreSingleton.update(record('friend', {game_activity: game}));
		handleRelationshipUpdate({id: 'friend', type: RelationshipTypes.FRIEND}, context);
		expect(GameActivityStoreSingleton.get('friend')).toEqual(game);
	});

	it('session_invalidation_clears_received_data', () => {
		GameActivityStoreSingleton.update(record('friend', {game_activity: game}));
		const listener = vi.fn();
		GameActivityStoreSingleton.subscribe('friend', listener);
		Presence.handleSessionInvalidated();
		expect(GameActivityStoreSingleton.get('friend')).toBeNull();
		expect(listener).toHaveBeenCalledOnce();
	});
});

describe('Game activity rollout closed by default', () => {
	it('live close drops received activities and reopens only fresh updates', () => {
		const store = new GameActivityStore();
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		store.update(record('friend', {game_activity: game}));
		const listener = vi.fn();
		store.subscribe('friend', listener);
		store.handleRollout({game_activity_enabled: false, game_activity_epoch: 2});
		expect(store.enabled).toBe(false);
		expect(store.get('friend')).toBeNull();
		expect(listener).toHaveBeenCalledOnce();
		store.update(record('friend', {game_activity: game}));
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 2});
		expect(store.enabled).toBe(true);
		expect(store.get('friend')).toBeNull();
		store.update(record('friend', {game_activity: game}));
		expect(store.get('friend')).toEqual(game);
	});

	it('lower epoch cannot reopen and malformed authority closes', () => {
		const store = new GameActivityStore();
		store.handleRollout({game_activity_enabled: false, game_activity_epoch: 5});
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 4});
		expect(store.enabled).toBe(false);
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 5});
		store.update(record('friend', {game_activity: game}));
		store.handleRollout({game_activity_enabled: true});
		expect(store.enabled).toBe(false);
		expect(store.get('friend')).toBeNull();
		store.resetRollout();
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 0});
		expect(store.enabled).toBe(true);
	});

	it('does not retain received games before an authoritative rollout arrives', () => {
		const store = new GameActivityStore();
		store.update(record('friend', {game_activity: game}));
		store.replaceReady([record('friend', {game_activity: game})]);
		expect(store.get('friend')).toBeNull();
	});

	it('does not subscribe to game updates before rollout is enabled', () => {
		const store = new GameActivityStore();
		const listener = vi.fn();
		store.subscribe('friend', listener);
		store.update(record('friend', {game_activity: game}));
		expect(listener).not.toHaveBeenCalled();
	});
});
