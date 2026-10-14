// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {type ChannelID, createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import {
	actionRow,
	button,
	disableAllComponents,
	validateMessageComponents,
} from '@app/api/channel/services/message/MessageComponentRules';
import {
	createMessageResponseDataService,
	MessageResponseDataService,
	setInjectedMessageResponseDataService,
} from '@app/api/channel/services/message/MessageResponseDataService';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import type {MessageActionRowData} from '@app/api/database/types/MessageTypes';
import {ROSTER_BOT_INVITE_PERMISSIONS} from '@app/api/guild/roster/GuildRosterConstants';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getChannelRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {RepositoryBackedMessageResponseDataService} from '@app/api/test/mocks/RepositoryBackedMessageResponseDataService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {MessageFlags, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {NatsConnection} from '@nats-io/transport-node';
import type {INatsConnectionManager} from '@pkgs/nats/src/INatsConnectionManager';
import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const ROWS: Array<MessageActionRowData> = [
	actionRow([
		button({customId: 'roster:join', label: 'Katıl', style: 3, emoji: '✅'}),
		button({customId: 'roster:leave', label: 'Ayrıl', style: 2}),
	]),
];

let harness: ApiTestHarness;
let originalRosterId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalRosterId = Config.instance.rosterBotApplicationId;
	await harness.reset();
});
afterEach(() => {
	Config.instance.rosterBotApplicationId = originalRosterId;
	setInjectedMessageResponseDataService(new RepositoryBackedMessageResponseDataService());
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

async function requestChannelService(): Promise<ChannelService> {
	let channelService!: ChannelService;
	const app = new Hono<HonoEnv>();
	app.use(ServiceMiddleware);
	app.get('/', (ctx) => {
		channelService = ctx.get('channelService');
		return ctx.body(null, 204);
	});
	await app.request('/');
	return channelService;
}

async function createFixture(botPermissions = ROSTER_BOT_INVITE_PERMISSIONS) {
	const setup = await setupTestGuildWithMembers(harness, 1);
	const app = await createOAuth2Application(harness, setup.owner.token, {name: 'Micup Roster'});
	await authorizeBot(
		harness,
		setup.owner.token,
		app.application.id,
		['bot'],
		setup.guild.id,
		botPermissions.toString(),
	);
	Config.instance.rosterBotApplicationId = app.application.id;
	const users = getUserRepository();
	return {
		setup,
		channelService: await requestChannelService(),
		bot: await users.findUniqueAssert(createUserID(BigInt(app.botUserId))),
		member: await users.findUniqueAssert(createUserID(BigInt(setup.members[0]!.userId))),
		channelId: createChannelID(BigInt(setup.systemChannel.id)),
	};
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function sendAsBot(fixture: Fixture, components: ReadonlyArray<MessageActionRowData> = ROWS) {
	const {message} = await fixture.channelService.messages.send.sendMessage({
		user: fixture.bot,
		viewer: {kind: 'user', userId: fixture.bot.id, bot: fixture.bot.isBot, capable: false},
		channelId: fixture.channelId,
		data: {content: 'Kart'},
		components,
		requestCache: createRequestCache(),
	});
	return message;
}

async function storedComponents(channelId: ChannelID, messageId: bigint) {
	const stored = await getChannelRepository().messages.getMessage(channelId, createMessageID(messageId));
	return stored?.components;
}

function capturingMessageService(requests: Array<Record<string, unknown>>): MessageResponseDataService {
	const connection = {
		request: async (_subject: string, data: Uint8Array) => {
			const payload = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
			requests.push(payload);
			const id = (payload.message as {message_id: string}).message_id;
			return {data: new TextEncoder().encode(JSON.stringify({FoundApi: {id}}))};
		},
	} as unknown as NatsConnection;
	const manager: INatsConnectionManager = {
		connect: async () => {},
		drain: async () => {},
		isClosed: () => false,
		getConnection: () => connection,
	};
	return new MessageResponseDataService(manager);
}

it('sendMessage stores components for a first-party bot and the response carries them', async () => {
	const fixture = await createFixture();
	const message = await sendAsBot(fixture);
	expect(message.components).toEqual(ROWS);
	expect(await storedComponents(fixture.channelId, message.id)).toEqual(ROWS);
	const requests: Array<Record<string, unknown>> = [];
	setInjectedMessageResponseDataService(capturingMessageService(requests));
	await createMessageResponseDataService().buildMessageForChannel({channel: {guildId: null}, message});
	expect((requests[0]!.message as Record<string, unknown>).micup_components).toEqual([
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 3,
					label: 'Katıl',
					emoji_name: '✅',
					emoji_id: null,
					emoji_animated: null,
					custom_id: 'roster:join',
					disabled: false,
				},
				{
					type: 2,
					style: 2,
					label: 'Ayrıl',
					emoji_name: null,
					emoji_id: null,
					emoji_animated: null,
					custom_id: 'roster:leave',
					disabled: false,
				},
			],
		},
	]);
});

