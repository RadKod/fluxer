// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {GatewayVoiceStateEntry, IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {resolveEffectiveVoiceRoomTheme} from '@app/api/voice_seat/VoiceRoomTheme';
import {
	VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW,
	VOICE_SEAT_CHANNEL_WINDOW_S,
	VOICE_SEAT_GONE_TTL_S,
} from '@app/api/voice_seat/VoiceSeatLimits';
import type {
	VoiceSeatRepository,
	VoiceSeatTakeMode,
	VoiceSeatTakeResult,
} from '@app/api/voice_seat/VoiceSeatRepository';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	isVoiceRoomTheme,
	parseSeatName,
	tableSeatName,
	themeLoungeSeats,
	themeWatchSeats,
	VOICE_SEAT_ATTRIBUTE,
	type VoiceRoomTheme,
} from '@fluxer/constants/src/VoiceRoomThemes';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import {TableGameConflictError} from '@fluxer/errors/src/domains/voice/TableGameConflictError';
import {VoiceSeatTakenError} from '@fluxer/errors/src/domains/voice/VoiceSeatTakenError';
import {VoiceSeatUnknownError} from '@fluxer/errors/src/domains/voice/VoiceSeatUnknownError';
import {resolveVoiceRoomAssignment} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';

export interface VoiceParticipantContext {
	guildId: GuildID;
	channelId: ChannelID;
	userId: UserID;
	connectionId: string;
	regionId: string | null;
	serverId: string | null;
}

export interface VoiceSeatServiceDeps {
	repository: VoiceSeatRepository;
	instanceConfigRepository: InstanceConfigRepository;
	channelAuthService: ChannelAuthService;
	gatewayService: IGatewayService;
	liveKitService: ILiveKitService;
}

// What the join hook looks up only when rooms are on: the channel theme and the user's active table seat.
// An undefined theme means the channel is missing or is not a guild voice channel.
export interface VoiceSeatJoinLookups {
	roomTheme(): Promise<string | null | undefined>;
	tableSeat(): Promise<string | null>;
}

interface VoiceLocation {
	regionId: string | null;
	serverId: string | null;
}

interface SeatRef {
	guildId: GuildID;
	channelId: ChannelID;
	identity: string;
}

type VoiceStateReader = () => Promise<ReadonlyArray<GatewayVoiceStateEntry> | null>;

const IDENTITY_PATTERN = /^user_(\d+)_(.+)$/;

function voiceIdentity(userId: UserID | string, connectionId: string): string {
	return `user_${userId}_${connectionId}`;
}

function parseIdentity(identity: string): {userId: UserID; connectionId: string} | null {
	const match = IDENTITY_PATTERN.exec(identity);
	return match ? {userId: createUserID(BigInt(match[1]!)), connectionId: match[2]!} : null;
}

function joinMarkValue(userId: UserID | string, location: VoiceLocation): string {
	return `${userId}|${location.regionId ?? ''}|${location.serverId ?? ''}`;
}

function parseJoinMark(mark: string | null): {userId: string; regionId: string; serverId: string} | null {
	const parts = mark?.split('|');
	return parts?.length === 3 ? {userId: parts[0]!, regionId: parts[1]!, serverId: parts[2]!} : null;
}

// Candidates of an auto/join take and of an explicit pick: the lounge seats, then the watch seats, which the take
// script keeps for their holder but gives out on an explicit pick alone.
function themeSeats(theme: VoiceRoomTheme): ReadonlyArray<string> {
	return [...themeLoungeSeats(theme), ...themeWatchSeats(theme)];
}

function seated(result: VoiceSeatTakeResult): string | null {
	return result.status === 'ok' || result.status === 'same' ? result.seat : null;
}

// The seat truth is the {voice_seats:<channel_id>} hash; the LiveKit seat attribute (VOICE_SEAT_ATTRIBUTE) only carries
// it to the room and is written by this server alone (voice tokens never let a participant edit its own metadata).
// Standing participants get no attribute; a participant pushed off a seat gets it removed.
export class VoiceSeatService {
	constructor(readonly deps: VoiceSeatServiceDeps) {}

