// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {observe, runInAction} from 'mobx';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';
const CHANNEL_A = 'channel-a';
const RANGE: [number, number] = [0, 99];
const RANGE_SIZE = RANGE[1] - RANGE[0] + 1;

const FRAME_BUDGET_MS = 8;
// About 8x the ~1.3 us a desktop CPU spends evicting one user in this development build: a slow device.
const MS_PER_EVICTED_USER = 0.01;

const socket = {
	isConnected: () => true,
	updateGuildSubscriptions: vi.fn(),
	requestGuildMembers: vi.fn(),
};

const idleCallbacks: Array<() => void> = [];
vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));

function runIdleWork(maxSlices = Number.POSITIVE_INFINITY): Array<number> {
	const sliceMs: Array<number> = [];
	while (idleCallbacks.length > 0 && sliceMs.length < maxSlices) {
		const callback = idleCallbacks.shift()!;
		const start = performance.now();
		callback();
		sliceMs.push(performance.now() - start);
	}
	return sliceMs;
}

interface FakeMessage {
	id: string;
	author: {id: string};
	webhookId?: string;
	content: string;
	mentions: Array<{id: string}>;
	referencedMessage?: FakeMessage | null;
}

const cachedMessages: Array<FakeMessage> = [];
const savedMessages: Array<FakeMessage> = [];
const recentMentions: Array<FakeMessage> = [];
const referencedMessages = new Map<string, FakeMessage>();
const openProfileMembers = new Map<string, Array<string>>();
const recentProfiles: Record<string, unknown> = {};
const voiceStates: Record<string, Record<string, Record<string, {user_id: string}>>> = {};
const privateChannels: Array<{recipientIds: Array<string>}> = [];
const relationships: Array<{userId: string}> = [];
const webhooks = new Map<string, {creatorId: string}>();
const channelGuilds = new Map<string, string>();

