// SPDX-License-Identifier: AGPL-3.0-or-later

import {createEmojiID, createMessageID} from '@app/api/BrandedTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {type MicupBotReactionChange, notifyMicupBotReaction} from '@app/api/guild/micupbot/MicupBotReactionHook';
import {drainMemberHooks, useMemberFixture} from '@app/api/guild/micupbot/tests/MicupBotMemberTestUtils';
import {Logger} from '@app/api/Logger';
import * as Registry from '@app/api/middleware/ServiceRegistry';
import {expect, it, vi} from 'vitest';

const fixture = useMemberFixture();
type Fixture = Awaited<ReturnType<typeof fixture>>;
function change(f: Fixture): Extract<MicupBotReactionChange, {kind: 'add' | 'remove'}> {
	return {
		kind: 'add',
		guildId: f.guildId,
		channelId: f.channelId,
		messageId: createMessageID(1490000000000000000n),
		authorId: f.botId,
		userId: f.userId,
		emojiName: '✅',
		emojiId: undefined,
		atMs: 1234,
	};
}

it('a reaction on a message not written by MicupBOT queues nothing and reads nothing', async () => {
	const f = await fixture();
	notifyMicupBotReaction(change(f));
	expect(f.jobs).toHaveBeenCalledOnce();
	f.jobs.mockClear();
	const worker = vi.spyOn(Registry, 'getWorkerService');
	const kv = vi.spyOn(Registry, 'getKVClient');
	const settings = vi.spyOn(f.repository, 'getSettings');
	const panel = vi.spyOn(f.repository, 'getPanel');
	const reaction = vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists');
	const limits = vi.spyOn(f.deps.limitConfigService, 'getConfigSnapshot').mockClear();
	notifyMicupBotReaction({...change(f), authorId: f.userId});
	for (const spy of [f.jobs, worker, kv, settings, panel, reaction, limits]) expect(spy).not.toHaveBeenCalled();
});

it("the bot's own reaction is ignored", async () => {
	const f = await fixture();
	notifyMicupBotReaction(change(f));
	expect(f.jobs).toHaveBeenCalledOnce();
	f.jobs.mockClear();
	notifyMicupBotReaction({...change(f), userId: f.botId});
	expect(f.jobs).not.toHaveBeenCalled();
});

it('reaction payloads preserve emoji identity and time without ledger writes', async () => {
	const f = await fixture();
	const input = {...change(f), kind: 'remove' as const, emojiId: createEmojiID(555n), emojiName: 'blue'};
	expect(notifyMicupBotReaction(input)).toBeUndefined();
	expect(f.jobs).toHaveBeenCalledWith(
		'applyMicupBotReactionRole',
		{
			kind: 'remove',
			guild_id: String(f.guildId),
			channel_id: String(f.channelId),
			message_id: String(input.messageId),
			user_id: String(f.userId),
			emoji_name: 'blue',
			emoji_id: '555',
			at: 1234,
		},
		{jobKey: `rr:${input.messageId}:${f.userId}:555:1234`, skipLedger: true},
	);
});

it('disabled MicupBOT, DMs and clear reactions queue nothing', async () => {
	const f = await fixture();
	notifyMicupBotReaction(change(f));
	expect(f.jobs).toHaveBeenCalledOnce();
	f.jobs.mockClear();
	notifyMicupBotReaction({...change(f), guildId: null});
	notifyMicupBotReaction({...change(f), kind: 'clear'});
	overrideLimits({feature_micupbot: 0});
	notifyMicupBotReaction(change(f));
	expect(f.jobs).not.toHaveBeenCalled();
});

it('synchronous and asynchronous reaction queue failures never escape', async () => {
	const f = await fixture();
	const warn = vi.spyOn(Logger.child({}), 'warn');
	f.jobs.mockImplementationOnce(() => {
		throw new Error('sync failure');
	});
	expect(() => notifyMicupBotReaction(change(f))).not.toThrow();
	f.jobs.mockRejectedValueOnce(new Error('async failure'));
	expect(notifyMicupBotReaction(change(f))).toBeUndefined();
	await drainMemberHooks();
	expect(warn).toHaveBeenCalledTimes(2);
	vi.spyOn(Registry, 'getWorkerService').mockImplementation(() => {
		throw new Error('worker unavailable');
	});
	warn.mockImplementation(() => {
		throw new Error('logger unavailable');
	});
	expect(() => notifyMicupBotReaction(change(f))).not.toThrow();
});
