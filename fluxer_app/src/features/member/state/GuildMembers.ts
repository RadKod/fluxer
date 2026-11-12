// SPDX-License-Identifier: AGPL-3.0-or-later

import Channels from '@app/features/channel/state/Channels';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import {selectGuildActivationTarget} from '@app/features/gateway/transport/GuildActivationTarget';
import type {GuildReadyData} from '@app/features/gateway/types/GatewayGuildTypes';
import {GuildMember} from '@app/features/member/models/GuildMember';
import MemberSidebar from '@app/features/member/state/MemberSidebar';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {ChannelMessages} from '@app/features/messaging/state/ChannelMessages';
import MessageReferences from '@app/features/messaging/state/MessageReferences';
import SavedMessages from '@app/features/messaging/state/SavedMessages';
import {collectMessageModelGuildMemberUserIds} from '@app/features/messaging/utils/MessageMemberLoadUtils';
import Navigation from '@app/features/navigation/state/Navigation';
import SelectedGuild from '@app/features/navigation/state/SelectedGuild';
import MentionFeed from '@app/features/notification/state/MentionFeed';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {deferUntilModulesLoaded} from '@app/features/platform/utils/DeferUntilModulesLoaded';
import MemberPresenceSubscription from '@app/features/presence/state/MemberPresenceSubscription';
import Relationships from '@app/features/relationship/state/Relationships';
import UserProfile from '@app/features/user/state/UserProfile';
import Users from '@app/features/user/state/Users';
import voiceEngineV2AppVoiceStateAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppVoiceStateAdapter';
import Webhooks from '@app/features/webhook/state/Webhooks';
import {FLUXERBOT_ID} from '@fluxer/constants/src/AppConstants';
import {LARGE_GUILD_THRESHOLD} from '@fluxer/constants/src/GatewayConstants';
import type {GuildMemberData} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {User as WireUser} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {makeAutoObservable, reaction} from 'mobx';

type Members = Record<string, GuildMember>;

interface PendingMemberRequest {
	guildId: string;
	resolve: (members: Array<GuildMember>) => void;
	reject: (error: Error) => void;
	members: Array<GuildMember>;
	receivedChunks: number;
	requestedUserIds?: Set<string>;
	markMissingAsNonMembers: boolean;
	timeoutId: ReturnType<typeof setTimeout>;
}

const MEMBER_REQUEST_TIMEOUT = 30000;
const MEMBER_NONCE_LENGTH = 32;
const MEMBER_NONCE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_USER_IDS_PER_REQUEST = 100;
const EVICTION_SLICE_BUDGET_MS = 2;
const EVICTION_BATCH_SIZE = 100;
const logger = new Logger('GuildMembers');

function generateMemberNonce(): string {
	let nonce = '';
	const charsLength = MEMBER_NONCE_CHARS.length;
	for (let i = 0; i < MEMBER_NONCE_LENGTH; i += 1) {
		nonce += MEMBER_NONCE_CHARS[Math.floor(Math.random() * charsLength)];
	}
	return nonce;
}

function putMember(members: Members, record: GuildMember, addedUserIds: Array<string>): void {
	const existing = members[record.user.id];
	if (!existing) {
		addedUserIds.push(record.user.id);
	}
	members[record.user.id] = record;
}

// Upstream keeps an unchanged member record so a restored boot state does not re-render every row.
function putMemberData(guildId: string, members: Members, member: GuildMemberData, addedUserIds: Array<string>): void {
	const existing = members[member.user.id];
	if (existing !== undefined && existing.user === Users.getUser(member.user.id) && existing.matches(member)) {
		return;
	}
	putMember(members, new GuildMember(guildId, member, {cacheUser: false}), addedUserIds);
}

function addVoiceStateMembers(guild: GuildReadyData, members: Members, addedUserIds: Array<string>): void {
	if (!guild.voice_states) {
		return;
	}
	const voiceStateMembers: Array<GuildMemberData> = [];
	for (const voiceState of guild.voice_states) {
		if (!voiceState.member) {
			continue;
		}
		voiceStateMembers.push(voiceState.member);
	}
	cacheGuildMemberUsers(voiceStateMembers);
	for (const member of voiceStateMembers) {
		putMemberData(guild.id, members, member, addedUserIds);
	}
}