	async takeSeat(p: {
		userId: UserID;
		channelId: ChannelID;
		connectionId: string;
		seat: string | null;
	}): Promise<{seat: string | null}> {
		const {channel, games, theme} = await this.authorizeVoiceChannel(p.userId, p.channelId);
		if (!isVoiceRoomTheme(theme)) throw new VoiceSeatUnknownError();
		const lounge = themeLoungeSeats(theme);
		const seats = themeSeats(theme);
		// watch seats are the table games'; while games are off no pick reaches them.
		if (p.seat !== null && !(games ? seats : lounge).includes(p.seat)) throw new VoiceSeatUnknownError();
		const guildId = channel.guildId!;
		const readVoiceStates = this.voiceStateReader(guildId, p.channelId);
		const location = await this.checkMembership({...p, guildId}, readVoiceStates);
		if (!location) throw new UserNotInVoiceError();
		const {repository} = this.deps;
		const identity = voiceIdentity(p.userId, p.connectionId);
		const ref = {guildId, channelId: p.channelId, identity};

		if (p.seat !== null) {
			const holder = await repository.userIdentity(p.channelId, p.userId);
			const current = holder ? await repository.seatOf(p.channelId, holder) : null;
			if (current && parseSeatName(current)?.kind === 'table') throw new TableGameConflictError();
			const seat = p.seat;
			const take = () =>
				this.restTake({channelId: p.channelId, identity, userId: p.userId, mode: 'explicit', seats: [seat]});
			let result = await take();
			if (result.status === 'taken' && (await this.releaseGhostHolder(ref, seat, readVoiceStates))) {
				result = await take();
			}
			if (result.status === 'taken') throw new VoiceSeatTakenError();
			await this.publishTake(ref, result, location);
			return {seat: seated(result)};
		}

		const auto = () => this.restTake({channelId: p.channelId, identity, userId: p.userId, mode: 'auto', seats});
		let result = await auto();
		if (result.status === 'user_elsewhere') {
			result = await this.takeOverFromAbsentIdentity(ref, p.userId, readVoiceStates, auto);
		} else if (result.status === 'full' && (await this.reconcileSeats(guildId, p.channelId, lounge, readVoiceStates))) {
			result = await auto();
		}
		await this.publishTake(ref, result, location);
		return {seat: seated(result)};
	}

	// a REST seat request runs under the channel's change budget, so the seat changes reaching the
	// whole room stay bounded however many members ask; only a real change spends it (the take script), and the
	// membership check comes first, so a non-member never touches it.
	private async restTake(p: {
		channelId: ChannelID;
		identity: string;
		userId: UserID;
		mode: VoiceSeatTakeMode;
		seats: ReadonlyArray<string>;
	}): Promise<VoiceSeatTakeResult> {
		const result = await this.deps.repository.take({...p, limited: true});
		if (result.status !== 'limited') return result;
		throw new RateLimitError({
			retryAfter: VOICE_SEAT_CHANNEL_WINDOW_S,
			limit: VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW,
			resetTime: new Date(Date.now() + VOICE_SEAT_CHANNEL_WINDOW_S * 1000),
			scope: 'shared',
		});
	}

	// O(1) voice membership: the j:<identity> mark written on the confirmed LiveKit join. When it is missing, one
	// gateway voice-state read per channel per 30 s decides, and a present connection gets its mark back.
	async membership(p: {
		guildId: GuildID;
		channelId: ChannelID;
		userId: UserID;
		connectionId: string;
	}): Promise<{regionId: string; serverId: string} | null> {
		return this.checkMembership(p, this.voiceStateReader(p.guildId, p.channelId));
	}

