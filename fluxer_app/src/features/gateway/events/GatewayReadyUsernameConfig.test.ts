// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {runtimeSnapshotFromDiscovery} from '@app/features/app/state/InstanceSnapshotStore';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import {handleReady, type ReadyPayload} from '@app/features/gateway/events/GatewayReady';
import {installRuntimeBootstrap} from '@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture';
import UserNote from '@app/features/user/state/UserNote';
import {parseInstanceDiscoveryDocument} from '@fluxer/instance_bootstrap/src/Discovery';
import {RpcResponseSessionData} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
const noteLoad = vi.hoisted(() => vi.fn());
vi.mock('@app/features/app/state/Initialization', () => ({default: {}}));
vi.mock('@app/features/auth/state/AccountStorage', () => ({default: {}}));
vi.mock('@app/features/auth/state/Accounts', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/auth/state/AuthSession', () => ({default: {}}));
vi.mock('@app/features/channel/state/ChannelPins', () => ({default: {}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/connection/state/UserConnection', () => ({default: {}}));
vi.mock('@app/features/emoji/state/Emoji', () => ({default: {}}));
vi.mock('@app/features/emoji/state/EmojiSticker', () => ({default: {}}));
vi.mock('@app/features/expressions/state/FavoriteMemes', () => ({default: {}}));
vi.mock('@app/features/feed/state/FeedTimeline', () => ({default: {}}));
vi.mock('@app/features/forum/state/ForumPosts', () => ({default: {}}));
vi.mock('@app/features/forum/state/ForumReadState', () => ({default: {}}));
vi.mock('@app/features/guild/state/ChannelMemberCount', () => ({default: {}}));
vi.mock('@app/features/guild/state/GuildAvailability', () => ({default: {loadUnavailableGuilds: vi.fn()}}));
vi.mock('@app/features/guild/state/GuildCount', () => ({default: {}}));
vi.mock('@app/features/guild/state/GuildList', () => ({default: {}}));
vi.mock('@app/features/guild/state/GuildReadState', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/guild/state/GuildVerification', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {}}));
vi.mock('@app/features/member/state/MemberSidebar', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageReactions', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({default: {}}));
vi.mock('@app/features/messaging/state/SavedMessages', () => ({default: {}}));
vi.mock('@app/features/navigation/state/NavigationSideEffects', () => ({default: {}}));
vi.mock('@app/features/notification/state/MentionFeed', () => ({default: {}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {}}));
vi.mock('@app/features/presence/state/Presence', () => ({default: {}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {}}));
vi.mock('@app/features/threads/state/ChannelThreads', () => ({default: {}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {}}));
vi.mock('@app/features/threads/state/ThreadSubscriptions', () => ({default: {}}));
vi.mock('@app/features/user/state/UserNote', () => ({default: {loadNotes: noteLoad}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/user/state/UserPinnedDM', () => ({default: {}}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({default: {}}));
vi.mock('@app/features/user/state/WebAuthnCredentials', () => ({default: {}}));
vi.mock('@app/features/voice/state/RtcRegions', () => ({default: {}}));
vi.mock('@app/features/app/domain_migration/DomainMigrationTrigger', () => ({startDomainMigrationTrigger: vi.fn()}));
vi.mock('@app/features/gateway/events/AccountReadyWork', () => ({scheduleAccountReadyWork: vi.fn()}));
vi.mock('@app/features/voice/VoiceGatewayLifecycle', () => ({seedVoiceStatesFromReady: vi.fn()}));
vi.mock('@app/features/feed/events/FeedNotificationReady', () => ({handleFeedNotificationReady: vi.fn()}));

const migration = {
	state: 'selecting' as const,
	epoch: 2,
	preparing_at: '2026-10-01T00:00:00Z',
	started_at: '2026-10-01T00:01:00Z',
	forced_at: '2026-10-08T00:01:00Z',
};
const tiers = {'1': 'locked' as const, '2': 'for_sale' as const, '3': 'public' as const};

function sessionData() {
	return RpcResponseSessionData.parse({
		username_migration: migration,
		username_tiers: tiers,
		user: {
			id: '123',
			username: 'legacy',
			discriminator: '1234',
			identity_version: '9007199254740993',
			username_state: 'legacy',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
			is_staff: false,
			acls: [],
			traits: [],
			email: 'own@example.test',
			has_verified_phone: false,
			bio: null,
			pronouns: null,
			accent_color: null,
			theme_colors: null,
			banner: null,
			banner_color: null,
			mfa_enabled: false,
			authenticator_types: [],
			verified: true,
			premium_type: null,
			premium_since: null,
			premium_until: null,
			premium_will_cancel: false,
			premium_billing_cycle: null,
			premium_lifetime_sequence: null,
			premium_grace_ends_at: null,
			premium_discriminator: false,
			premium_badge_hidden: false,
			premium_badge_masked: false,
			premium_badge_timestamp_hidden: false,
			premium_badge_sequence_hidden: false,
			premium_purchase_disabled: false,
			premium_enabled_override: false,
			premium_perks_disabled: false,
			password_last_changed_at: null,
			last_voice_activity_sharing_change_at: null,
			required_actions: [],
			nsfw_allowed: false,
			has_dismissed_premium_onboarding: false,
			has_ever_purchased: false,
			has_unread_gift_inventory: false,
			unread_gift_inventory_count: 0,
			pending_bulk_message_deletion: null,
			terms_agreed_at: null,
			privacy_agreed_at: null,
		},
		user_guild_settings: [],
		notes: {},
		read_states: [],
		private_channels: [],
		relationships: [],
		favorite_memes: [],
		guilds: [],
		pinned_dms: [],
		country_code: 'TR',
		geoip_country_code: 'TR',
		rtc_regions: [],
		webauthn_credentials: [],
		version: 1,
	});
}

function context(expectedUserId: string | null = '123', accountKey: string | null = 'own'): GatewayHandlerContext {
	return {
		socket: null,
		accountKey,
		settingsEpoch: 0,
		expectedUserId,
		previousSessionId: null,
		setPreviousSessionId: vi.fn(),
		setReady: vi.fn(() => false),
		setConnectionGeoip: vi.fn(),
		markGuildSynced: vi.fn(),
	};
}

describe('READY username configuration receiver', () => {
	const afterConfig = new Error('stop unrelated READY hydration');
	beforeEach(() => {
		installRuntimeBootstrap();
		noteLoad.mockReset().mockImplementation(() => {
			throw afterConfig;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('retains RPC schema fields through the actual READY receiver and canonical runtime', () => {
		const ready = {...sessionData(), guilds: [], session_id: 'own-session'} as ReadyPayload;
		expect(() => handleReady(ready, context())).toThrow(afterConfig);
		expect(RuntimeConfig.usernameMigration).toEqual(migration);
		expect(RuntimeConfig.usernameTiers).toEqual(tiers);
		expect(RuntimeConfig.apiEndpoint).toBe('https://fluxer.app/api');
	});

	it.skipIf(!process.env.ENT2_READY_FIXTURE)(
		'consumes the actual API RPC and Discovery responses through the client pipeline',
		() => {
			const path = resolve(process.env.ENT2_READY_FIXTURE!);
			if (!path.startsWith(resolve('E:/micup-v2-wt/tmp/kullanici-adi') + sep)) {
				throw new Error('READY fixture must stay in the task temporary directory');
			}
			const fixture: {rpc: unknown; discovery: unknown} = JSON.parse(readFileSync(path, 'utf8'));
			const rpc = RpcResponseSessionData.parse(fixture.rpc);
			const snapshot = runtimeSnapshotFromDiscovery(parseInstanceDiscoveryDocument(fixture.discovery));
			expect(snapshot.usernameMigration).toEqual(rpc.username_migration);
			expect(snapshot.usernameTiers).toEqual(rpc.username_tiers);
			expect(rpc.username_migration?.state).toBe('selecting');
			expect(RuntimeConfig.usernameMigration.state).toBe('legacy');
			expect(rpc.guilds).toEqual([]);
			expect(() =>
				handleReady({...rpc, guilds: [], session_id: 'actual-rpc'} as ReadyPayload, context(rpc.user.id)),
			).toThrow(afterConfig);
			expect(RuntimeConfig.usernameMigration).toEqual(rpc.username_migration);
			expect(RuntimeConfig.usernameTiers).toEqual(rpc.username_tiers);
		},
	);

	it.each([context('456'), context('123', null)])(
		'rejects another or missing account before changing configuration',
		(ctx) => {
			expect(() =>
				handleReady({...sessionData(), guilds: [], session_id: 'wrong-session'} as ReadyPayload, ctx),
			).toThrow();
			expect(RuntimeConfig.usernameMigration.state).toBe('legacy');
			expect(ctx.setPreviousSessionId).not.toHaveBeenCalled();
			expect(UserNote.loadNotes).not.toHaveBeenCalled();
		},
	);

	it('rejects malformed wire configuration before beginning account hydration', () => {
		const ctx = context();
		const ready = {...sessionData(), session_id: 'own-session', username_migration: null} as unknown as ReadyPayload;
		expect(() => handleReady(ready, ctx)).toThrow();
		expect(RuntimeConfig.usernameMigration.state).toBe('legacy');
		expect(ctx.setPreviousSessionId).not.toHaveBeenCalled();
		expect(UserNote.loadNotes).not.toHaveBeenCalled();
	});
});