const INLINE_USER_REFERENCE = /<@!?(\d+)>/g;

function addInlineUserReferences(userIds: Set<string>, content: string | undefined): void {
	if (!content) {
		return;
	}
	for (const match of content.matchAll(INLINE_USER_REFERENCE)) {
		userIds.add(match[1]!);
	}
}

function addMessageUserIds(userIds: Set<string>, messages: ReadonlyArray<Message>, currentUserId: string | null): void {
	for (const message of messages) {
		addInlineUserReferences(userIds, message.content);
		addInlineUserReferences(userIds, message.referencedMessage?.content);
	}
	for (const userId of collectMessageModelGuildMemberUserIds(messages, currentUserId)) {
		userIds.add(userId);
	}
}

function collectVisibleUserIds(guildIds: Iterable<string>): Set<string> {
	const userIds = new Set<string>();
	const currentUserId = Users.currentUserId;
	if (currentUserId) {
		userIds.add(currentUserId);
	}
	for (const guildLists of Object.values(MemberSidebar.lists)) {
		for (const list of Object.values(guildLists)) {
			for (const userId of list.membersByUserId.keys()) {
				userIds.add(userId);
			}
		}
	}
	ChannelMessages.forEach((channelMessages) => {
		const loaded: Array<Message> = [];
		channelMessages.forEachBuffered((message) => loaded.push(message));
		addMessageUserIds(userIds, loaded, currentUserId);
	});
	addMessageUserIds(userIds, SavedMessages.savedMessages, currentUserId);
	addMessageUserIds(userIds, MentionFeed.recentMentions, currentUserId);
	addMessageUserIds(userIds, Array.from(MessageReferences.getReferencedMessages()), currentUserId);
	for (const channels of Object.values(voiceEngineV2AppVoiceStateAdapter.getAllVoiceStates())) {
		for (const voiceStates of Object.values(channels)) {
			for (const voiceState of Object.values(voiceStates)) {
				userIds.add(voiceState.user_id);
			}
		}
	}
	for (const guildId of guildIds) {
		for (const userId of MemberPresenceSubscription.getSubscribedMembers(guildId)) {
			userIds.add(userId);
		}
	}
	for (const userId of Object.keys(UserProfile.profiles)) {
		userIds.add(userId);
	}
	for (const channel of Channels.getPrivateChannels()) {
		for (const userId of channel.recipientIds) {
			userIds.add(userId);
		}
	}
	for (const relationship of Relationships.getRelationships()) {
		userIds.add(relationship.userId);
	}
	for (const webhook of Webhooks.webhooks.values()) {
		userIds.add(webhook.creatorId);
	}
	return userIds;
}

function whenIdle(callback: () => void): void {
	if (typeof requestIdleCallback === 'function') {
		requestIdleCallback(callback, {timeout: 1000});
		return;
	}
	setTimeout(callback, 0);
}

function cacheGuildMemberUsers(members: ReadonlyArray<GuildMemberData>): void {
	if (members.length === 0) {
		return;
	}
	Users.cacheUsers(members.map((member) => member.user));
}

function getMissingVoiceStateMemberUserIds(guild: GuildReadyData, members: Members): Array<string> {
	if (!guild.voice_states || guild.voice_states.length === 0) {
		return [];
	}
	const missingUserIds = new Set<string>();
	for (const voiceState of guild.voice_states) {
		if (voiceState.member) {
			continue;
		}
		if (members[voiceState.user_id]) {
			continue;
		}
		missingUserIds.add(voiceState.user_id);
	}
	return Array.from(missingUserIds);
}

class GuildMembers {
	members: Record<string, Members> = {};
	nonMembers: Record<string, Set<string>> = {};
	pendingRequests: Map<string, PendingMemberRequest> = new Map();
	loadedGuilds: Set<string> = new Set();
	private pendingMemberHydration: Map<string, Set<string>> = new Map();
	private inFlightMemberRequests: Map<string, Set<string>> = new Map();
	private memberRequestGeneration: number = 0;
	private restoredMembers: Map<string, Set<string>> = new Map();
	// The user ids each guild holds a Users retain for; a Set so eviction can walk it across idle slices.
	private retainedUserIds: Map<string, Set<string>> = new Map();
	private evictionTasks: Map<string, object> = new Map();