	async seatAtTable(p: {
		userId: UserID;
		guildId: GuildID;
		channelId: ChannelID;
		slot: string;
		position: TablePosition;
		voiceStates: ReadonlyArray<GatewayVoiceStateEntry>;
	}): Promise<void> {
		const entry = p.voiceStates.find((state) => state.userId === p.userId.toString());
		if (!entry) return;
		const identity = voiceIdentity(p.userId, entry.connectionId);
		const ref = {guildId: p.guildId, channelId: p.channelId, identity};
		const seat = tableSeatName(p.slot, p.position);
		const {repository} = this.deps;
		const take = () =>
			repository.take({channelId: p.channelId, identity, userId: p.userId, mode: 'explicit', seats: [seat]});
		let result = await take();
		if (result.status === 'taken') {
			// The table game owns its positions; a hash holder left over from an earlier game gives way.
			const holder = await repository.holderOf(p.channelId, seat);
			const stale = holder ? parseIdentity(holder) : null;
			if (holder && stale) {
				await repository.vacate({channelId: p.channelId, identity: holder, userId: stale.userId});
				await this.publishSeat({...ref, identity: holder}, '');
			}
			result = await take();
		}
		await this.publishTake(ref, result, {regionId: entry.regionId ?? null, serverId: entry.serverId ?? null});
	}

	async leaveTableSeat(p: {
		userId: UserID;
		guildId: GuildID;
		channelId: ChannelID;
		voiceStates: ReadonlyArray<GatewayVoiceStateEntry> | null;
	}): Promise<void> {
		const {repository} = this.deps;
		const identity = await repository.userIdentity(p.channelId, p.userId);
		const current = identity ? await repository.seatOf(p.channelId, identity) : null;
		if (!identity || !current || parseSeatName(current)?.kind !== 'table') return;
		await repository.vacate({channelId: p.channelId, identity, userId: p.userId});
		// V1: an identity with no j: mark has left the channel; it only loses the table seat.
		if (!(await repository.joinMark(p.channelId, identity))) return;
		const result = await repository.take({
			channelId: p.channelId,
			identity,
			userId: p.userId,
			mode: 'auto',
			seats: await this.themeSeatsFor(p.userId, p.channelId),
		});
		const entry = p.voiceStates?.find((state) => voiceIdentity(state.userId, state.connectionId) === identity);
		const ref = {guildId: p.guildId, channelId: p.channelId, identity};
		await this.publishSeat(
			ref,
			seated(result) ?? '',
			entry ? {regionId: entry.regionId ?? null, serverId: entry.serverId ?? null} : undefined,
		);
	}

	async onParticipantJoined(
		ctx: VoiceParticipantContext,
		lookups: VoiceSeatJoinLookups,
		signal?: AbortSignal,
	): Promise<void> {
		const config = await this.deps.instanceConfigRepository.getVoiceRoomConfig();
		const assignment = resolveVoiceRoomAssignment(config);
		if (!assignment.rooms) return;
		// TEMPORARY: one Cassandra channel read per confirmed join (rooms on only); ~10–20 k reads/s at 10M.
		// Trigger: webhook joins > 2 k/s or webhook p99 > 200 ms. Path: per-channel theme KV cache
		// {voice_seats:<channel_id>}:theme, deleted on CHANNEL_UPDATE.
		const roomTheme = await lookups.roomTheme();
		if (roomTheme === undefined) return;
		// The join lookup only returns a theme for a guild voice channel.
		const theme = resolveEffectiveVoiceRoomTheme(roomTheme, config, ChannelTypes.GUILD_VOICE);
		if (!isVoiceRoomTheme(theme)) return;
		const tableSeat = assignment.games ? await lookups.tableSeat() : null;
		// A timed-out hook (aborted signal) stops before its next KV or LiveKit write. The one exception is the attribute
		// of a seat this hook has just taken, so a timeout never leaves a seat without its attribute.
		signal?.throwIfAborted();
		const lounge = themeLoungeSeats(theme);
		const seats = themeSeats(theme);
		const identity = voiceIdentity(ctx.userId, ctx.connectionId);
		const ref = {guildId: ctx.guildId, channelId: ctx.channelId, identity};
		const take = (mode: 'join' | 'auto') =>
			this.deps.repository.take({
				channelId: ctx.channelId,
				identity,
				userId: ctx.userId,
				mode,
				joinValue: joinMarkValue(ctx.userId, ctx),
				seats: tableSeat ? [tableSeat, ...seats] : seats,
			});
		let result = await take('join');
		if (
			result.status === 'full' &&
			(await this.reconcileSeats(
				ctx.guildId,
				ctx.channelId,
				lounge,
				this.voiceStateReader(ctx.guildId, ctx.channelId, signal),
				signal,
			))
		) {
			signal?.throwIfAborted();
			result = await take('auto');
		}
		await this.publishTake(ref, result, ctx, signal);
	}

