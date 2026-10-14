// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createMessageID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {
	type GuildRosterEventRow,
	ROSTER_SLOT_COUNT,
	rosterHourOf,
	rosterKeys,
	rosterStartSeconds,
} from '@app/api/database/types/GuildRosterTypes';
import {isGuildRosterLive, rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {
	ROSTER_ANNOUNCE_MINUTE,
	ROSTER_CHECK_MINUTE,
	ROSTER_CHECK_SUBS,
	ROSTER_GUILD_CONCURRENCY,
	ROSTER_JOIN_EMOJI,
	ROSTER_LAG_WARN_MS,
	ROSTER_MOVES_PER_SECOND,
	ROSTER_SLOT_PAGE,
	ROSTER_SLOTS_PER_JOB,
	ROSTER_STATE_TTL_SECONDS,
	ROSTER_TEXT,
} from '@app/api/guild/roster/GuildRosterConstants';
import {
	buildAnnouncement,
	buildMoveWarning,
	buildRolePing,
	buildRosterEmbed,
	rosterComponents,
	splitRoster,
} from '@app/api/guild/roster/GuildRosterEmbed';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {type GuildRosterRef, GuildRosterService} from '@app/api/guild/roster/GuildRosterService';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import {UnknownGuildMemberError} from '@fluxer/errors/src/domains/guild/UnknownGuildMemberError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import type {LoggerInterface} from '@fluxer/logger/src/LoggerInterface';

// GEÇİCİ: one bot and its in-flight read per process, refreshed every 60s. At users read p99 >500ms
// or :25 lag_ms p95 >30s, use a shared bot cache and reuse it in the core initial-reaction user read.
let botUserCache: {id: UserID; expiresAt: number; value: Promise<User>} | undefined;

interface AnnouncementFailure {
	count: number;
	hour: number;
	nextHour: number;
}

export type GuildRosterPhase = 'announce' | 'check';
export interface GuildRosterReactionPayload {
	kind: 'add' | 'remove' | 'clear';
	guild_id: string;
	channel_id: string;
	message_id: string;
	user_id?: string;
	at: number;
}

export interface GuildRosterRunCounts {
	events: number;
	sent: number;
	moved: number;
	kicked: number;
	kept: number;
	warned: number;
	failed: number;
	pingFailed: number;
	room_deleted: number;
}

function isDeletedRoomError(error: unknown): boolean {
	return (
		error instanceof InputValidationError &&
		!!error.getLocalizedErrors()?.some(({code}) => code === ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST)
	);
}

function shouldRemoveAfterMove(error: unknown): boolean {
	// Permission/hierarchy failures keep the member; this is the single removal policy.
	return error instanceof UserNotInVoiceError || error instanceof UnknownGuildMemberError;
}

export class GuildRosterRuntime {
	private readonly repository = new GuildRosterRepository();
	private readonly roster: GuildRosterService;
	constructor(
		private readonly deps: WorkerDependencies,
		private readonly logger: Pick<LoggerInterface, 'info' | 'warn'> = Logger,
	) {
		this.roster = new GuildRosterService(deps);
	}
	async queueSlots(phase: GuildRosterPhase, now: number): Promise<number> {
		if (!isGuildRosterLive(this.deps.limitConfigService)) return 0;
		const phaseMinute = phase === 'announce' ? ROSTER_ANNOUNCE_MINUTE : ROSTER_CHECK_MINUTE;
		const hour = rosterHourOf(now - (phaseMinute - 5) * 60_000);
		let queued = 0;
		for (let slot = 0; slot < ROSTER_SLOT_COUNT; slot += ROSTER_SLOTS_PER_JOB) {
			await this.deps.workerService.addJob(
				'runGuildRosterSlots',
				{phase, hour, slot_start: slot},
				{
					jobKey: `${phase}:${hour}:${slot}`,
					skipLedger: true,
				},
			);
			queued++;
		}
		return queued;
	}
	async runSlots(phase: GuildRosterPhase, hour: number, slotStart: number): Promise<GuildRosterRunCounts> {
		const counts: GuildRosterRunCounts = {
			events: 0,
			sent: 0,
			moved: 0,
			kicked: 0,
			kept: 0,
			warned: 0,
			failed: 0,
			pingFailed: 0,
			room_deleted: 0,
		};
		if (!isGuildRosterLive(this.deps.limitConfigService)) return counts;
		try {
			// GEÇİCİ: 16 slots/job, 16 guilds at a time. At p95 lag >30s or >100k active events,
			// split to one slot/job and a roster worker fleet, then stagger announcements (:24–:26).
			for (let slot = slotStart; slot < slotStart + ROSTER_SLOTS_PER_JOB; slot++) {
				let after: {guildId: GuildID; eventId: bigint} | null = null;
				for (;;) {
					const rows = await this.repository.listSlot(slot, after, ROSTER_SLOT_PAGE);
					const guilds = new Map<GuildID, Set<bigint>>();
					for (const row of rows) {
						let ids = guilds.get(row.guild_id);
						if (!ids) {
							ids = new Set();
							guilds.set(row.guild_id, ids);
						}
						ids.add(row.event_id);
					}
					// Await each bounded page so a guild split across pages is still processed sequentially.
					await mapWithConcurrency([...guilds], ROSTER_GUILD_CONCURRENCY, async ([guildId, ids]) => {
						// Event locks alone let a redelivered job move another event of this guild concurrently.
						const guildLock = phase === 'check' ? {key: `roster:l:guild:${guildId}:check`, token: randomUUID()} : null;
						if (guildLock && !(await this.deps.kvClient.acquireLock(guildLock.key, guildLock.token, 60)))
							throw new ResourceLockedError();
						try {
							let events: Array<GuildRosterEventRow>;
							try {
								events = await this.repository.listByGuild(guildId);
							} catch (error) {
								counts.failed++;
								this.logger.warn({error}, 'Roster guild load failed');
								return;
							}
							for (const event of events) {
								if (!ids.has(event.event_id)) continue;
								counts.events++;
								try {
									if (!isGuildRosterLive(this.deps.limitConfigService)) return;
									if (phase === 'announce') await this.announce(event, hour, counts);
									else await this.check(event, {guildId, eventId: event.event_id, hour}, counts, guildLock!);
								} catch (error) {
									counts.failed++;
									this.logger.warn({error, phase}, 'Roster event failed');
									if (error instanceof ResourceLockedError) throw error;
									if (phase === 'announce' && error instanceof UnknownGuildError) {
										for (const stale of events) await this.repository.delete(guildId, stale.event_id);
										return;
									}
								}
							}
						} finally {
							if (guildLock) await this.deps.kvClient.releaseLock(guildLock.key, guildLock.token);
						}
					});
					if (rows.length < ROSTER_SLOT_PAGE) break;
					const last = rows[rows.length - 1]!;
					after = {guildId: last.guild_id, eventId: last.event_id};
				}
			}
			return counts;
		} finally {
			const minute = phase === 'announce' ? ROSTER_ANNOUNCE_MINUTE : ROSTER_CHECK_MINUTE;
			this.logLag(
				{phase, hour, slot_start: slotStart, ...counts},
				hour * 3_600_000 + minute * 60_000,
				'Roster slot walk done',
				true,
			);
		}
	}
	async syncReaction(payload: GuildRosterReactionPayload): Promise<void> {
		if (!isGuildRosterLive(this.deps.limitConfigService)) return;
		try {
			const messageId = createMessageID(BigInt(payload.message_id));
			const ref = await this.roster.lookupMessage(messageId);
			if (!ref || ref.guildId.toString() !== payload.guild_id) return;
			const state = await this.roster.readState(ref);
			if (!state || state.closed || state.messageId !== messageId || state.channelId.toString() !== payload.channel_id)
				return;
			if (Date.now() >= state.startSeconds * 1000) return;
			const botId = rosterBotUserId();
			const users =
				payload.kind === 'clear'
					? await this.roster.members(ref)
					: payload.user_id
						? [createUserID(BigInt(payload.user_id))]
						: [];
			const buttonMembers = await this.roster.buttonMembers(ref);
			for (const userId of users) {
				// Members who joined with the button leave only with the Leave button during the transition.
				if (userId === botId || buttonMembers.has(userId)) continue;
				const exists = async () =>
					(await this.deps.channelRepository.messageInteractions.checkUserReactionExists(
						state.channelId,
						messageId,
						userId,
						ROSTER_JOIN_EMOJI,
						undefined,
					)) ||
					this.deps.channelRepository.messageInteractions.checkUserReactionExists(
						state.channelId,
						messageId,
						userId,
						`${ROSTER_JOIN_EMOJI}\uFE0F`,
						undefined,
					);
				const reconcile = async (present: boolean) =>
					present ? await this.roster.join(ref, userId, payload.at) : await this.roster.leave(ref, userId);
				const before = await exists();
				await reconcile(before);
				// A removal can race the read/write (including a delayed clear); read once more after writing.
				const after = await exists();
				if (after !== before) await reconcile(after);
			}
			await this.roster.flushRender(ref, Date.now());
		} finally {
			this.logLag({}, payload.at, 'Roster reaction sync done');
		}
	}
	async render(ref: GuildRosterRef, runAt?: number): Promise<void> {
		if (!isGuildRosterLive(this.deps.limitConfigService)) return;
		try {
			await this.renderMessage(ref);
		} finally {
			if (runAt !== undefined) this.logLag({}, runAt, 'Roster render done');
		}
	}
	private async renderMessage(ref: GuildRosterRef, close?: () => Promise<void>): Promise<void> {
		const key = `roster:l:${ref.eventId}:${ref.hour}:render`;
		const token = randomUUID();
		if (!(await this.deps.kvClient.acquireLock(key, token, 10))) throw new ResourceLockedError();
		let pendingRenewal: Promise<void> | undefined;
		let renewalFailure: {error: unknown} | undefined;
		const timer = setInterval(() => {
			if (pendingRenewal || renewalFailure) return;
			pendingRenewal = this.deps.kvClient
				.extendLock(key, token, 10)
				.then(
					(held) => {
						if (!held) renewalFailure = {error: new ResourceLockedError()};
					},
					(error: unknown) => {
						renewalFailure = {error};
					},
				)
				.finally(() => {
					pendingRenewal = undefined;
				});
		}, 3000);
		try {
			await close?.();
			const botId = rosterBotUserId();
			const state = botId ? await this.roster.readState(ref) : null;
			if (state && botId) {
				const lists = state.closed
					? state.final!
					: splitRoster(await this.roster.members(ref), state.mainSize, state.subSize);
				if (renewalFailure) throw renewalFailure.error;
				try {
					await this.deps.channelService.messages.edit.editMessage({
						viewer: {kind: 'user', userId: botId, bot: true, capable: true},
						userId: botId,
						channelId: state.channelId,
						messageId: state.messageId,
						data: {embeds: [buildRosterEmbed({...state, ...lists})]},
						components: rosterComponents(state.closed),
						requestCache: createRequestCache(),
					});
				} catch (error) {
					if (!(error instanceof UnknownMessageError)) throw error;
				}
			}
		} finally {
			clearInterval(timer);
			await pendingRenewal;
			await this.deps.kvClient.releaseLock(key, token);
		}
		if (renewalFailure) throw renewalFailure.error;
	}
	private async announce(event: GuildRosterEventRow, hour: number, counts: GuildRosterRunCounts): Promise<void> {
		const now = Date.now();
		if (!event.enabled || now >= rosterStartSeconds(hour) * 1000) return;
		const botId = rosterBotUserId();
		if (!botId) return;
		// GEÇİCİ: persist the six-hour streak/daily retry (seven-day TTL), but still scan slots hourly.
		// At failed-event share >10% or :25 lag p95 >30s, use bounded due-event repair/scheduling in Fluxer's worker path.
		const failureKey = `roster:f:${event.guild_id}:${event.event_id}:announce`;
		const stored = await this.deps.kvClient.get(failureKey);
		const failure: AnnouncementFailure | null = stored ? JSON.parse(stored) : null;
		if (failure && hour < failure.nextHour) return;
		if (!(await this.deps.kvClient.setnx(rosterKeys.announce(event.event_id, hour), '1', ROSTER_STATE_TTL_SECONDS)))
			return;
		const requestCache = createRequestCache();
		let sent: Awaited<ReturnType<WorkerDependencies['channelService']['messages']['send']['sendMessage']>>;
		try {
			if (!(await this.deps.channelRepository.channelData.findUnique(event.voice_channel_id))) {
				throw InputValidationError.fromCode('voice_channel_id', ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST);
			}
			const botUser = await this.botUser(botId);
			sent = await this.deps.channelService.messages.send.sendMessage({
				viewer: {kind: 'user', userId: botId, bot: true, capable: true},
				user: botUser,
				channelId: event.announce_channel_id,
				data: buildAnnouncement(event, rosterStartSeconds(hour), now),
				components: rosterComponents(false),
				requestCache,
			});
		} catch (error) {
			const permanent =
				error instanceof AccessDeniedError ||
				error instanceof MissingAccessError ||
				error instanceof MissingPermissionsError ||
				error instanceof UnknownChannelError ||
				error instanceof UnknownGuildMemberError ||
				error instanceof UnknownUserError ||
				isDeletedRoomError(error);
			if (permanent) {
				const count = failure && (failure.count >= 6 || failure.hour === hour - 1) ? Math.min(6, failure.count + 1) : 1;
				await this.deps.kvClient.setex(
					failureKey,
					7 * 24 * 60 * 60,
					JSON.stringify({count, hour, nextHour: hour + (count >= 6 ? 24 : 1)} satisfies AnnouncementFailure),
				);
			} else await this.deps.kvClient.del(failureKey);
			throw error;
		}
		await this.deps.kvClient.del(failureKey);
		const {message} = sent;
		counts.sent++;
		await this.roster.open(
			{guildId: event.guild_id, eventId: event.event_id, hour},
			{
				channelId: event.announce_channel_id,
				messageId: message.id,
				name: event.name,
				mainSize: event.main_size,
				subSize: event.sub_size,
				startSeconds: rosterStartSeconds(hour),
				announcedAt: now,
			},
		);
		if (event.mention_role_id) {
			const card = {messageId: message.id, channelId: event.announce_channel_id, guildId: event.guild_id};
			try {
				await this.deps.channelService.messages.send.sendMessage({
					viewer: {kind: 'user', userId: botId, bot: true, capable: true},
					user: await this.botUser(botId),
					channelId: event.announce_channel_id,
					data: buildRolePing(event.mention_role_id, card),
					requestCache,
				});
			} catch (error) {
				counts.pingFailed++;
				this.logger.warn({error}, 'Roster role ping failed');
			}
		}
		try {
			await this.deps.channelService.interactions.addReaction({
				viewer: {kind: 'user', userId: botId, bot: true, capable: true},
				userId: botId,
				channelId: event.announce_channel_id,
				messageId: message.id,
				emoji: ROSTER_JOIN_EMOJI,
				requestCache,
			});
		} catch (error) {
			counts.failed++;
			this.logger.warn({error}, 'Roster initial reaction failed');
		}
	}
	private async check(
		event: GuildRosterEventRow,
		ref: GuildRosterRef,
		counts: GuildRosterRunCounts,
		guildLock: {key: string; token: string},
	): Promise<void> {
		if (Date.now() < rosterStartSeconds(ref.hour) * 1000) throw new ResourceLockedError();
		const botId = rosterBotUserId();
		if (!botId) return;
		const key = rosterKeys.check(ref.eventId, ref.hour);
		const token = randomUUID();
		if (!(await this.deps.kvClient.acquireLock(key, token, 300))) throw new ResourceLockedError();
		try {
			const snapshot = await this.roster.snapshot(ref);
			if (!snapshot || snapshot.state.closed) return;
			const {state, members} = snapshot;
			const lists = splitRoster(members, state.mainSize, state.subSize);
			const removed = new Set<UserID>();
			let kept = 0;
			let targetPermissions = 0;
			let roomDeleted = 0;
			// Deleted events no longer have slot rows; their hourly state expires by TTL. Disabled events close here.
			const targets = event.enabled ? [...lists.main, ...(ROSTER_CHECK_SUBS ? lists.subs : [])] : [];
			for (const userId of targets) {
				if (!isGuildRosterLive(this.deps.limitConfigService)) break;
				if (!(await this.deps.kvClient.extendLock(guildLock.key, guildLock.token, 60))) throw new ResourceLockedError();
				if (!(await this.deps.kvClient.extendLock(key, token, 300))) throw new ResourceLockedError();
				let voice: Awaited<ReturnType<WorkerDependencies['gatewayService']['getVoiceState']>>;
				try {
					voice = await this.deps.gatewayService.getVoiceState({guildId: ref.guildId, userId});
				} catch (error) {
					counts.failed++;
					this.logger.warn({error}, 'Roster voice state read failed');
					continue;
				}
				if (!isGuildRosterLive(this.deps.limitConfigService)) break;
				if (!voice?.channel_id) {
					removed.add(userId);
					counts.kicked++;
					continue;
				}
				if (voice.channel_id === event.voice_channel_id.toString()) continue;
				let attempted = false;
				try {
					const required = Permissions.VIEW_CHANNEL | Permissions.CONNECT;
					const permissions = await this.deps.gatewayService.getUserPermissions({
						guildId: ref.guildId,
						userId,
						channelId: event.voice_channel_id,
					});
					if (!isGuildRosterLive(this.deps.limitConfigService)) break;
					if ((permissions & required) !== required) {
						targetPermissions++;
						kept++;
						counts.kept++;
						continue;
					}
					attempted = true;
					await this.deps.guildService.members.updateMember(
						{
							userId: botId,
							targetId: userId,
							guildId: ref.guildId,
							data: {channel_id: event.voice_channel_id},
							requestCache: createRequestCache(),
						},
						ROSTER_TEXT.auditReason(state.name),
					);
					counts.moved++;
				} catch (error) {
					if (shouldRemoveAfterMove(error)) {
						removed.add(userId);
						counts.kicked++;
					} else {
						if (isDeletedRoomError(error)) {
							roomDeleted++;
							counts.room_deleted++;
						}
						kept++;
						counts.kept++;
						this.logger.warn({error}, 'Roster member could not be moved');
					}
				} finally {
					// GEÇİCİ: sequential moves per guild. At check p95 >30s or gateway p99 >500ms,
					// switch to a guild voice snapshot/batched moves and stagger checks (:34–:36).
					if (attempted) await new Promise((resolve) => setTimeout(resolve, 1000 / ROSTER_MOVES_PER_SECOND));
				}
			}
			try {
				await this.renderMessage(ref, () =>
					this.roster.close(
						ref,
						{main: lists.main.filter((id) => !removed.has(id)), subs: lists.subs.filter((id) => !removed.has(id))},
						token,
					),
				);
			} catch (error) {
				if (error instanceof ResourceLockedError) throw error;
				counts.failed++;
				this.logger.warn({error}, 'Roster closed render failed');
			}
			if (
				kept > 0 &&
				(await this.deps.kvClient.setnx(rosterKeys.warn(ref.eventId, ref.hour), '1', ROSTER_STATE_TTL_SECONDS))
			) {
				const botUser = await this.botUser(botId);
				await this.deps.channelService.messages.send.sendMessage({
					viewer: {kind: 'user', userId: botId, bot: true, capable: true},
					user: botUser,
					channelId: state.channelId,
					data: buildMoveWarning(state.name, kept, {targetPermissions, roomDeleted}),
					requestCache: createRequestCache(),
				});
				counts.warned++;
			}
		} finally {
			await this.deps.kvClient.releaseLock(key, token);
		}
	}
	private async botUser(id: UserID): Promise<User> {
		if (botUserCache?.id === id && Date.now() < botUserCache.expiresAt) return botUserCache.value;
		const cached = {id, expiresAt: Date.now() + 60_000, value: this.deps.userRepository.findUniqueAssert(id)};
		botUserCache = cached;
		try {
			return await cached.value;
		} catch (error) {
			if (botUserCache === cached) botUserCache = undefined;
			throw error;
		}
	}
	private logLag(fields: Record<string, unknown>, scheduledAt: number, message: string, summary = false): void {
		const lag_ms = Math.max(0, Date.now() - scheduledAt);
		if (lag_ms > ROSTER_LAG_WARN_MS) this.logger.warn({...fields, lag_ms}, message);
		else if (summary) this.logger.info({...fields, lag_ms}, message);
	}
}

export function createGuildRosterRuntime(deps: WorkerDependencies): GuildRosterRuntime {
	return new GuildRosterRuntime(deps);
}
