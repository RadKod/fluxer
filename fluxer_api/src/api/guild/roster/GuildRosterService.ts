// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {
	type ChannelID,
	createChannelID,
	createGuildID,
	createMessageID,
	createUserID,
	type EmojiID,
	type GuildID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {rosterKeys} from '@app/api/database/types/GuildRosterTypes';
import {
	ROSTER_RENDER_WINDOW_MS,
	ROSTER_STATE_TTL_SECONDS,
	ROSTER_WAITLIST_MAX,
} from '@app/api/guild/roster/GuildRosterConstants';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';

export interface GuildRosterRef {
	guildId: GuildID;
	eventId: bigint;
	hour: number;
}
export interface GuildRosterOpenState {
	channelId: ChannelID;
	messageId: MessageID;
	name: string;
	mainSize: number;
	subSize: number;
	startSeconds: number;
	announcedAt: number;
}
// A Join or Leave button click: the card it came from. Join marks the member in the same write as the roster change.
export interface GuildRosterClick {
	messageId: MessageID;
}
export interface GuildRosterFinal {
	main: Array<UserID>;
	subs: Array<UserID>;
}
export interface GuildRosterState extends GuildRosterOpenState {
	closed: boolean;
	final: GuildRosterFinal | null;
}
export type GuildRosterReactionChange =
	| {
			kind: 'add' | 'remove';
			guildId: GuildID | null;
			channelId: ChannelID;
			messageId: MessageID;
			authorId: UserID | null;
			userId: UserID;
			emojiName: string;
			emojiId: EmojiID | undefined;
			atMs: number;
	  }
	| {
			kind: 'clear';
			guildId: GuildID | null;
			channelId: ChannelID;
			messageId: MessageID;
			authorId: UserID | null;
			emojiName: string | null;
			emojiId: EmojiID | undefined;
			atMs: number;
	  };

