// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createChannelID,
	createEntranceSoundID,
	createGuildID,
	createUserID,
	type EntranceSoundID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {getCachedInstancePremiumMode, setCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {EntranceSound, EntranceSoundSelection} from '@app/api/models/EntranceSound';
import {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {EntranceSoundController} from '@app/api/user/entrance_sound/EntranceSoundController';
import {EntranceSoundPlayController} from '@app/api/user/entrance_sound/EntranceSoundPlayController';
import {EntranceSoundPlayService} from '@app/api/user/entrance_sound/EntranceSoundPlayService';
import type {EntranceSoundRepository} from '@app/api/user/entrance_sound/EntranceSoundRepository';
import {EntranceSoundService} from '@app/api/user/entrance_sound/EntranceSoundService';
import {PremiumFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {AppErrorHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import type {LimitConfigSnapshot} from '@fluxer/limits/src/LimitTypes';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const USER_ID = createUserID(123456789012345678n);
const SOUND_ID = createEntranceSoundID(223456789012345678n);
const CHANNEL_ID = createChannelID(323456789012345678n);
const GUILD_ID = createGuildID(423456789012345678n);
const OTHER_USER_ID = createUserID(523456789012345678n);
const LIBRARY_PATH = '/users/@me/entrance-sounds';
const FUTURE = new Date('2099-01-01T00:00:00Z');
const EXPIRED = new Date('2000-01-01T00:00:00Z');
const SCOPES = ['global', 'guilds', 'dms', `guild:${GUILD_ID}`];
const ACTIVE_PREMIUM = {premium_type: UserPremiumTypes.SUBSCRIPTION, premium_until: FUTURE};

interface Operation {
	label: string;
	method: string;
	path: string;
	body?: Record<string, unknown>;
	status: number;
	field?: string;
}

function createWavBase64(): string {
	const buffer = Buffer.alloc(44 + 8000);
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(buffer.length - 8, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(8000, 24);
	buffer.writeUInt32LE(16000, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(8000, 40);
	return buffer.toString('base64');
}

const AUDIO = createWavBase64();
const protectedOperations: Array<Operation> = [
	{
		label: 'upload',
		method: 'POST',
		path: LIBRARY_PATH,
		body: {name: 'Hello', audio: AUDIO},
		status: 201,
		field: 'audio',
	},
	...SCOPES.map((scope) => ({
		label: `select ${scope}`,
		method: 'PUT',
		path: '/users/@me/entrance-sound-selections',
		body: {scope_id: scope, sound_id: SOUND_ID.toString()},
		status: 204,
		field: 'sound_id',
	})),
	{
		label: 'play',
		method: 'POST',
		path: `/voice/channels/${CHANNEL_ID}/entrance-sound`,
		body: {sound_id: SOUND_ID.toString()},
		status: 204,
		field: 'sound_id',
	},
];
const managementOperations: Array<Operation> = [
	{label: 'list', method: 'GET', path: LIBRARY_PATH, status: 200},
	{label: 'rename', method: 'PATCH', path: `${LIBRARY_PATH}/${SOUND_ID}`, body: {name: 'Renamed'}, status: 200},
	{label: 'delete', method: 'DELETE', path: `${LIBRARY_PATH}/${SOUND_ID}`, status: 204},
	...SCOPES.map((scope) => ({
		label: `clear ${scope}`,
		method: 'PUT',
		path: '/users/@me/entrance-sound-selections',
		body: {scope_id: scope, sound_id: null},
		status: 204,
	})),
];

function createUser(overrides: Partial<UserRow> = {}): User {
	return new User({
		...EMPTY_USER_ROW,
		user_id: USER_ID,
		username: 'entrance_sound_user',
		discriminator: 1,
		bot: false,
		traits: new Set<string>(),
		...overrides,
	});
}

function createApp(
	user: User | null,
	snapshot: LimitConfigSnapshot | null = createDefaultLimitConfig({selfHosted: false}),
) {
	const sound = new EntranceSound({
		user_id: USER_ID,
		sound_id: SOUND_ID,
		name: 'Saved sound',
		hash: 'saved-hash',
		extension: 'wav',
		content_type: 'audio/wav',
		duration_ms: 500,
		size_bytes: 8044,
		created_at: new Date('2026-01-01T00:00:00Z'),
		version: 1,
	});
	const sounds = new Map([[SOUND_ID, sound]]);
	const selections = new Map(
		SCOPES.map((scope) => [scope, new EntranceSoundSelection({user_id: USER_ID, scope_id: scope, sound_id: SOUND_ID})]),
	);
	const repository = {
		listSounds: vi.fn(async (userId: UserID) => [...sounds.values()].filter((entry) => entry.userId === userId)),
		getSound: vi.fn(async (userId: UserID, soundId: EntranceSoundID) => {
			const entry = sounds.get(soundId);
			return entry?.userId === userId ? entry : null;
		}),
		upsertSound: vi.fn(async (entry: EntranceSound) => {
			sounds.set(entry.soundId, entry);
			return entry;
		}),
		deleteSound: vi.fn(async (_userId: UserID, soundId: EntranceSoundID) => {
			sounds.delete(soundId);
		}),
		listSelections: vi.fn(async () => [...selections.values()]),
		upsertSelection: vi.fn(async (selection: EntranceSoundSelection) => {
			selections.set(selection.scopeId, selection);
			return selection;
		}),
		deleteSelection: vi.fn(async (_userId: UserID, scope: string) => {
			selections.delete(scope);
		}),
		deleteSelectionsForSound: vi.fn(async (_userId: UserID, soundId: EntranceSoundID) => {
			for (const [scope, selection] of selections) if (selection.soundId === soundId) selections.delete(scope);
		}),
	};
	const storage = {uploadObject: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined)};
	const media = {getMetadata: vi.fn(async () => ({format: 'wav', content_type: 'audio/wav', duration: 0.5}))};
	const getConfigSnapshot = vi.fn(() => snapshot);
	const service = new EntranceSoundService(
		repository as unknown as EntranceSoundRepository,
		storage as unknown as IStorageService,
		media as unknown as IMediaService,
		{getConfigSnapshot} as unknown as LimitConfigService,
	);
	const channels = {findUnique: vi.fn(async () => ({guildId: GUILD_ID}))};
	const gateway = {
		getVoiceStatesForChannel: vi.fn(async () => ({
			voiceStates: [
				{userId: USER_ID.toString()},
				{userId: OTHER_USER_ID.toString()},
				{userId: OTHER_USER_ID.toString()},
			],
		})),
		dispatchPresence: vi.fn(async () => undefined),
	};
	const playService = new EntranceSoundPlayService(
		service,
		gateway as unknown as IGatewayService,
		{channelData: channels} as unknown as ChannelRepository,
	);
	const app = new Hono<HonoEnv>();
	app.onError(AppErrorHandler);
	app.use('*', async (ctx, next) => {
		if (user) ctx.set('user', user);
		ctx.set('authTokenType', 'session');
		ctx.set('entranceSoundService', service);
		ctx.set('entranceSoundPlayService', playService);
		await next();
	});
	EntranceSoundController(app);
	EntranceSoundPlayController(app);
	return {
		app,
		service,
		playService,
		repository,
		storage,
		media,
		channels,
		gateway,
		getConfigSnapshot,
		sounds,
		selections,
	};
}

function request(app: Hono<HonoEnv>, operation: Operation) {
	return app.request(operation.path, {
		method: operation.method,
		...(operation.body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(operation.body)} : {}),
	});
}

async function expectPremiumDenial(response: Response, field: string) {
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		code: 'INVALID_FORM_BODY',
		errors: [{path: field, code: 'ENTRANCE_SOUNDS_REQUIRE_PREMIUM'}],
	});
}

function expectNoIO(fixture: ReturnType<typeof createApp>) {
	for (const fn of [
		...Object.values(fixture.repository),
		...Object.values(fixture.storage),
		...Object.values(fixture.media),
		...Object.values(fixture.channels),
		...Object.values(fixture.gateway),
	])
		expect(fn).not.toHaveBeenCalled();
}

describe('entrance sound feature entitlement through real services and registered routes', () => {
	let previousSelfHosted: boolean;
	let previousPremiumMode: ReturnType<typeof getCachedInstancePremiumMode>;
	beforeEach(() => {
		previousSelfHosted = Config.instance.selfHosted;
		previousPremiumMode = getCachedInstancePremiumMode();
		Config.instance.selfHosted = false;
		setCachedInstancePremiumMode('mirror');
	});
	afterEach(() => {
		Config.instance.selfHosted = previousSelfHosted;
		setCachedInstancePremiumMode(previousPremiumMode);
	});

	const scenarios: Array<{label: string; row: Partial<UserRow>; allowed: boolean}> = [
		{label: 'free user', row: {}, allowed: false},
		{label: 'active subscription', row: ACTIVE_PREMIUM, allowed: true},
		{
			label: 'lifetime premium with expired end fields',
			row: {premium_type: UserPremiumTypes.LIFETIME, premium_until: EXPIRED, premium_grace_ends_at: EXPIRED},
			allowed: true,
		},
		{label: 'subscription without end date', row: {premium_type: UserPremiumTypes.SUBSCRIPTION}, allowed: true},
		{
			label: 'subscription automatic grace',
			row: {premium_type: UserPremiumTypes.SUBSCRIPTION, premium_until: new Date(Date.now() - 24 * 60 * 60 * 1000)},
			allowed: true,
		},
		{
			label: 'expired subscription with stale premium trait',
			row: {premium_type: UserPremiumTypes.SUBSCRIPTION, premium_until: EXPIRED, traits: new Set(['premium'])},
			allowed: false,
		},
		{
			label: 'active gift trial extension',
			row: {
				premium_type: UserPremiumTypes.SUBSCRIPTION,
				premium_until: EXPIRED,
				premium_gift_extension_ends_at: FUTURE,
			},
			allowed: true,
		},
		{
			label: 'active trial grace',
			row: {premium_type: UserPremiumTypes.SUBSCRIPTION, premium_until: EXPIRED, premium_grace_ends_at: FUTURE},
			allowed: true,
		},
		{
			label: 'expired trial',
			row: {
				premium_type: UserPremiumTypes.SUBSCRIPTION,
				premium_until: EXPIRED,
				premium_gift_extension_ends_at: EXPIRED,
				premium_grace_ends_at: EXPIRED,
			},
			allowed: false,
		},
		{label: 'admin premium override', row: {premium_flags: PremiumFlags.ENABLED_OVERRIDE}, allowed: true},
		{
			label: 'premium perks disabled',
			row: {...ACTIVE_PREMIUM, premium_flags: PremiumFlags.PERKS_DISABLED},
			allowed: false,
		},
	];
	for (const scenario of scenarios) {
		it.each(protectedOperations)(`${scenario.label}: $label follows the resolved feature`, async (operation) => {
			const fixture = createApp(createUser(scenario.row));
			const response = await request(fixture.app, operation);
			if (scenario.allowed) {
				expect(response.status).toBe(operation.status);
				if (operation.label === 'upload') expect(fixture.storage.uploadObject).toHaveBeenCalledTimes(1);
				if (operation.label.startsWith('select')) expect(fixture.repository.upsertSelection).toHaveBeenCalledTimes(1);
				if (operation.label === 'play') expect(fixture.gateway.dispatchPresence).toHaveBeenCalledTimes(1);
			} else {
				await expectPremiumDenial(response, operation.field!);
				expectNoIO(fixture);
			}
			expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
		});
	}
	it.each(protectedOperations)('self-hosted everyone: free $label remains available', async (operation) => {
		Config.instance.selfHosted = true;
		setCachedInstancePremiumMode('everyone');
		const fixture = createApp(createUser(), createDefaultLimitConfig({selfHosted: true, premiumMode: 'everyone'}));
		expect((await request(fixture.app, operation)).status).toBe(operation.status);
		expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
	});
	it.each(protectedOperations)('operator trait grant: free $label remains available', async (operation) => {
		const snapshot = createDefaultLimitConfig({selfHosted: false});
		snapshot.traitDefinitions.push('entrance_sounds');
		snapshot.rules.push({
			id: 'entrance_sounds',
			filters: {traits: ['entrance_sounds']},
			limits: {feature_voice_entrance_sounds: 1},
		});
		const fixture = createApp(createUser({traits: new Set(['entrance_sounds'])}), snapshot);
		expect((await request(fixture.app, operation)).status).toBe(operation.status);
		expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
	});
	for (const mode of ['disabled', 'missing'] as const) {
		it.each(protectedOperations)(`${mode} snapshot feature: premium $label fails closed`, async (operation) => {
			const snapshot = createDefaultLimitConfig({selfHosted: false});
			for (const rule of snapshot.rules) rule.limits.feature_voice_entrance_sounds = 0;
			const fixture = createApp(createUser(ACTIVE_PREMIUM), mode === 'missing' ? null : snapshot);
			await expectPremiumDenial(await request(fixture.app, operation), operation.field!);
			expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
			expectNoIO(fixture);
		});
	}
	for (const scenario of scenarios.filter((scenario) => !scenario.allowed)) {
		it.each(managementOperations)(`${scenario.label}: $label preserves owner management`, async (operation) => {
			const fixture = createApp(createUser(scenario.row));
			const response = await request(fixture.app, operation);
			expect(response.status).toBe(operation.status);
			expect(fixture.getConfigSnapshot).not.toHaveBeenCalled();
			if (operation.label === 'list') {
				expect(await response.json()).toMatchObject({
					sounds: [{id: SOUND_ID.toString(), hash: 'saved-hash'}],
					selections: SCOPES.map((scope) => ({scope_id: scope, sound_id: SOUND_ID.toString()})),
				});
				expect(fixture.sounds.size).toBe(1);
				expect(fixture.selections.size).toBe(4);
			} else if (operation.label === 'rename') {
				expect(fixture.sounds.get(SOUND_ID)?.name).toBe('Renamed');
			} else if (operation.label === 'delete') {
				expect(fixture.sounds.size).toBe(0);
				expect(fixture.selections.size).toBe(0);
			} else {
				expect(fixture.selections.has(operation.body!.scope_id as string)).toBe(false);
				expect(fixture.sounds.size).toBe(1);
			}
		});
	}
	it.each(managementOperations)('missing snapshot: $label remains available', async (operation) => {
		const fixture = createApp(createUser(), null);
		expect((await request(fixture.app, operation)).status).toBe(operation.status);
		expect(fixture.getConfigSnapshot).not.toHaveBeenCalled();
	});
	for (const auth of ['unauthenticated', 'bot'] as const) {
		it.each([...protectedOperations, ...managementOperations])(
			`${auth}: $label remains blocked before services`,
			async (operation) => {
				const fixture = createApp(auth === 'bot' ? createUser({bot: true}) : null);
				expect((await request(fixture.app, operation)).status).toBe(auth === 'bot' ? 403 : 401);
				expect(fixture.getConfigSnapshot).not.toHaveBeenCalled();
				expectNoIO(fixture);
			},
		);
	}
	it('delivers an entitled play only once to each other channel participant', async () => {
		const fixture = createApp(createUser(ACTIVE_PREMIUM));
		expect((await request(fixture.app, protectedOperations[5]!)).status).toBe(204);
		expect(fixture.channels.findUnique).toHaveBeenCalledWith(CHANNEL_ID);
		expect(fixture.gateway.getVoiceStatesForChannel).toHaveBeenCalledWith({guildId: GUILD_ID, channelId: CHANNEL_ID});
		expect(fixture.repository.getSound).toHaveBeenCalledWith(USER_ID, SOUND_ID);
		expect(fixture.gateway.dispatchPresence).toHaveBeenCalledExactlyOnceWith({
			userId: OTHER_USER_ID,
			event: 'ENTRANCE_SOUND_PLAY',
			data: {
				user_id: USER_ID.toString(),
				channel_id: CHANNEL_ID.toString(),
				guild_id: GUILD_ID.toString(),
				sound_id: SOUND_ID.toString(),
				hash: 'saved-hash',
				url: `${Config.endpoints.media}/entrance-sounds/${USER_ID}/saved-hash.wav`,
				duration_ms: 500,
				content_type: 'audio/wav',
			},
		});
		expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
	});
	it('requires an entitled sender to be in the channel before reading their sound', async () => {
		const fixture = createApp(createUser(ACTIVE_PREMIUM));
		fixture.gateway.getVoiceStatesForChannel.mockResolvedValue({voiceStates: [{userId: OTHER_USER_ID.toString()}]});
		const response = await request(fixture.app, protectedOperations[5]!);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({errors: [{path: 'channel_id', code: 'ENTRANCE_SOUND_INVALID_SCOPE'}]});
		expect(fixture.repository.getSound).not.toHaveBeenCalled();
		expect(fixture.gateway.dispatchPresence).not.toHaveBeenCalled();
		expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
	});
	it("rejects another owner's sound for an entitled sender", async () => {
		const fixture = createApp(createUser(ACTIVE_PREMIUM));
		fixture.sounds.set(SOUND_ID, new EntranceSound({...fixture.sounds.get(SOUND_ID)!.toRow(), user_id: OTHER_USER_ID}));
		const response = await request(fixture.app, protectedOperations[5]!);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({errors: [{path: 'sound_id', code: 'ENTRANCE_SOUND_NOT_FOUND'}]});
		expect(fixture.gateway.dispatchPresence).not.toHaveBeenCalled();
		expect(fixture.getConfigSnapshot).toHaveBeenCalledTimes(1);
	});
});