	// The release does not depend on the rooms switch (V1): marks and seats written while rooms were on still go when
	// their connection leaves; on a channel with no seat hash it writes nothing. The join and leave hooks run unordered:
	// while join hooks write (rooms on), a leave that beats its join leaves a tombstone the join respects.
	async onParticipantLeft(ctx: VoiceParticipantContext, signal?: AbortSignal): Promise<void> {
		const config = await this.deps.instanceConfigRepository.getVoiceRoomConfig();
		signal?.throwIfAborted();
		const {seat, heir} = await this.deps.repository.release({
			channelId: ctx.channelId,
			identity: voiceIdentity(ctx.userId, ctx.connectionId),
			userId: ctx.userId,
			goneTtlS: resolveVoiceRoomAssignment(config).rooms ? VOICE_SEAT_GONE_TTL_S : 0,
		});
		if (seat && heir) {
			await this.publishSeat({guildId: ctx.guildId, channelId: ctx.channelId, identity: heir}, seat, undefined, signal);
		}
	}

	// The gateway voice_state_remove: the connection's j: mark goes at once, so no later check counts it in the channel;
	// its seat and l: wait for the leave webhook or the ghost-seat checks.
	async onVoiceStateRemoved(ctx: VoiceParticipantContext): Promise<void> {
		await this.deps.repository.dropJoinMark(ctx.channelId, voiceIdentity(ctx.userId, ctx.connectionId));
	}

	async onRoomFinished(channelId: ChannelID): Promise<void> {
		await this.deps.repository.deleteChannel(channelId);
	}

	private async checkMembership(
		p: {guildId: GuildID; channelId: ChannelID; userId: UserID; connectionId: string},
		readVoiceStates: VoiceStateReader,
	): Promise<{regionId: string; serverId: string} | null> {
		const identity = voiceIdentity(p.userId, p.connectionId);
		const mark = parseJoinMark(await this.deps.repository.joinMark(p.channelId, identity));
		if (mark) {
			return mark.userId === p.userId.toString() ? {regionId: mark.regionId, serverId: mark.serverId} : null;
		}
		const states = await readVoiceStates();
		const entry = states?.find(
			(state) =>
				state.userId === p.userId.toString() &&
				state.connectionId === p.connectionId &&
				state.channelId === p.channelId.toString(),
		);
		return entry ? {regionId: entry.regionId ?? '', serverId: entry.serverId ?? ''} : null;
	}

	// The user's other identity holds the seat. If voice states show it gone (page reload with a lost leave), release
	// it: the seat passes to the user's latest joined identity, normally this one.
	private async takeOverFromAbsentIdentity(
		ref: SeatRef,
		userId: UserID,
		readVoiceStates: VoiceStateReader,
		auto: () => Promise<VoiceSeatTakeResult>,
	): Promise<VoiceSeatTakeResult> {
		const standing: VoiceSeatTakeResult = {seat: null, status: 'user_elsewhere', freed: null};
		const other = await this.deps.repository.userIdentity(ref.channelId, userId);
		if (!other || other === ref.identity) return standing;
		const states = await readVoiceStates();
		if (!states || states.some((state) => voiceIdentity(state.userId, state.connectionId) === other)) return standing;
		const {seat, heir} = await this.deps.repository.release({channelId: ref.channelId, identity: other, userId});
		if (seat && heir === ref.identity) return {seat, status: 'ok', freed: null};
		if (seat && heir) {
			await this.publishSeat({...ref, identity: heir}, seat);
			return standing;
		}
		return auto();
	}