export class GuildRosterService {
	constructor(private readonly deps: Pick<WorkerDependencies, 'kvClient' | 'workerService'>) {}
	async open(ref: GuildRosterRef, state: GuildRosterOpenState): Promise<void> {
		await this.writeState(ref, {...state, closed: false, final: null});
		await this.deps.kvClient.setex(
			rosterKeys.message(state.messageId),
			ROSTER_STATE_TTL_SECONDS,
			`${ref.guildId}:${ref.eventId}:${ref.hour}`,
		);
	}
	async lookupMessage(messageId: MessageID): Promise<GuildRosterRef | null> {
		const value = await this.deps.kvClient.get(rosterKeys.message(messageId));
		if (!value) return null;
		const [guildId, eventId, hour] = value.split(':');
		return {guildId: createGuildID(BigInt(guildId!)), eventId: BigInt(eventId!), hour: Number(hour)};
	}
	async readState(ref: GuildRosterRef): Promise<GuildRosterState | null> {
		const value = await this.deps.kvClient.get(rosterKeys.state(ref.eventId, ref.hour));
		if (!value) return null;
		const state = JSON.parse(value) as Omit<GuildRosterState, 'channelId' | 'messageId' | 'final'> & {
			guildId: string;
			channelId: string;
			messageId: string;
			final: {main: Array<string>; subs: Array<string>} | null;
		};
		if (state.guildId !== ref.guildId.toString()) return null;
		return {
			...state,
			channelId: createChannelID(BigInt(state.channelId)),
			messageId: createMessageID(BigInt(state.messageId)),
			final: state.final
				? {
						main: state.final.main.map((id) => createUserID(BigInt(id))),
						subs: state.final.subs.map((id) => createUserID(BigInt(id))),
					}
				: null,
		};
	}
	async members(ref: GuildRosterRef): Promise<Array<UserID>> {
		return (await this.deps.kvClient.zrangebyscore(rosterKeys.members(ref.eventId, ref.hour), '-inf', '+inf')).map(
			(id) => createUserID(BigInt(id)),
		);
	}
	async snapshot(ref: GuildRosterRef): Promise<{state: GuildRosterState; members: Array<UserID>} | null> {
		return this.withLock(ref, undefined, async () => {
			const state = await this.readState(ref);
			return state ? {state, members: await this.members(ref)} : null;
		});
	}
	async join(
		ref: GuildRosterRef,
		userId: UserID,
		atMs: number,
		click?: GuildRosterClick,
	): Promise<'joined' | 'already' | 'busy' | 'full' | 'closed' | 'unknown'> {
		// Lock-free first: in the :25 rush most extra joins repeat one or hit a full or closed roster. That answer was true
		// when read; a join that may write checks again under the lock.
		const known = await this.joinBlocker(ref, userId, click);
		if (typeof known === 'string') return known;
		return this.withLock(ref, click, async () => {
			const blocker = await this.joinBlocker(ref, userId, click);
			if (typeof blocker === 'string') return blocker;
			const reservationKey = this.reservationKey(ref, userId);
			if (
				!(await this.deps.kvClient.setnx(reservationKey, ref.eventId.toString(), ROSTER_STATE_TTL_SECONDS)) &&
				(await this.deps.kvClient.get(reservationKey)) !== ref.eventId.toString()
			)
				return 'busy';
			// Keep the reservation if EXEC fails: an uncertain write may already have added the member.
			const key = rosterKeys.members(ref.eventId, ref.hour);
			const write = this.deps.kvClient
				.multi()
				.setex(this.pendingRenderKey(ref), ROSTER_STATE_TTL_SECONDS, randomUUID())
				.zadd(key, atMs, userId.toString())
				.expire(key, ROSTER_STATE_TTL_SECONDS);
			// The button mark rides in the roster write, so no reaction sync sees a button member without it.
			if (click)
				write.sadd(this.buttonKey(ref), userId.toString()).expire(this.buttonKey(ref), ROSTER_STATE_TTL_SECONDS);
			for (const [error] of await write.exec()) if (error) throw error;
			return 'joined';
		});
	}
	async leave(
		ref: GuildRosterRef,
		userId: UserID,
		click?: GuildRosterClick,
	): Promise<'left' | 'absent' | 'closed' | 'unknown'> {
		return this.withLock(ref, click, async () => {
			const state = await this.openState(ref, click);
			if (typeof state === 'string') return state;
			// A reaction sync read the marks before waiting for this lock; a Join click may have marked the member since.
			if (!click && (await this.deps.kvClient.sismember(this.buttonKey(ref), userId.toString())) === 1) return 'absent';
			const present = (await this.members(ref)).includes(userId);
			if (present) {
				const key = rosterKeys.members(ref.eventId, ref.hour);
				try {
					const results = await this.deps.kvClient
						.multi()
						.setex(this.pendingRenderKey(ref), ROSTER_STATE_TTL_SECONDS, randomUUID())
						.zrem(key, userId.toString())
						.expire(key, ROSTER_STATE_TTL_SECONDS)
						// The mark leaves with the member; a reaction member has none.
						.srem(this.buttonKey(ref), userId.toString())
						.exec();
					for (const [error] of results) if (error) throw error;
				} catch (error) {
					try {
						// A clear retry cannot enumerate a removed member after an uncertain EXEC response.
						if (!(await this.members(ref)).includes(userId))
							await this.deps.kvClient.releaseLock(this.reservationKey(ref, userId), ref.eventId.toString());
					} catch {
						// Preserve the original transaction failure so the worker still retries.
					}
					throw error;
				}
			}
			// An absent retry must still release an owned reservation after an uncertain removal.
			await this.deps.kvClient.releaseLock(this.reservationKey(ref, userId), ref.eventId.toString());
			return present ? 'left' : 'absent';
		});
	}
	async clear(ref: GuildRosterRef): Promise<void> {
		await this.withLock(ref, undefined, async () => {
			const state = await this.readState(ref);
			if (!state || state.closed || Date.now() >= state.startSeconds * 1000) return;
			const members = await this.members(ref);
			if (members.length === 0) return;
			const results = await this.deps.kvClient
				.multi()
				.setex(this.pendingRenderKey(ref), ROSTER_STATE_TTL_SECONDS, randomUUID())
				.del(rosterKeys.members(ref.eventId, ref.hour))
				.exec();
			for (const [error] of results) if (error) throw error;
			await Promise.all(
				members.map((userId) =>
					this.deps.kvClient.releaseLock(this.reservationKey(ref, userId), ref.eventId.toString()),
				),
			);
		});
	}
	async close(ref: GuildRosterRef, final: GuildRosterFinal, lockToken?: string): Promise<void> {
		await this.withLock(ref, undefined, async () => {
			if (lockToken && !(await this.deps.kvClient.extendLock(rosterKeys.check(ref.eventId, ref.hour), lockToken, 300)))
				throw new ResourceLockedError();
			const state = await this.readState(ref);
			if (!state || state.closed) return;
			await this.writeState(ref, {...state, closed: true, final});
			await this.refreshMembers(ref);
		});
	}
	// Members who joined with the button; the reaction sync never drops them while both ways work.
	// Bounded by the roster capacity (main + subs + waitlist), so one SMEMBERS per sync.
	async buttonMembers(ref: GuildRosterRef): Promise<Set<UserID>> {
		return new Set((await this.deps.kvClient.smembers(this.buttonKey(ref))).map((id) => createUserID(BigInt(id))));
	}
	async scheduleRender(ref: GuildRosterRef, nowMs: number): Promise<void> {
		const window = Math.floor(nowMs / ROSTER_RENDER_WINDOW_MS);
		const runAt = (window + 1) * ROSTER_RENDER_WINDOW_MS;
		await this.deps.workerService.addJob(
			'renderGuildRosterMessage',
			{
				guild_id: ref.guildId.toString(),
				event_id: ref.eventId.toString(),
				hour: ref.hour,
				run_at: runAt,
			},
			{jobKey: `${ref.eventId}:${ref.hour}:${window}`, runAt: new Date(runAt), skipLedger: true},
		);
	}
	async flushRender(ref: GuildRosterRef, nowMs: number): Promise<void> {
		const key = this.pendingRenderKey(ref);
		const token = await this.deps.kvClient.get(key);
		if (!token) return;
		await this.scheduleRender(ref, nowMs);
		await this.deps.kvClient.releaseLock(key, token);
	}
	private async writeState(ref: GuildRosterRef, state: GuildRosterState): Promise<void> {
		await this.deps.kvClient.setex(
			rosterKeys.state(ref.eventId, ref.hour),
			ROSTER_STATE_TTL_SECONDS,
			JSON.stringify({guildId: ref.guildId, ...state}, (_key, value) =>
				typeof value === 'bigint' ? value.toString() : value,
			),
		);
	}
	private async refreshMembers(ref: GuildRosterRef): Promise<void> {
		await this.deps.kvClient.expire(rosterKeys.members(ref.eventId, ref.hour), ROSTER_STATE_TTL_SECONDS);
	}
	// The open roster, or why it cannot change: unknown (expired, or the click came from another card) or closed.
	private async openState(
		ref: GuildRosterRef,
		click?: GuildRosterClick,
	): Promise<GuildRosterState | 'unknown' | 'closed'> {
		const state = await this.readState(ref);
		if (!state || (click && state.messageId !== click.messageId)) return 'unknown';
		return state.closed || Date.now() >= state.startSeconds * 1000 ? 'closed' : state;
	}
	// Why this member cannot join, or the open roster when they can.
	private async joinBlocker(
		ref: GuildRosterRef,
		userId: UserID,
		click?: GuildRosterClick,
	): Promise<GuildRosterState | 'already' | 'full' | 'unknown' | 'closed'> {
		const state = await this.openState(ref, click);
		if (typeof state === 'string') return state;
		const key = rosterKeys.members(ref.eventId, ref.hour);
		const [rank, size] = await Promise.all([
			this.deps.kvClient.zrevrank(key, userId.toString()),
			this.deps.kvClient.zcard(key),
		]);
		if (rank !== null) return 'already';
		return size >= state.mainSize + state.subSize + ROSTER_WAITLIST_MAX ? 'full' : state;
	}
	private reservationKey(ref: GuildRosterRef, userId: UserID): string {
		return `roster:u:${ref.guildId}:${ref.hour}:${userId}`;
	}
	private buttonKey(ref: GuildRosterRef): string {
		return `roster:b:${ref.eventId}:${ref.hour}`;
	}
	private pendingRenderKey(ref: GuildRosterRef): string {
		return `roster:d:${ref.eventId}:${ref.hour}`;
	}
	// A worker job waits up to 2 s (80 × 25 ms); a click at most 8 jittered waits (≤ 0.4 s) so a rush neither holds
	// HTTP requests nor retries in step (ponytail note in GuildRosterComponents).
	private async withLock<T>(
		ref: GuildRosterRef,
		click: GuildRosterClick | undefined,
		work: () => Promise<T>,
	): Promise<T> {
		const key = `roster:l:${ref.eventId}:${ref.hour}:mutate`;
		const token = randomUUID();
		for (let retries = 0; !(await this.deps.kvClient.acquireLock(key, token, 10)); retries++) {
			if (retries === (click ? 8 : 80)) throw new ResourceLockedError();
			await new Promise((resolve) => setTimeout(resolve, click ? 25 + Math.random() * 25 : 25));
		}
		try {
			return await work();
		} finally {
			await this.deps.kvClient.releaseLock(key, token);
		}
	}
}
