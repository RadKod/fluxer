// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import type {GatewayVoiceStateEntry} from '@app/api/infrastructure/IGatewayService';
import {
	type EngineClock,
	type Rng,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import type {TableGameEngineRegistry} from '@app/api/table_game/TableGameEngines';
import {type TableEnvelope, TableGameRepository} from '@app/api/table_game/TableGameRepository';
import {TableGameService, type TableGameServiceDeps} from '@app/api/table_game/TableGameService';
import {registerTableGameMockScripts} from '@app/api/table_game/tests/TableGameMockScripts';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import type {VoiceRoomConfig} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import type {
	TableGameResult,
	TableGameUpdateEvent,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {vi} from 'vitest';

registerTableGameMockScripts();

export const GUILD = '500';
export const CHANNEL = '9001';
export const OTHER_CHANNEL = '9002';
export const THEME = 'gece-lounge'; // one table slot: T01
export const SLOT = 'T01';
export const PLAYERS = ['101', '102', '103', '104'] as const;
export const conn = (userId: string) => `c${userId}`;
export const uid = (userId: string): UserID => createUserID(BigInt(userId));
export const cid = (channelId: string): ChannelID => createChannelID(BigInt(channelId));

// A stand-in engine with readable state: turns pass with 'discard', 'resign' ends it, deadlines auto-pass the turn.
export interface FakeState {
	positions: Array<TablePosition>;
	turn: TablePosition;
	deadlineAt: number;
	moves: number;
	timeouts: Array<number>;
	result: TableGameResult | null;
}

export const fakeStarts: Array<{rng: Rng; positions: ReadonlyArray<TablePosition>}> = [];

function nextTurn(state: FakeState): TablePosition {
	const index = state.positions.indexOf(state.turn);
	return state.positions[(index + 1) % state.positions.length]!;
}

function fakeEngine(kind: 'okey' | 'okey101' | 'chess', positions: Array<TablePosition>): TableGameEngine<FakeState> {
	const end = (state: FakeState, result: TableGameResult) => (state.result ? state : {...state, result});
	return {
		kind,
		positions,
		start(started, rng, clock) {
			fakeStarts.push({rng, positions: started});
			return {
				positions: [...started],
				turn: started[0]!,
				deadlineAt: clock.now + clock.turnMs,
				moves: 0,
				timeouts: [0, 0, 0, 0],
				result: null,
			};
		},
		apply(state, actor, action, _rng, clock: EngineClock) {
			if (state.result) throw new TableGameRuleError('game_over');
			if (action.type === 'resign') {
				return end(state, {kind: 'win', winners: positions.filter((p) => p !== actor), reason: 'resign'});
			}
			if (action.type !== 'discard') throw new TableGameRuleError('unsupported_action');
			if (actor !== state.turn) throw new TableGameRuleError('not_your_turn');
			return {...state, turn: nextTurn(state), moves: state.moves + 1, deadlineAt: clock.now + clock.turnMs};
		},
		onDeadline(state, _rng, clock) {
			if (state.result) return state;
			const timeouts = state.timeouts.map((count, index) => (index === state.turn - 1 ? count + 1 : count));
			if (timeouts[state.turn - 1]! >= 2)
				return {...state, timeouts, result: {kind: 'forfeit', loser: state.turn, reason: 'timeouts'}};
			return {...state, timeouts, turn: nextTurn(state), moves: state.moves + 1, deadlineAt: clock.now + clock.turnMs};
		},
		forfeit: (state, loser, reason) => end(state, {kind: 'forfeit', loser, reason}),
		cancel: (state, reason) => end(state, {kind: 'canceled', reason}),
		deadline: (state) => (state.result ? null : state.deadlineAt),
		result: (state) => state.result,
		view(state, viewer) {
			return {
				game: 'okey',
				indicator: 't0',
				pile_count: 0,
				discards: [[], [], [], []],
				rack_counts: [0, 0, 0, 0],
				turn: state.result ? null : state.turn,
				phase: 'discard',
				deadline_at: state.result ? null : new Date(state.deadlineAt).toISOString(),
				rack: viewer === null ? null : [],
			};
		},
	};
}

export const FAKE_ENGINES = {
	okey: fakeEngine('okey', [1, 2, 3, 4]),
	okey101: fakeEngine('okey101', [1, 2, 3, 4]),
	chess: fakeEngine('chess', [1, 3]),
} as unknown as TableGameEngineRegistry;

export interface Fixture {
	kv: MockKVProvider;
	repository: TableGameRepository;
	service: TableGameService;
	config: VoiceRoomConfig;
	themes: Map<string, string | null>;
	removedUsers: Set<string>;
	voice: Map<string, Array<GatewayVoiceStateEntry>>;
	dispatches: Array<{userId: string; event: TableGameUpdateEvent}>;
	gateway: {
		dispatchPresence: ReturnType<typeof vi.fn>;
		getVoiceStatesForChannel: ReturnType<typeof vi.fn>;
	};
	seats: {
		membership: ReturnType<typeof vi.fn>;
		seatAtTable: ReturnType<typeof vi.fn>;
		leaveTableSeat: ReturnType<typeof vi.fn>;
	};
	channels: {findUnique: ReturnType<typeof vi.fn>};
	joinVoice(userId: string, channelId?: string, connectionId?: string): void;
	leaveVoice(userId: string, channelId?: string, connectionId?: string): void;
	load(channelId?: string, slot?: string): Promise<TableEnvelope | null>;
	create(userId: string, game?: 'okey' | 'okey101' | 'chess', channelId?: string): Promise<TableGameView>;
	fill(game?: 'okey' | 'okey101' | 'chess', channelId?: string): Promise<TableEnvelope>;
}

export function createFixture(engines: TableGameEngineRegistry = FAKE_ENGINES): Fixture {
	const kv = new MockKVProvider();
	const repository = new TableGameRepository(kv);
	const config: VoiceRoomConfig = {
		rooms_enabled: true,
		games_enabled: true,
		room_cameras_enabled: false,
		default_room_theme: null,
	};
	const themes = new Map<string, string | null>([
		[CHANNEL, THEME],
		[OTHER_CHANNEL, THEME],
	]);
	const removedUsers = new Set<string>();
	const voice = new Map<string, Array<GatewayVoiceStateEntry>>();
	const dispatches: Fixture['dispatches'] = [];
	const gateway = {
		dispatchPresence: vi.fn(async (params: {userId: UserID; event: string; data: unknown}) => {
			dispatches.push({userId: String(params.userId), event: params.data as TableGameUpdateEvent});
		}),
		getVoiceStatesForChannel: vi.fn(async (params: {guildId?: GuildID; channelId: ChannelID}) => ({
			voiceStates: [...(voice.get(String(params.channelId)) ?? [])],
		})),
	};
	const inVoice = (channelId: string, userId: string, connectionId: string) =>
		(voice.get(channelId) ?? []).some((state) => state.userId === userId && state.connectionId === connectionId);
	const seats = {
		membership: vi.fn(async (p: {channelId: ChannelID; userId: UserID; connectionId: string}) =>
			inVoice(String(p.channelId), String(p.userId), p.connectionId) ? {regionId: 'eu', serverId: 'lk-1'} : null,
		),
		seatAtTable: vi.fn(async () => {}),
		leaveTableSeat: vi.fn(async () => {}),
	};
	// The timer's channel read (no user at hand); a channel missing from `themes` is gone.
	const channels = {
		findUnique: vi.fn(async (channelId: ChannelID) => {
			const theme = themes.get(String(channelId));
			return theme === undefined
				? null
				: {id: channelId, guildId: BigInt(GUILD), type: ChannelTypes.GUILD_VOICE, roomTheme: theme};
		}),
	};
	const channelAuthService = {
		async getChannelAuthenticated({userId, channelId}: {userId: UserID; channelId: ChannelID}) {
			const theme = themes.get(String(channelId));
			if (theme === undefined || removedUsers.has(String(userId))) throw new UnknownChannelError();
			return {
				channel: {
					id: channelId,
					guildId: BigInt(GUILD),
					type: ChannelTypes.GUILD_VOICE,
					roomTheme: theme,
				},
				checkPermission: async () => {},
			};
		},
	};
	const deps = {
		repository,
		instanceConfigRepository: {getVoiceRoomConfig: async () => ({...config})},
		channelAuthService,
		gatewayService: gateway,
		voiceSeatService: seats,
		channelRepository: channels,
		engines,
	} as unknown as TableGameServiceDeps;
	const service = new TableGameService(deps);
	const fixture: Fixture = {
		kv,
		repository,
		service,
		config,
		themes,
		removedUsers,
		voice,
		dispatches,
		gateway,
		seats,
		channels,
		joinVoice(userId, channelId = CHANNEL, connectionId = conn(userId)) {
			const states = voice.get(channelId) ?? [];
			states.push({connectionId, userId, channelId, regionId: 'eu', serverId: 'lk-1'});
			voice.set(channelId, states);
		},
		leaveVoice(userId, channelId = CHANNEL, connectionId = conn(userId)) {
			voice.set(
				channelId,
				(voice.get(channelId) ?? []).filter((s) => !(s.userId === userId && s.connectionId === connectionId)),
			);
		},
		load: (channelId = CHANNEL, slot = SLOT) => repository.load(channelId, slot),
		async create(userId, game = 'okey', channelId = CHANNEL) {
			return await service.create({
				userId: uid(userId),
				channelId: cid(channelId),
				slot: SLOT,
				game,
				speed: 'normal',
				connectionId: conn(userId),
			});
		},
		async fill(game = 'okey', channelId = CHANNEL) {
			const positions = engines[game].positions;
			for (const userId of PLAYERS) fixture.joinVoice(userId, channelId);
			await fixture.create(PLAYERS[0], game, channelId);
			for (let index = 1; index < positions.length; index++) {
				await service.join({
					userId: uid(PLAYERS[index]!),
					channelId: cid(channelId),
					slot: SLOT,
					position: positions[index]!,
					connectionId: conn(PLAYERS[index]!),
				});
			}
			return (await repository.load(channelId, SLOT))!;
		},
	};
	return fixture;
}