	constructor() {
		makeAutoObservable<
			this,
			| 'pendingMemberHydration'
			| 'inFlightMemberRequests'
			| 'memberRequestGeneration'
			| 'restoredMembers'
			| 'retainedUserIds'
			| 'evictionTasks'
		>(
			this,
			{
				pendingMemberHydration: false,
				inFlightMemberRequests: false,
				memberRequestGeneration: false,
				restoredMembers: false,
				retainedUserIds: false,
				evictionTasks: false,
			},
			{autoBind: true},
		);
		deferUntilModulesLoaded(() => {
			reaction(
				() => this.activeGuildId,
				(activeGuildId, previousGuildId) => {
					if (activeGuildId) {
						this.evictionTasks.delete(activeGuildId);
					}
					if (previousGuildId && (this.retainedUserIds.get(previousGuildId)?.size ?? 0) >= LARGE_GUILD_THRESHOLD) {
						this.scheduleInactiveGuildEviction(previousGuildId);
					}
				},
			);
		});
	}

	private get activeGuildId(): string | null {
		const channelId = Navigation.channelId;
		return selectGuildActivationTarget({
			selectedGuildId: SelectedGuild.selectedGuildId,
			openChannelGuildId: (channelId ? Channels.getChannel(channelId)?.guildId : null) ?? null,
		});
	}

	// Deferred to idle time so the guild switch itself stays cheap; returning to the guild first cancels it.
	private scheduleInactiveGuildEviction(guildId: string): void {
		const task = {};
		this.evictionTasks.set(guildId, task);
		whenIdle(() => {
			if (this.evictionTasks.get(guildId) === task) {
				this.evictionTasks.delete(guildId);
				this.evictInactiveGuild(guildId, collectVisibleUserIds(Object.keys(this.members)));
			}
		});
	}

	// Costs O(keep), never O(members): the kept records move to a fresh object and the old retains are
	// released over later idle slices, so a 100K member guild is never enumerated in one go.
	evictInactiveGuild(guildId: string, keep: ReadonlySet<string>): void {
		const guildMembers = this.members[guildId];
		const retained = this.retainedUserIds.get(guildId);
		if (!guildMembers || !retained || retained.size < LARGE_GUILD_THRESHOLD || guildId === this.activeGuildId) {
			return;
		}
		const kept: Members = {};
		const stillRetained = new Set<string>();
		const keepMember = (userId: string) => {
			const member = guildMembers[userId];
			if (member) {
				kept[userId] = member;
				if (retained.delete(userId)) {
					stillRetained.add(userId);
				}
			}
		};
		keep.forEach(keepMember);
		const currentUserId = Users.currentUserId;
		if (currentUserId) {
			keepMember(currentUserId);
		}
		this.members[guildId] = kept;
		this.retainedUserIds.set(guildId, stillRetained);
		this.loadedGuilds.delete(guildId);
		const released = retained.values();
		whenIdle(() => this.releaseEvictedUsers(released, keep));
	}

	private releaseEvictedUsers(userIds: Iterator<string>, keep: ReadonlySet<string>): void {
		const deadline = performance.now() + EVICTION_SLICE_BUDGET_MS;
		while (performance.now() < deadline) {
			const batch: Array<string> = [];
			for (let next = userIds.next(); !next.done; next = userIds.next()) {
				batch.push(next.value);
				if (batch.length === EVICTION_BATCH_SIZE) {
					break;
				}
			}
			Users.releaseUsers(batch);
			Users.evictUsers(batch, keep);
			if (batch.length < EVICTION_BATCH_SIZE) {
				return;
			}
		}
		whenIdle(() => this.releaseEvictedUsers(userIds, keep));
	}

	private retainMembers(guildId: string, userIds: ReadonlyArray<string>): void {
		let retained = this.retainedUserIds.get(guildId);
		if (!retained) {
			retained = new Set();
			this.retainedUserIds.set(guildId, retained);
		}
		const added: Array<string> = [];
		for (const userId of userIds) {
			if (!retained.has(userId)) {
				retained.add(userId);
				added.push(userId);
			}
		}
		Users.retainUsers(added);
	}

	getMember(guildId: string, userId?: string | null): GuildMember | null {
		if (!userId) {
			return null;
		}
		return this.members[guildId]?.[userId] ?? null;
	}

