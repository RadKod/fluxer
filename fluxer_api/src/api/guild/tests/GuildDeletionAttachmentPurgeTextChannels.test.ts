// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {createChannel, createGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {sendWithImage} from '@app/api/channel/tests/CrosspostWorkerTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import guildProcessDeletion from '@app/api/worker/tasks/GuildProcessDeletion';
import {clearWorkerDependencies, setWorkerDependencies} from '@app/api/worker/WorkerContext';
import {initializeWorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('Guild deletion attachment purge in text channels', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		harness.storageService.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearWorkerDependencies();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	test('purges the attachments of every message in every channel', async () => {
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'Purge Guild');
		const first = await createChannel(harness, owner.token, guild.id, 'one', ChannelTypes.GUILD_TEXT);
		const second = await createChannel(harness, owner.token, guild.id, 'two', ChannelTypes.GUILD_TEXT);
		const messages = [
			{channelId: first.id, message: await sendWithImage(harness, owner.token, first.id, {}, ['a.png', 'b.gif'])},
			{channelId: second.id, message: await sendWithImage(harness, owner.token, second.id, {})},
		];
		const expected = messages.flatMap(({channelId, message}) =>
			(message.attachments ?? []).map(
				(attachment) => `attachments/${channelId}/${attachment.id}/${attachment.filename}`,
			),
		);
		expect(expected).toHaveLength(3);
		for (const key of expected) {
			expect(harness.storageService.hasObject(Config.s3.buckets.cdn, key)).toBe(true);
		}
		// The delete route schedules the purge on the worker; run the queued job the way the worker would.
		const deletions: Array<Record<string, unknown>> = [];
		vi.spyOn(NoopWorkerService.prototype, 'addJob').mockImplementation((async (
			task: string,
			payload: Record<string, unknown>,
		) => {
			if (task === 'guildProcessDeletion') deletions.push(payload);
			return 0n;
		}) as never);
		await createBuilder(harness, owner.token)
			.post(`/guilds/${guild.id}/delete`)
			.body({password: owner.password})
			.expect(HTTP_STATUS.NO_CONTENT)
			.executeWithResponse();
		expect(deletions).toHaveLength(1);
		setWorkerDependencies(await initializeWorkerDependencies(getSnowflakeService()));
		await guildProcessDeletion(deletions[0]!, HELPERS);
		for (const key of expected) {
			expect(harness.storageService.hasObject(Config.s3.buckets.cdn, key)).toBe(false);
		}
	});
});