it('sendMessage with components from a user that is not a first-party bot throws MissingPermissions', async () => {
	const fixture = await createFixture();
	const upsert = vi.spyOn(getChannelRepository().messages, 'upsertMessage');
	await expect(
		fixture.channelService.messages.send.sendMessage({
			user: fixture.member,
			viewer: {kind: 'user', userId: fixture.member.id, bot: fixture.member.isBot, capable: false},
			channelId: fixture.channelId,
			data: {content: 'Kart'},
			components: ROWS,
			requestCache: createRequestCache(),
		}),
	).rejects.toBeInstanceOf(MissingPermissionsError);
	expect(upsert).not.toHaveBeenCalled();
});

it('editMessage with components from a non-official user throws', async () => {
	const fixture = await createFixture();
	await ensureSessionStarted(harness, fixture.setup.members[0]!.token);
	const sent = await createBuilder<MessageResponse>(harness, fixture.setup.members[0]!.token)
		.post(`/channels/${fixture.channelId}/messages`)
		.body({content: 'Merhaba'})
		.execute();
	await expect(
		fixture.channelService.messages.edit.editMessage({
			userId: fixture.member.id,
			viewer: {kind: 'user', userId: fixture.member.id, bot: fixture.member.isBot, capable: false},
			channelId: fixture.channelId,
			messageId: createMessageID(BigInt(sent.id)),
			data: {content: 'Merhaba'},
			components: ROWS,
			requestCache: createRequestCache(),
		}),
	).rejects.toBeInstanceOf(MissingPermissionsError);
	expect(await storedComponents(fixture.channelId, BigInt(sent.id))).toEqual([]);
});

it('an official bot editing buttons on a message it did not write is refused', async () => {
	const fixture = await createFixture(ROSTER_BOT_INVITE_PERMISSIONS | Permissions.MANAGE_MESSAGES);
	await ensureSessionStarted(harness, fixture.setup.members[0]!.token);
	const sent = await createBuilder<MessageResponse>(harness, fixture.setup.members[0]!.token)
		.post(`/channels/${fixture.channelId}/messages`)
		.body({content: 'Merhaba'})
		.execute();
	await expect(
		fixture.channelService.messages.edit.editMessage({
			userId: fixture.bot.id,
			viewer: {kind: 'user', userId: fixture.bot.id, bot: fixture.bot.isBot, capable: false},
			channelId: fixture.channelId,
			messageId: createMessageID(BigInt(sent.id)),
			data: {flags: MessageFlags.SUPPRESS_EMBEDS},
			components: ROWS,
			requestCache: createRequestCache(),
		}),
	).rejects.toBeInstanceOf(MissingPermissionsError);
	expect(await storedComponents(fixture.channelId, BigInt(sent.id))).toEqual([]);
});

it('an edit without components keeps the stored buttons', async () => {
	const fixture = await createFixture();
	const message = await sendAsBot(fixture);
	const {message: edited} = await fixture.channelService.messages.edit.editMessage({
		userId: fixture.bot.id,
		viewer: {kind: 'user', userId: fixture.bot.id, bot: fixture.bot.isBot, capable: false},
		channelId: fixture.channelId,
		messageId: message.id,
		data: {content: 'Yeni kart'},
		requestCache: createRequestCache(),
	});
	expect(edited.content).toBe('Yeni kart');
	expect(await storedComponents(fixture.channelId, message.id)).toEqual(ROWS);
});

it('an edit that changes only components stores them', async () => {
	const fixture = await createFixture();
	const message = await sendAsBot(fixture);
	const closed = disableAllComponents(ROWS);
	await fixture.channelService.messages.edit.editMessage({
		userId: fixture.bot.id,
		viewer: {kind: 'user', userId: fixture.bot.id, bot: fixture.bot.isBot, capable: false},
		channelId: fixture.channelId,
		messageId: message.id,
		data: {content: 'Kart'},
		components: closed,
		requestCache: createRequestCache(),
	});
	const stored = await storedComponents(fixture.channelId, message.id);
	expect(stored).toEqual(closed);
	expect(stored?.flatMap((row) => row.components ?? []).every((b) => b.disabled === true)).toBe(true);
});

it('an edit with an empty components list is refused', async () => {
	const fixture = await createFixture();
	const message = await sendAsBot(fixture);
	await expect(
		fixture.channelService.messages.edit.editMessage({
			userId: fixture.bot.id,
			viewer: {kind: 'user', userId: fixture.bot.id, bot: fixture.bot.isBot, capable: false},
			channelId: fixture.channelId,
			messageId: message.id,
			data: {content: 'Kart'},
			components: [],
			requestCache: createRequestCache(),
		}),
	).rejects.toThrow();
	expect(await storedComponents(fixture.channelId, message.id)).toEqual(ROWS);
});