	isMembershipKnown(guildId: string, userId?: string | null): boolean {
		if (!userId) {
			return false;
		}
		if (userId === FLUXERBOT_ID || this.members[guildId]?.[userId]) {
			return true;
		}
		return this.nonMembers[guildId]?.has(userId) ?? false;
	}

	isUserTimedOut(guildId: string | null, userId?: string | null): boolean {
		return this.getCommunicationDisabledUntil(guildId, userId) !== null;
	}

	getCommunicationDisabledUntil(guildId: string | null, userId?: string | null): Date | null {
		if (!guildId || !userId) {
			return null;
		}
		const until = this.members[guildId]?.[userId]?.communicationDisabledUntil ?? null;
		if (!until || until.getTime() <= Date.now()) {
			return null;
		}
		return until;
	}

	getMembers(guildId: string): Array<GuildMember> {
		return Object.values(this.members[guildId] ?? {});
	}

	getMemberCount(guildId: string): number {
		return Object.keys(this.members[guildId] ?? {}).length;
	}

	handleGatewayReady(guilds: Array<GuildReadyData>, options: {keepRestoredMembers: boolean}): void {
		const restored = options.keepRestoredMembers ? this.members : {};
		if (!options.keepRestoredMembers) {
			for (const guildId of Array.from(this.retainedUserIds.keys())) {
				this.releaseGuildMembers(guildId);
			}
			this.members = {};
		}
		this.nonMembers = {};
		this.restoredMembers = new Map();
		this.loadedGuilds.clear();
		this.resetMemberRequests();
		const availableGuildIds = new Set(guilds.filter((guild) => !guild.unavailable).map((guild) => guild.id));
		for (const guildId of Object.keys(this.members)) {
			if (!availableGuildIds.has(guildId)) {
				this.releaseGuildMembers(guildId);
				delete this.members[guildId];
			}
		}
		for (const guildId of Array.from(this.pendingMemberHydration.keys())) {
			if (!availableGuildIds.has(guildId)) {
				this.pendingMemberHydration.delete(guildId);
			}
		}
		for (const guild of guilds) {
			this.adoptRestoredMembers(guild, restored[guild.id]);
			this.handleGuildCreate(guild);
		}
	}

	private adoptRestoredMembers(guild: GuildReadyData, restored: Members | undefined): void {
		if (guild.unavailable || restored === undefined) {
			return;
		}
		const live = new Set(guild.members.map((member) => member.user.id));
		const userIds = new Set<string>();
		for (const userId of Object.keys(restored)) {
			if (!live.has(userId)) userIds.add(userId);
		}
		this.members[guild.id] = restored;
		if (userIds.size > 0) this.restoredMembers.set(guild.id, userIds);
	}

	private isRestoredMember(guildId: string, userId: string): boolean {
		return this.restoredMembers.get(guildId)?.has(userId) ?? false;
	}

	private forgetRestoredMember(guildId: string, userId: string): void {
		const restored = this.restoredMembers.get(guildId);
		if (restored === undefined) {
			return;
		}
		restored.delete(userId);
		if (restored.size === 0) {
			this.restoredMembers.delete(guildId);
		}
	}

	handleGuildCreate(guild: GuildReadyData, options?: {synced?: boolean}): void {
		if (guild.unavailable) {
			return;
		}
		if (!this.members[guild.id]) {
			this.members[guild.id] = {};
		}
		delete this.nonMembers[guild.id];
		const members = this.members[guild.id];
		cacheGuildMemberUsers(guild.members);
		const addedUserIds: Array<string> = [];
		for (const member of guild.members) {
			putMemberData(guild.id, members, member, addedUserIds);
			this.forgetRestoredMember(guild.id, member.user.id);
		}
		addVoiceStateMembers(guild, members, addedUserIds);
		this.retainMembers(guild.id, addedUserIds);
		const missingVoiceStateMemberUserIds = getMissingVoiceStateMemberUserIds(guild, members);
		if (missingVoiceStateMemberUserIds.length > 0 && GatewaySessions.foregroundConnection.socket) {
			void this.ensureMembersLoaded(guild.id, missingVoiceStateMemberUserIds).catch((error: unknown) => {
				logger.warn('Failed to fetch missing voice members after guild create', {
					guildId: guild.id,
					userIds: missingVoiceStateMemberUserIds,
					error,
				});
			});
		}
		if (options?.synced || GatewaySessions.foregroundConnection.hasCompletedGuildSync(guild.id)) {
			this.loadedGuilds.add(guild.id);
			void this.requestPendingMembers(guild.id);
		}
	}

