// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import * as MicupBotHook from '@app/api/guild/micupbot/MicupBotReactionHook';
import * as RosterHook from '@app/api/guild/roster/GuildRosterReactionHook';
import type {GuildRosterReactionChange} from '@app/api/guild/roster/GuildRosterService';
import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getApplicationRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let originalRosterId: string | undefined;
let originalMicupBotId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalRosterId = Config.instance.rosterBotApplicationId;
	originalMicupBotId = Config.instance.micupBotApplicationId;
	Config.instance.rosterBotApplicationId = undefined;
	Config.instance.micupBotApplicationId = undefined;
	await harness.reset();
});
afterEach(() => {
	Config.instance.rosterBotApplicationId = originalRosterId;
	Config.instance.micupBotApplicationId = originalMicupBotId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

function reaction(): Extract<GuildRosterReactionChange, {kind: 'add' | 'remove'}> {
	return {
		kind: 'add',
		guildId: createGuildID(100n),
		channelId: createChannelID(101n),
		messageId: createMessageID(createSnowflake({timestamp: Date.now()})),
		authorId: createUserID(999n),
		userId: createUserID(102n),
		emojiName: '✅',
		emojiId: undefined,
		atMs: Date.now(),
	};
}

it("a reaction on a Roster message reaches only the Roster hook and one on a MicupBOT message only MicupBOT's", async () => {
	const {notifyOfficialBotReaction} = await import('@app/api/guild/OfficialBotReactionHook');
	Config.instance.rosterBotApplicationId = '999';
	Config.instance.micupBotApplicationId = '998';
	overrideLimits({feature_micupbot: 1});
	const jobs = vi.spyOn(getWorkerService(), 'addJob').mockResolvedValue(0n);
	const change = reaction();
	expect(notifyOfficialBotReaction(change)).toBeUndefined();
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'syncGuildRosterReaction',
		expect.objectContaining({message_id: String(change.messageId), user_id: String(change.userId)}),
		expect.objectContaining({skipLedger: true}),
	);
	jobs.mockClear();
	expect(notifyOfficialBotReaction({...change, authorId: createUserID(998n)})).toBeUndefined();
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'applyMicupBotReactionRole',
		expect.objectContaining({message_id: String(change.messageId), user_id: String(change.userId)}),
		expect.objectContaining({skipLedger: true}),
	);
	jobs.mockClear();
	notifyOfficialBotReaction({...change, authorId: createUserID(103n)});
	expect(jobs).not.toHaveBeenCalled();
});

it.each(['Roster', 'MicupBOT'] as const)(
	'%s hook failures do not stop the other hook even if logging fails',
	async (bot) => {
		const {notifyOfficialBotReaction} = await import('@app/api/guild/OfficialBotReactionHook');
		const roster = vi.spyOn(RosterHook, 'notifyGuildRosterReaction');
		const micupBot = vi.spyOn(MicupBotHook, 'notifyMicupBotReaction');
		const error = new Error('Hook unavailable');
		(bot === 'Roster' ? roster : micupBot).mockImplementation(() => {
			throw error;
		});
		const warn = vi.spyOn(Logger.child({}), 'warn').mockImplementation(() => {
			throw new Error('Logger unavailable');
		});
		const change = reaction();
		expect(() => notifyOfficialBotReaction(change)).not.toThrow();
		expect(roster).toHaveBeenCalledExactlyOnceWith(change);
		expect(micupBot).toHaveBeenCalledExactlyOnceWith(change);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({error}), expect.any(String));
	},
);

async function createBot() {
	const owner = await createTestAccount(harness);
	return createOAuth2Application(harness, owner.token, {name: 'Official bot auth'});
}

it('the MicupBOT bot token is refused', async () => {
	const bot = await createBot();
	await createBuilder(harness, `Bot ${bot.botToken}`).get('/users/@me').expect(200).execute();
	Config.instance.micupBotApplicationId = bot.application.id;
	const read = vi.spyOn(getApplicationRepository(), 'getApplication');
	await createBuilder(harness, `Bot ${bot.botToken}`).get('/users/@me').expect(401).execute();
	expect(read).not.toHaveBeenCalled();
});

it('the Roster bot token is still refused', async () => {
	const bot = await createBot();
	await createBuilder(harness, `Bot ${bot.botToken}`).get('/users/@me').expect(200).execute();
	Config.instance.rosterBotApplicationId = bot.application.id;
	const read = vi.spyOn(getApplicationRepository(), 'getApplication');
	await createBuilder(harness, `Bot ${bot.botToken}`).get('/users/@me').expect(401).execute();
	expect(read).not.toHaveBeenCalled();
});

it('no application configured refuses no bot', async () => {
	const bot = await createBot();
	for (const configuredId of [undefined, '', '999']) {
		Config.instance.rosterBotApplicationId = configuredId;
		Config.instance.micupBotApplicationId = configuredId;
		const user = await createBuilder<{id: string}>(harness, `Bot ${bot.botToken}`).get('/users/@me').execute();
		expect(user.id).toBe(bot.botUserId);
	}
});