it('POST /channels/:id/messages ignores components in the body', async () => {
	const fixture = await createFixture();
	const token = fixture.setup.members[0]!.token;
	await ensureSessionStarted(harness, token);
	const sent = await createBuilder<MessageResponse>(harness, token)
		.post(`/channels/${fixture.channelId}/messages`)
		.body({content: 'Merhaba', components: [{type: 1, components: [{type: 2, style: 1, custom_id: 'roster:join'}]}]})
		.expect(200)
		.execute();
	expect(await storedComponents(fixture.channelId, BigInt(sent.id))).toEqual([]);
});

it('PATCH a message ignores components in the body', async () => {
	const fixture = await createFixture();
	const token = fixture.setup.members[0]!.token;
	await ensureSessionStarted(harness, token);
	const sent = await createBuilder<MessageResponse>(harness, token)
		.post(`/channels/${fixture.channelId}/messages`)
		.body({content: 'Merhaba'})
		.execute();
	await createBuilder<MessageResponse>(harness, token)
		.patch(`/channels/${fixture.channelId}/messages/${sent.id}`)
		.body({content: 'Selam', components: [{type: 1, components: [{type: 2, style: 1, custom_id: 'roster:join'}]}]})
		.expect(200)
		.execute();
	expect(await storedComponents(fixture.channelId, BigInt(sent.id))).toEqual([]);
});

it('more than 5 rows, 5 buttons, an 81 character label or a 101 character custom_id is refused', async () => {
	const fixture = await createFixture();
	const one = (overrides: {customId?: string; label?: string} = {}) =>
		button({customId: overrides.customId ?? 'roster:join', label: overrides.label ?? 'Katıl', style: 1});
	const fiveButtons = actionRow([1, 2, 3, 4, 5].map((n) => one({customId: `roster:${n}`})));
	validateMessageComponents([fiveButtons, fiveButtons, fiveButtons, fiveButtons, fiveButtons]);
	validateMessageComponents([actionRow([one({label: 'x'.repeat(80), customId: 'x'.repeat(100)})])]);
	const upsert = vi.spyOn(getChannelRepository().messages, 'upsertMessage');
	const invalid: Array<Array<MessageActionRowData>> = [
		Array.from({length: 6}, () => actionRow([one()])),
		[actionRow([1, 2, 3, 4, 5, 6].map((n) => one({customId: `roster:${n}`})))],
		[actionRow([one({label: 'x'.repeat(81)})])],
		[actionRow([one({customId: 'x'.repeat(101)})])],
	];
	for (const components of invalid) await expect(sendAsBot(fixture, components)).rejects.toThrow();
	expect(upsert).not.toHaveBeenCalled();
});

it('a message row written before the column exists reads back with no components', async () => {
	const channelId = createChannelID(createSnowflake({timestamp: Date.now()}));
	const messageId = createMessageID(createSnowflake({timestamp: Date.now()}));
	const messages = getChannelRepository().messages;
	await messages.upsertMessage(
		{
			channel_id: channelId,
			bucket: makeBucket(messageId),
			message_id: messageId,
			author_id: createUserID(101n),
			type: 0,
			webhook_id: null,
			webhook_name: null,
			webhook_avatar_hash: null,
			content: 'Eski mesaj',
			edited_timestamp: null,
			pinned_timestamp: null,
			flags: 0,
			mention_everyone: false,
			mention_users: null,
			mention_roles: null,
			mention_channels: null,
			attachments: null,
			embeds: null,
			sticker_items: null,
			message_reference: null,
			message_snapshots: null,
			call: null,
			has_reaction: false,
			version: 1,
		},
		null,
	);
	const stored = await messages.getMessage(channelId, messageId);
	expect(stored?.components).toEqual([]);
	expect(stored?.toRow().micup_components).toBeNull();
});

it('no generated OpenAPI request body schema has a components property', () => {
	interface Schema {
		$ref?: string;
		properties?: Record<string, unknown>;
		oneOf?: Array<Schema>;
		anyOf?: Array<Schema>;
		allOf?: Array<Schema>;
	}
	const spec = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fluxer_api/src/api/openapi/openapi.json'), 'utf8')) as {
		paths: Record<string, Record<string, {requestBody?: {content: Record<string, {schema: Schema}>}}>>;
		components: {schemas: Record<string, Schema>};
	};
	// Every route's request body through $ref and its oneOf/anyOf/allOf branches, whatever the schema is named.
	const bodies = new Map<string, Schema>();
	const walk = (schema: Schema, name: string): void => {
		const ref = schema.$ref?.split('/').pop();
		if (ref) {
			if (!bodies.has(ref)) {
				bodies.set(ref, spec.components.schemas[ref]!);
				walk(spec.components.schemas[ref]!, ref);
			}
			return;
		}
		expect(schema.properties ?? {}, name).not.toHaveProperty('components');
		for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])])
			walk(branch, name);
	};
	for (const [route, operations] of Object.entries(spec.paths))
		for (const operation of Object.values(operations))
			for (const {schema} of Object.values(operation.requestBody?.content ?? {})) walk(schema, route);
	for (const name of ['MessageRequestSchema', 'MessageUpdateRequestSchema'])
		expect(bodies.get(name)?.properties, name).toBeDefined();
});