	private releaseGuildMembers(guildId: string): void {
		const retained = this.retainedUserIds.get(guildId);
		if (retained) {
			Users.releaseUsers(retained);
			this.retainedUserIds.delete(guildId);
		}
	}

	handleGuildDelete(guildId: string): void {
		this.releaseGuildMembers(guildId);
		delete this.members[guildId];
		delete this.nonMembers[guildId];
		this.restoredMembers.delete(guildId);
		this.pendingMemberHydration.delete(guildId);
		this.inFlightMemberRequests.delete(guildId);
		this.loadedGuilds.delete(guildId);
	}

	handleMemberAdd(guildId: string, member: GuildMemberData): void {
		if (!this.members[guildId]) {
			this.members[guildId] = {};
		}
		this.retainMembers(guildId, [member.user.id]);
		this.members[guildId][member.user.id] = new GuildMember(guildId, member);
		this.nonMembers[guildId]?.delete(member.user.id);
		this.forgetRestoredMember(guildId, member.user.id);
	}

	hydrateIfMissing(guildId: string, member: GuildMemberData): void {
		if (this.members[guildId]?.[member.user.id] && !this.isRestoredMember(guildId, member.user.id)) {
			return;
		}
		if (!this.members[guildId]) {
			this.members[guildId] = {};
		}
		this.members[guildId][member.user.id] = new GuildMember(guildId, member);
		this.retainMembers(guildId, [member.user.id]);
		this.nonMembers[guildId]?.delete(member.user.id);
	}

	hydrateOrRefresh(guildId: string, member: GuildMemberData): void {
		const existing = this.members[guildId]?.[member.user.id];
		if (!existing) {
			this.hydrateIfMissing(guildId, member);
			return;
		}
		Users.handleUserUpdate(member.user as WireUser);
		this.forgetRestoredMember(guildId, member.user.id);
		if (existing.user === Users.getUser(member.user.id) && existing.matches(member)) {
			return;
		}
		this.members[guildId][member.user.id] = new GuildMember(guildId, member);
	}

	handleMemberRemove(guildId: string, userId: string): void {
		this.markAsNonMember(guildId, userId);
		this.forgetRestoredMember(guildId, userId);
		const existingMembers = this.members[guildId];
		if (!existingMembers) {
			return;
		}
		if (this.retainedUserIds.get(guildId)?.delete(userId)) {
			Users.releaseUsers([userId]);
		}
		delete existingMembers[userId];
		if (Object.keys(existingMembers).length === 0) {
			delete this.members[guildId];
		}
	}

	handleGuildRoleDelete(guildId: string, roleId: string): void {
		const existingMembers = this.members[guildId];
		if (!existingMembers) {
			return;
		}
		for (const memberId of Object.keys(existingMembers)) {
			const member = existingMembers[memberId];
			if (member.roles.has(roleId)) {
				const newRoles = new Set(member.roles);
				newRoles.delete(roleId);
				existingMembers[memberId] = new GuildMember(guildId, {
					...member.toJSON(),
					roles: Array.from(newRoles),
				});
			}
		}
	}

	handleMembersChunk(params: {
		guildId: string;
		members: Array<GuildMemberData>;
		chunkIndex: number;
		chunkCount: number;
		nonce?: string;
	}): void {
		const {guildId, members, chunkCount, nonce} = params;
		const newMembers: Array<GuildMember> = [];
		if (!this.members[guildId]) {
			this.members[guildId] = {};
		}
		const guildMembers = this.members[guildId];
		const negativeCache = this.nonMembers[guildId];
		const addedUserIds: Array<string> = [];
		for (const member of members) {
			const record = new GuildMember(guildId, member);
			newMembers.push(record);
			putMember(guildMembers, record, addedUserIds);
			negativeCache?.delete(member.user.id);
			this.forgetRestoredMember(guildId, member.user.id);
		}
		this.retainMembers(guildId, addedUserIds);
		if (nonce) {
			const pending = this.pendingRequests.get(nonce);
			if (pending) {
				pending.members.push(...newMembers);
				pending.receivedChunks++;
				if (pending.receivedChunks >= chunkCount) {
					clearTimeout(pending.timeoutId);
					this.markNotFoundAsNonMembers(pending);
					pending.resolve(pending.members);
					this.pendingRequests.delete(nonce);
				}
			}
		}
	}

