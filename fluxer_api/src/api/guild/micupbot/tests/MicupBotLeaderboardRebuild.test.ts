// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {leaderboardTop} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {GUILD, levelsFixture, taskHelpers} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import rebuildMicupBotLeaderboard from '@app/api/worker/tasks/RebuildMicupBotLeaderboard';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	await harness.reset();
});
afterEach(() => {
	clearWorkerDependencies();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('rebuild fills the top 1000 from all 16 buckets under one lock', async () => {
	const {levels, repository, kvClient} = levelsFixture();
	const rows = Array.from({length: 1_016}, (_, i) => ({
		userId: createUserID((BigInt(i < 1001 ? 16 : i - 1000) << 22n) + BigInt(i)),
		xp: BigInt(i + 1),
	}));
	for (const row of rows) await repository.setMemberXp(GUILD, row.userId, row.xp);
	const page = vi.spyOn(repository, 'listMemberLevelsPage');
	const lock = vi.spyOn(kvClient, 'setnx');
	setWorkerDependenciesForTest({kvClient});
	await rebuildMicupBotLeaderboard({guild_id: GUILD.toString()}, taskHelpers());
	const calls = page.mock.calls.length;
	await levels.rebuildLeaderboard({guild_id: GUILD.toString()});
	expect(page).toHaveBeenCalledTimes(calls);
	expect(lock).toHaveBeenCalledWith(`micupbot:lbr:${GUILD}`, '1', 300);
	expect(new Set(page.mock.calls.map(([, bucket]) => bucket)).size).toBe(16);
	expect(page.mock.calls.some(([, bucket, after, limit]) => bucket === 0 && after !== null && limit === 1000)).toBe(
		true,
	);
	expect(await leaderboardTop(kvClient, GUILD, 0, 1000)).toEqual(
		rows
			.slice(16)
			.reverse()
			.map(({userId, xp}) => ({userId: String(userId), xp: Number(xp)})),
	);
});