	// V1: an explicit pick frees a holder the voice states (same 30 s lock) do not list, or, with the lock taken, one
	// with no j: mark; its attribute is removed once and the seat may pass to the holder user's own present heir.
	// True when it was released.
	private async releaseGhostHolder(ref: SeatRef, seat: string, readVoiceStates: VoiceStateReader): Promise<boolean> {
		const {repository} = this.deps;
		const holder = await repository.holderOf(ref.channelId, seat);
		const ghost = holder && holder !== ref.identity ? parseIdentity(holder) : null;
		if (!holder || !ghost) return false;
		const mark = parseJoinMark(await repository.joinMark(ref.channelId, holder));
		const states = await readVoiceStates();
		if (states ? states.some((state) => voiceIdentity(state.userId, state.connectionId) === holder) : mark) {
			return false;
		}
		const released = await repository.release({channelId: ref.channelId, identity: holder, userId: ghost.userId});
		// The LiveKit server of the holder comes from its j: mark, gone after the release; without one there is none to ask.
		if (mark) await this.publishSeat({...ref, identity: holder}, '', mark);
		if (released.seat && released.heir) await this.publishSeat({...ref, identity: released.heir}, released.seat);
		return true;
	}

	// Releases lounge seats whose holders are no longer in the channel. Bounded by the 30 s channel lock.
	private async reconcileSeats(
		guildId: GuildID,
		channelId: ChannelID,
		seats: ReadonlyArray<string>,
		readVoiceStates: VoiceStateReader,
		signal?: AbortSignal,
	): Promise<boolean> {
		const states = await readVoiceStates();
		if (!states) return false;
		const present = new Set(states.map((state) => voiceIdentity(state.userId, state.connectionId)));
		let freed = false;
		for (const holder of await this.deps.repository.holdersOf(channelId, seats)) {
			const stale = holder && !present.has(holder) ? parseIdentity(holder) : null;
			if (!holder || !stale) continue;
			signal?.throwIfAborted();
			const released = await this.deps.repository.release({channelId, identity: holder, userId: stale.userId});
			if (released.seat && released.heir) {
				await this.publishSeat({guildId, channelId, identity: released.heir}, released.seat, undefined, signal);
			} else {
				freed = true;
			}
		}
		return freed;
	}

	// At most one gateway voice-state read per request, and only when the channel's 30 s lock is free. The read writes
	// the missing j: marks of every connection it lists (switch or theme turned on with people inside, dropped join
	// hooks), so the next member of the channel needs no gateway call.
	private voiceStateReader(guildId: GuildID, channelId: ChannelID, signal?: AbortSignal): VoiceStateReader {
		let read: Promise<ReadonlyArray<GatewayVoiceStateEntry> | null> | undefined;
		return () => {
			read ??= (async () => {
				if (!(await this.deps.repository.tryReconcileLock(channelId))) return null;
				const {voiceStates} = await this.deps.gatewayService.getVoiceStatesForChannel({guildId, channelId});
				await this.deps.repository.markPresent(
					channelId,
					voiceStates
						.filter((state) => state.channelId === channelId.toString())
						.map((state) => ({
							identity: voiceIdentity(state.userId, state.connectionId),
							value: joinMarkValue(state.userId, {regionId: state.regionId ?? null, serverId: state.serverId ?? null}),
						})),
					signal,
				);
				return voiceStates;
			})();
			return read;
		};
	}