	private markNotFoundAsNonMembers(pending: PendingMemberRequest): void {
		if (!pending.markMissingAsNonMembers) {
			return;
		}
		const requested = pending.requestedUserIds;
		if (!requested || requested.size === 0) {
			return;
		}
		const returnedIds = new Set(pending.members.map((record) => record.user.id));
		for (const id of requested) {
			if (returnedIds.has(id)) {
				continue;
			}
			if (this.isRestoredMember(pending.guildId, id)) {
				this.handleMemberRemove(pending.guildId, id);
				continue;
			}
			this.markAsNonMember(pending.guildId, id);
		}
	}

	private markAsNonMember(guildId: string, userId: string): void {
		if (!this.nonMembers[guildId]) {
			this.nonMembers[guildId] = new Set();
		}
		this.nonMembers[guildId].add(userId);
	}

	async fetchMembers(
		guildId: string,
		options?: {
			query?: string;
			limit?: number;
			userIds?: Array<string>;
			presences?: boolean;
			markMissingAsNonMembers?: boolean;
		},
	): Promise<Array<GuildMember>> {
		const userIds = options?.userIds?.filter((userId) => userId !== FLUXERBOT_ID);
		if (options?.userIds?.length && userIds?.length === 0) {
			return [];
		}
		if (userIds && userIds.length > MAX_USER_IDS_PER_REQUEST) {
			const batches: Array<Promise<Array<GuildMember>>> = [];
			for (let i = 0; i < userIds.length; i += MAX_USER_IDS_PER_REQUEST) {
				const slice = userIds.slice(i, i + MAX_USER_IDS_PER_REQUEST);
				batches.push(this.fetchMembers(guildId, {...options, userIds: slice}));
			}
			const results = await Promise.all(batches);
			return results.flat();
		}
		const nonce = generateMemberNonce();
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				if (this.pendingRequests.has(nonce)) {
					this.pendingRequests.delete(nonce);
					reject(new Error('Request timed out'));
				}
			}, MEMBER_REQUEST_TIMEOUT);
			this.pendingRequests.set(nonce, {
				guildId,
				resolve,
				reject,
				members: [],
				receivedChunks: 0,
				requestedUserIds: userIds && userIds.length > 0 ? new Set(userIds) : undefined,
				markMissingAsNonMembers: options?.markMissingAsNonMembers ?? false,
				timeoutId,
			});
			const socket = GatewaySessions.foregroundConnection.socket;
			const requestOptions: {
				guildId: string;
				nonce: string;
				query?: string;
				limit?: number;
				userIds?: Array<string>;
				presences?: boolean;
			} = {
				guildId,
				nonce,
				presences: options?.presences ?? true,
			};
			if (options?.query) {
				requestOptions.query = options.query;
			}
			if (options?.limit !== undefined) {
				requestOptions.limit = options.limit;
			}
			if (userIds && userIds.length > 0) {
				requestOptions.userIds = userIds;
			}
			socket?.requestGuildMembers(requestOptions);
		});
	}

	requestMembersInBackground(options: {
		guildIds: Array<string>;
		query?: string;
		limit?: number;
		presences?: boolean;
	}): void {
		const socket = GatewaySessions.foregroundConnection.socket;
		if (!socket) {
			return;
		}
		const guildIds = [...new Set(options.guildIds.filter((guildId) => guildId.length > 0))];
		if (guildIds.length === 0) {
			return;
		}
		socket.requestGuildMembers({
			guildIds,
			...(options.query !== undefined && {query: options.query}),
			...(options.limit !== undefined && {limit: options.limit}),
			...(options.presences !== undefined && {presences: options.presences}),
		});
	}

	async ensureMembersLoaded(guildId: string, userIds: Array<string>): Promise<void> {
		const missingIds = this.getMissingMemberIds(guildId, userIds);
		if (missingIds.length === 0) {
			return;
		}
		await this.fetchMembers(guildId, {userIds: missingIds, markMissingAsNonMembers: true});
	}

	async hydrateMembers(guildId: string, userIds: Array<string>): Promise<void> {
		const missingIds = this.getMissingMemberIds(guildId, userIds);
		if (missingIds.length === 0) {
			return;
		}
		this.queuePendingMemberHydration(guildId, missingIds);
		if (
			!GatewaySessions.foregroundConnection.hasCompletedGuildSync(guildId) &&
			SelectedGuild.selectedGuildId === guildId
		) {
			GatewaySessions.foregroundConnection.syncGuildIfNeeded(guildId, 'member-hydration');
		}
		await this.requestPendingMembers(guildId);
	}

	handleConnectionResumed(): void {
		this.resetMemberRequests();
		for (const guildId of Array.from(this.pendingMemberHydration.keys())) {
			void this.requestPendingMembers(guildId);
		}
	}

	private resetMemberRequests(): void {
		this.memberRequestGeneration += 1;
		this.inFlightMemberRequests.clear();
	}

	private getMissingMemberIds(guildId: string, userIds: Array<string>): Array<string> {
		const known = this.members[guildId];
		const negativeCache = this.nonMembers[guildId];
		return [...new Set(userIds)].filter(
			(id) => id !== FLUXERBOT_ID && (!known?.[id] || this.isRestoredMember(guildId, id)) && !negativeCache?.has(id),
		);
	}

	private queuePendingMemberHydration(guildId: string, userIds: Array<string>): void {
		let pending = this.pendingMemberHydration.get(guildId);
		if (!pending) {
			pending = new Set();
			this.pendingMemberHydration.set(guildId, pending);
		}
		for (const userId of userIds) {
			pending.add(userId);
		}
	}

	private async requestPendingMembers(guildId: string): Promise<void> {
		if (!GatewaySessions.foregroundConnection.hasCompletedGuildSync(guildId)) {
			return;
		}
		const pending = this.pendingMemberHydration.get(guildId);
		if (!pending || pending.size === 0) {
			return;
		}
		const stillMissing = new Set(this.getMissingMemberIds(guildId, Array.from(pending)));
		for (const userId of Array.from(pending)) {
			if (!stillMissing.has(userId)) {
				pending.delete(userId);
			}
		}
		if (pending.size === 0) {
			this.pendingMemberHydration.delete(guildId);
			return;
		}
		let inFlight = this.inFlightMemberRequests.get(guildId);
		if (!inFlight) {
			inFlight = new Set();
			this.inFlightMemberRequests.set(guildId, inFlight);
		}
		const userIds = Array.from(pending).filter((userId) => !inFlight.has(userId));
		if (userIds.length === 0) {
			return;
		}
		for (const userId of userIds) {
			inFlight.add(userId);
		}
		const generation = this.memberRequestGeneration;
		try {
			await this.fetchMembers(guildId, {userIds, markMissingAsNonMembers: true});
			if (generation === this.memberRequestGeneration) {
				this.forgetPendingMembers(guildId, userIds);
			}
		} catch (error) {
			logger.warn('Failed to hydrate members, will retry on the next load or reconnect', {
				guildId,
				userIds,
				error,
			});
		} finally {
			if (generation === this.memberRequestGeneration) {
				this.releaseInFlightMembers(guildId, userIds);
			}
		}
	}

	private forgetPendingMembers(guildId: string, userIds: Array<string>): void {
		const pending = this.pendingMemberHydration.get(guildId);
		if (!pending) {
			return;
		}
		for (const userId of userIds) {
			pending.delete(userId);
		}
		if (pending.size === 0) {
			this.pendingMemberHydration.delete(guildId);
		}
	}

	private releaseInFlightMembers(guildId: string, userIds: Array<string>): void {
		const inFlight = this.inFlightMemberRequests.get(guildId);
		if (!inFlight) {
			return;
		}
		for (const userId of userIds) {
			inFlight.delete(userId);
		}
		if (inFlight.size === 0) {
			this.inFlightMemberRequests.delete(guildId);
		}
	}

	isGuildFullyLoaded(guildId: string): boolean {
		return this.loadedGuilds.has(guildId);
	}
}

export default new GuildMembers();