vi.mock('@lingui/core/macro', () => {
	const descriptor = (value: unknown): unknown => (typeof value === 'string' ? {message: value} : value);
	return {msg: descriptor, t: descriptor, plural: () => '', select: () => '', selectOrdinal: () => ''};
});
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {userId: 'me', currentUserId: 'me'},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: 'me'},
}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {
		foregroundConnection: {
			socket,
			isReady: true,
			isConnected: true,
			sessionId: 'session-1',
			hasCompletedGuildSync: () => false,
			syncGuildIfNeeded: () => {},
		},
	},
}));
vi.mock('@app/features/navigation/state/SelectedGuild', async () => {
	const {observable} = await import('mobx');
	return {default: observable({selectedGuildId: 'guild-a' as string | null})};
});
vi.mock('@app/features/navigation/state/Navigation', async () => {
	const {observable} = await import('mobx');
	return {default: observable({channelId: null as string | null})};
});
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {
		getChannel: (id: string) => {
			const guildId = channelGuilds.get(id);
			return guildId ? {id, guildId, isPrivate: () => false, permissionOverwrites: {}} : undefined;
		},
		getPrivateChannels: () => privateChannels,
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => undefined}}));
vi.mock('@app/features/messaging/state/ChannelMessages', () => ({
	ChannelMessages: {
		forEach: (callback: (messages: {forEachBuffered: (cb: (m: FakeMessage) => void) => void}) => void) => {
			callback({forEachBuffered: (cb) => cachedMessages.forEach(cb)});
		},
	},
}));
vi.mock('@app/features/messaging/state/SavedMessages', () => ({default: {savedMessages}}));
vi.mock('@app/features/notification/state/MentionFeed', () => ({default: {recentMentions}}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({
	default: {getReferencedMessages: () => referencedMessages.values()},
}));
vi.mock('@app/features/presence/state/MemberPresenceSubscription', () => ({
	default: {getSubscribedMembers: (guildId: string) => openProfileMembers.get(guildId) ?? []},
}));
vi.mock('@app/features/user/state/UserProfile', () => ({default: {profiles: recentProfiles}}));
vi.mock('@app/features/voice/engine/v2/VoiceEngineV2AppVoiceStateAdapter', () => ({
	default: {getAllVoiceStates: () => voiceStates},
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {getRelationships: () => relationships}}));
vi.mock('@app/features/webhook/state/Webhooks', () => ({default: {webhooks}}));

const {default: GuildMembers} = await import('@app/features/member/state/GuildMembers');
const {default: MemberSidebar} = await import('@app/features/member/state/MemberSidebar');
const {default: SelectedGuild} = await import('@app/features/navigation/state/SelectedGuild');
const {default: Navigation} = await import('@app/features/navigation/state/Navigation');
const {default: Users} = await import('@app/features/user/state/Users');
const {useMemberListSubscription} = await import('@app/features/member/hooks/useMemberListSubscription');
await Promise.resolve();

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

function GuildAMemberList(): null {
	useMemberListSubscription({guildId: GUILD_A, channelId: CHANNEL_A, enabled: true});
	return null;
}

async function openGuildAMemberList(): Promise<() => Promise<void>> {
	const root = createRoot(document.createElement('div'));
	await act(async () => root.render(createElement(GuildAMemberList)));
	return () => act(async () => root.unmount());
}

function userId(index: number): string {
	return `1300000000${String(index).padStart(9, '0')}`;
}

function wireMember(id: string) {
	return {
		user: {
			id,
			username: `user-${id}`,
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		nick: null,
		avatar: null,
		banner: null,
		accent_color: null,
		roles: [],
		joined_at: '2026-01-01T00:00:00.000Z',
		mute: false,
		deaf: false,
	};
}

function selectGuild(guildId: string | null): void {
	runInAction(() => {
		SelectedGuild.selectedGuildId = guildId;
	});
}

function pushChunk(guildId: string, count: number, extraIds: Array<string> = []): void {
	const chunkSize = 1000;
	for (let start = 0; start < count; start += chunkSize) {
		const members = [];
		for (let index = start; index < Math.min(start + chunkSize, count); index += 1) {
			members.push(wireMember(userId(index)));
		}
		GuildMembers.handleMembersChunk({guildId, members, chunkIndex: 0, chunkCount: 1});
	}
	if (extraIds.length > 0) {
		GuildMembers.handleMembersChunk({guildId, members: extraIds.map(wireMember), chunkIndex: 0, chunkCount: 1});
	}
}

function hydrateMemberListRange(): void {
	const items = [];
	for (let index = RANGE[0]; index <= RANGE[1]; index += 1) {
		items.push({member: wireMember(userId(index))});
	}
	MemberSidebar.handleListUpdate({
		guildId: GUILD_A,
		listId: CHANNEL_A,
		channelId: CHANNEL_A,
		memberCount: 100_000,
		onlineCount: RANGE_SIZE,
		groups: [],
		ops: [{op: 'SYNC', range: RANGE, items}],
	});
}

function message(id: string, authorId: string, extra: Partial<FakeMessage> = {}): FakeMessage {
	return {id, author: {id: authorId}, content: '', mentions: [], referencedMessage: null, ...extra};
}

function resetWorld(): void {
	selectGuild(GUILD_A);
	runInAction(() => {
		Navigation.channelId = null;
	});
	// A claimed READY user avoids scheduling unrelated claim-account modal imports.
	Users.handleGatewayReady('micup-test-account', {...wireMember('me').user, email: 'me@fluxer.test'} as never);
	GuildMembers.handleGatewayReady([]);
	MemberSidebar.handleSessionInvalidated();
	idleCallbacks.length = 0;
	socket.updateGuildSubscriptions.mockClear();
	cachedMessages.length = 0;
	savedMessages.length = 0;
	recentMentions.length = 0;
	referencedMessages.clear();
	openProfileMembers.clear();
	for (const key of Object.keys(recentProfiles)) delete recentProfiles[key];
	for (const key of Object.keys(voiceStates)) delete voiceStates[key];
	privateChannels.length = 0;
	relationships.length = 0;
	webhooks.clear();
	channelGuilds.clear();
	channelGuilds.set(CHANNEL_A, GUILD_A);
}

// A 100K member test takes under 1 s on a desktop and 3.3 s on a 4 vCPU CI runner, too close to the 5 s default.
describe('GuildMembers eviction of inactive large guilds', {timeout: 30_000}, () => {
	beforeEach(resetWorld);

	it('drops a 100K member cache to the member list range plus visible authors, and the member list asks for the range again on return', async () => {
		const closeMemberList = await openGuildAMemberList();
		expect(socket.updateGuildSubscriptions).toHaveBeenCalledOnce();
		hydrateMemberListRange();
		pushChunk(GUILD_A, 100_000);
		const authorIds = Array.from({length: 20}, (_, index) => userId(50_000 + index));
		authorIds.forEach((authorId, index) => cachedMessages.push(message(`m${index}`, authorId)));
		expect(GuildMembers.getMemberCount(GUILD_A)).toBe(100_000);

		selectGuild(GUILD_B);
		await closeMemberList();
		runIdleWork();

		expect(GuildMembers.getMemberCount(GUILD_A)).toBeLessThanOrEqual(RANGE_SIZE + authorIds.length);
		expect(GuildMembers.getMember(GUILD_A, userId(0))).not.toBeNull();
		expect(GuildMembers.getMember(GUILD_A, userId(99))).not.toBeNull();
		for (const authorId of authorIds) {
			expect(GuildMembers.getMember(GUILD_A, authorId)).not.toBeNull();
		}
		expect(GuildMembers.getMember(GUILD_A, userId(70_000))).toBeNull();
		expect(Users.usersList.length).toBeLessThanOrEqual(RANGE_SIZE + authorIds.length + 1);
		expect(GuildMembers.isGuildFullyLoaded(GUILD_A)).toBe(false);

		socket.updateGuildSubscriptions.mockClear();
		selectGuild(GUILD_A);
		onTestFinished(await openGuildAMemberList());
		expect(socket.updateGuildSubscriptions).toHaveBeenCalledExactlyOnceWith({
			subscriptions: {[GUILD_A]: expect.objectContaining({member_list_channels: {[CHANNEL_A]: [RANGE]}})},
		});
	});

	describe('keeps everything that is still visible', () => {
		const MEMBER_COUNT = 400;

		function leaveGuildA(): void {
			selectGuild(GUILD_B);
			runIdleWork();
			expect(GuildMembers.getMemberCount(GUILD_A)).toBeLessThan(MEMBER_COUNT);
		}

		function expectKept(id: string): void {
			expect(GuildMembers.getMember(GUILD_A, id)).not.toBeNull();
			expect(Users.getUser(id)).toBeDefined();
		}

		it('message authors, mentions, replied-to authors and inline user references', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			cachedMessages.push(
				message('m1', userId(1), {
					mentions: [{id: userId(2)}],
					content: `hey <@${userId(3)}> and <@!${userId(4)}>`,
					referencedMessage: message('m0', userId(5)),
				}),
			);
			leaveGuildA();
			[1, 2, 3, 4, 5].forEach((index) => expectKept(userId(index)));
			expect(GuildMembers.getMember(GUILD_A, userId(300))).toBeNull();
			expect(Users.getUser(userId(300))).toBeUndefined();
		});

		it('saved messages, the mention inbox and cached reply targets', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			savedMessages.push(message('s1', userId(13)));
			recentMentions.push(message('r1', userId(14), {content: `<@${userId(15)}>`}));
			referencedMessages.set('channel-a:q1', message('q1', userId(16)));
			leaveGuildA();
			[13, 14, 15, 16].forEach((index) => expectKept(userId(index)));
		});

		it('open profiles', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			openProfileMembers.set(GUILD_A, [userId(6)]);
			recentProfiles[userId(7)] = {};
			leaveGuildA();
			expectKept(userId(6));
			expectKept(userId(7));
		});

		it('members sitting in a voice channel', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			voiceStates[GUILD_A] = {'voice-a': {'connection-1': {user_id: userId(8)}}};
			leaveGuildA();
			expectKept(userId(8));
		});

		it('direct message recipients, friends and webhook creators', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			privateChannels.push({recipientIds: [userId(9)]});
			relationships.push({userId: userId(10)});
			webhooks.set('webhook-1', {creatorId: userId(11)});
			leaveGuildA();
			[9, 10, 11].forEach((index) => expectKept(userId(index)));
		});

		it('our own member record', () => {
			pushChunk(GUILD_A, MEMBER_COUNT, ['me']);
			leaveGuildA();
			expect(GuildMembers.getMember(GUILD_A, 'me')).not.toBeNull();
			pushChunk(GUILD_A, MEMBER_COUNT);
			GuildMembers.evictInactiveGuild(GUILD_A, new Set());
			runIdleWork();
			expect(GuildMembers.getMember(GUILD_A, 'me')).not.toBeNull();
			expect(Users.currentUser?.id).toBe('me');
		});

		it.each([
			['member add', (id: string) => GuildMembers.handleMemberAdd(GUILD_B, wireMember(id))],
			['member list hydration', (id: string) => GuildMembers.hydrateIfMissing(GUILD_B, wireMember(id))],
			['member chunk', (id: string) => pushChunk(GUILD_B, 0, [id])],
			[
				'guild create',
				(id: string) => GuildMembers.handleGuildCreate({id: GUILD_B, members: [wireMember(id)]} as never),
			],
		])('users that another cached guild still holds (%s)', (_path, addToGuildB) => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			addToGuildB(userId(12));
			leaveGuildA();
			expect(GuildMembers.getMember(GUILD_A, userId(12))).toBeNull();
			expect(GuildMembers.getMember(GUILD_B, userId(12))).not.toBeNull();
			expect(Users.getUser(userId(12))).toBeDefined();
		});

		it('but frees users removed from the other guild', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			GuildMembers.handleMemberAdd(GUILD_B, wireMember(userId(12)));
			GuildMembers.handleMemberRemove(GUILD_B, userId(12));
			leaveGuildA();
			expect(Users.getUser(userId(12))).toBeUndefined();
		});

		it('but frees users once the other guild holding them is deleted', () => {
			pushChunk(GUILD_A, MEMBER_COUNT);
			GuildMembers.handleMemberAdd(GUILD_B, wireMember(userId(12)));
			GuildMembers.handleGuildDelete(GUILD_B);
			leaveGuildA();
			expect(Users.getUser(userId(12))).toBeUndefined();
		});

		it('but forgets holds from before a reconnect', () => {
			GuildMembers.handleMemberAdd(GUILD_B, wireMember(userId(12)));
			GuildMembers.handleGatewayReady([]);
			pushChunk(GUILD_A, MEMBER_COUNT);
			leaveGuildA();
			expect(Users.getUser(userId(12))).toBeUndefined();
		});
	});

	it('leaves small guilds alone', () => {
		pushChunk(GUILD_A, 50);
		selectGuild(GUILD_B);
		runIdleWork();
		expect(GuildMembers.getMemberCount(GUILD_A)).toBe(50);
		expect(Users.getUser(userId(49))).toBeDefined();
	});

	it('never evicts the guild whose channel is still open', () => {
		pushChunk(GUILD_A, 400);
		runInAction(() => {
			Navigation.channelId = CHANNEL_A;
		});
		selectGuild(null);
		runIdleWork();
		expect(GuildMembers.getMemberCount(GUILD_A)).toBe(400);
		GuildMembers.evictInactiveGuild(GUILD_A, new Set());
		expect(GuildMembers.getMemberCount(GUILD_A)).toBe(400);
	});

	describe('off the guild switch path', () => {
		it('defers eviction to idle time instead of running it during the switch', () => {
			pushChunk(GUILD_A, 400);
			selectGuild(GUILD_B);
			expect(GuildMembers.getMemberCount(GUILD_A)).toBe(400);
			runIdleWork();
			expect(GuildMembers.getMemberCount(GUILD_A)).toBeLessThan(400);
		});

		it('skips a deferred eviction when the user returns before it runs', () => {
			pushChunk(GUILD_A, 400);
			selectGuild(GUILD_B);
			selectGuild(GUILD_A);
			runIdleWork();
			expect(GuildMembers.getMemberCount(GUILD_A)).toBe(400);
			expect(Users.getUser(userId(300))).toBeDefined();
		});

		it('keeps a user whose member comes back while the old retains are still being released', () => {
			const returningId = userId(99_999);
			pushChunk(GUILD_A, 100_000);
			selectGuild(GUILD_B);
			runIdleWork(2);
			expect(idleCallbacks.length).toBeGreaterThan(0);
			selectGuild(GUILD_A);
			pushChunk(GUILD_A, 0, [returningId]);
			runIdleWork();
			expect(GuildMembers.getMember(GUILD_A, returningId)).not.toBeNull();
			expect(Users.getUser(returningId)).toBeDefined();
			GuildMembers.handleMemberRemove(GUILD_A, returningId);
			Users.evictUsers([returningId], new Set());
			expect(Users.getUser(returningId)).toBeUndefined();
		});

		it('keeps members that join while an eviction is running', () => {
			pushChunk(GUILD_A, 100_000);
			selectGuild(GUILD_B);
			runIdleWork(3);
			GuildMembers.handleMemberAdd(GUILD_A, wireMember('late-joiner'));
			runIdleWork();
			expect(GuildMembers.getMember(GUILD_A, 'late-joiner')).not.toBeNull();
			expect(Users.getUser('late-joiner')).toBeDefined();
		});

		it(`keeps the switch and the eviction slices of a 100K member guild within ${FRAME_BUDGET_MS} ms`, () => {
			pushChunk(GUILD_A, 100_000);
			// The clock moves only as users are evicted, so the slice budget is checked against the work done,
			// not against how fast or how busy the machine running the test is.
			// Deliberate trade-off: this checks the slicing rule (each slice stops once its budget of evicted users is
			// spent), not real time. Work that removes no user does not move this clock, so a switch or a slice that got
			// slower in real time still passes, and so does a slower per-user eviction, since every evicted user is
			// charged the fixed MS_PER_EVICTED_USER whatever it really costs. Real-time regressions need a profile of the
			// 100K switch on a slow device.
			let now = 0;
			const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
			const stopCharging = observe(Users.users, (change) => {
				if (change.type === 'remove') {
					now += MS_PER_EVICTED_USER;
				}
			});
			onTestFinished(() => {
				stopCharging();
				clock.mockRestore();
			});
			const switchStart = performance.now();
			selectGuild(GUILD_B);
			const switchMs = performance.now() - switchStart;
			const sliceMs = runIdleWork();
			expect(GuildMembers.getMemberCount(GUILD_A)).toBe(0);
			expect(Users.userCount).toBe(1);
			expect(switchMs).toBe(0);
			expect(sliceMs.length).toBeGreaterThan(10);
			expect(Math.max(...sliceMs)).toBeLessThanOrEqual(FRAME_BUDGET_MS);
		});
	});
});