	private async publishTake(
		ref: SeatRef,
		result: VoiceSeatTakeResult,
		location: VoiceLocation,
		signal?: AbortSignal,
	): Promise<void> {
		const seat = seated(result);
		if (seat) await this.publishSeat(ref, seat, location, signal);
		if (result.freed) {
			// freed is this identity itself when its seat left the theme and no new one was free: its own mirror write.
			if (result.freed !== ref.identity) signal?.throwIfAborted();
			await this.publishSeat({...ref, identity: result.freed}, '', undefined, signal);
		}
	}

	// Writes the attribute of the seat just written to the hash (always, even when aborted), then re-reads
	// p:<identity> and writes once more if a later request moved the seat meanwhile, so out-of-order RoomService calls
	// still end on the hash value. '' removes the attribute.
	private async publishSeat(ref: SeatRef, seat: string, location?: VoiceLocation, signal?: AbortSignal): Promise<void> {
		await this.writeSeatAttribute(ref, seat, location);
		const current = (await this.deps.repository.seatOf(ref.channelId, ref.identity)) ?? '';
		if (current === seat) return;
		signal?.throwIfAborted();
		await this.writeSeatAttribute(ref, current, location);
	}

	private async writeSeatAttribute(ref: SeatRef, seat: string, location?: VoiceLocation): Promise<void> {
		const participant = parseIdentity(ref.identity);
		if (!participant) return;
		let regionId = location?.regionId;
		let serverId = location?.serverId;
		if (!regionId || !serverId) {
			const mark = parseJoinMark(await this.deps.repository.joinMark(ref.channelId, ref.identity));
			regionId = mark?.regionId;
			serverId = mark?.serverId;
		}
		if (!regionId || !serverId) {
			Logger.debug({channelId: ref.channelId.toString()}, 'voice seat attribute skipped: no LiveKit server');
			return;
		}
		await this.deps.liveKitService.setParticipantAttributes({
			userId: participant.userId,
			guildId: ref.guildId,
			channelId: ref.channelId,
			connectionId: participant.connectionId,
			regionId,
			serverId,
			attributes: {[VOICE_SEAT_ATTRIBUTE]: seat},
		});
	}

	// TEMPORARY: leaving a table is rare (game end), so the theme comes from the authenticated channel read rather than
	// a channel repository dependency; the user who lost channel access stands.
	private async themeSeatsFor(userId: UserID, channelId: ChannelID): Promise<ReadonlyArray<string>> {
		try {
			const {channel} = await this.deps.channelAuthService.getChannelAuthenticated({
				viewer: {kind: 'user', userId, bot: false, capable: false},
				userId,
				channelId,
			});
			const config = await this.deps.instanceConfigRepository.getVoiceRoomConfig();
			const theme = resolveEffectiveVoiceRoomTheme(channel.roomTheme, config, channel.type);
			return theme === null ? [] : themeSeats(theme);
		} catch {
			return [];
		}
	}

	// Switch first, then VIEW_CHANNEL (inside getChannelAuthenticated), a guild voice channel and CONNECT.
	private async authorizeVoiceChannel(userId: UserID, channelId: ChannelID) {
		const config = await this.deps.instanceConfigRepository.getVoiceRoomConfig();
		const assignment = resolveVoiceRoomAssignment(config);
		if (!assignment.rooms) throw new FeatureTemporarilyDisabledError();
		const auth = await this.deps.channelAuthService.getChannelAuthenticated({
			viewer: {kind: 'user', userId, bot: false, capable: false},
			userId,
			channelId,
		});
		if (auth.channel.type !== ChannelTypes.GUILD_VOICE) throw new InvalidChannelTypeError();
		await auth.checkPermission(Permissions.CONNECT);
		return {
			channel: auth.channel,
			games: assignment.games,
			theme: resolveEffectiveVoiceRoomTheme(auth.channel.roomTheme, config, auth.channel.type),
		};
	}
}
