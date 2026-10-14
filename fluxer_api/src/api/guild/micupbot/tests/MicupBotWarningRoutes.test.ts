// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {createMicupBotFixture, type MicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {addMemberRole, updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {MicupBotWarningListResponse} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let f: MicupBotFixture;
let originalId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalId = Config.instance.micupBotApplicationId;
	await harness.reset();
	f = await createMicupBotFixture(harness);
});
afterEach(() => {
	Config.instance.micupBotApplicationId = originalId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('MODERATE_MEMBERS lists, deletes and clears warnings', async () => {
	const moderator = await f.member(Permissions.MODERATE_MEMBERS);
	const target = await f.member();
	await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: target.role.id, position: 1}]);
	const first = await f.seedWarning(target.userId);
	const last = await f.seedWarning(target.userId);
	const path = `${f.base}/warnings/${target.userId}`;
	const list = () => createBuilder<MicupBotWarningListResponse>(harness, moderator.token).get(path).execute();
	const result = await list();
	expect(result.warnings.map((w) => w.id)).toEqual([last.warning_id.toString(), first.warning_id.toString()]);
	expect(result.warnings[0]).toEqual({
		id: last.warning_id.toString(),
		moderator_id: f.owner.userId,
		reason: last.reason,
		created_at: last.created_at.toISOString(),
	});
	await createBuilder(harness, moderator.token).delete(`${path}/${last.warning_id}`).expect(204).execute();
	expect((await list()).warnings.map((w) => w.id)).toEqual([first.warning_id.toString()]);
	await createBuilder(harness, moderator.token).delete(path).expect(204).execute();
	expect(await list()).toEqual({warnings: []});
});

it.each(['owner', 'equal', 'higher'] as const)(
	'warning deletion and clearing refuse a target with %s hierarchy',
	async (hierarchy) => {
		const moderator = await f.member(Permissions.MODERATE_MEMBERS);
		const target = await f.member();
		if (hierarchy === 'equal') {
			await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: target.role.id, position: 1}]);
			await addMemberRole(harness, f.owner.token, f.guild.id, target.userId, moderator.role.id);
		} else if (hierarchy === 'higher') {
			await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: target.role.id, position: 10}]);
		}
		const targetId = hierarchy === 'owner' ? f.owner.userId : target.userId;
		const warning = await f.seedWarning(targetId);
		const path = `${f.base}/warnings/${targetId}`;
		for (const suffix of [`/${warning.warning_id}`, '']) {
			const {response, json} = await createBuilder(harness, moderator.token).delete(`${path}${suffix}`).executeRaw();
			expect.soft(response.status).toBe(403);
			expect.soft(json).toMatchObject({code: APIErrorCodes.MISSING_PERMISSIONS});
			expect.soft(await f.repository.listWarnings(f.guildId, warning.user_id, 100)).toEqual([warning]);
		}
	},
);

it('deleting a missing warning answers 404', async () => {
	await createBuilder(harness, f.owner.token)
		.delete(`${f.base}/warnings/${f.owner.userId}/1490000000000000001`)
		.expect(404, APIErrorCodes.UNKNOWN_MICUPBOT_WARNING)
		.execute();
	const warning = await f.seedWarning();
	const other = await f.member();
	await createBuilder(harness, f.owner.token)
		.delete(`${f.base}/warnings/${other.userId}/${warning.warning_id}`)
		.expect(404, APIErrorCodes.UNKNOWN_MICUPBOT_WARNING)
		.execute();
	expect(await f.repository.listWarnings(f.guildId, warning.user_id, 100)).toEqual([warning]);
});

it('warning lists return at most 100 newest records', async () => {
	let lastId = '';
	for (let i = 0; i < 101; i++) lastId = (await f.seedWarning()).warning_id.toString();
	const result = await createBuilder<MicupBotWarningListResponse>(harness, f.owner.token)
		.get(`${f.base}/warnings/${f.owner.userId}`)
		.execute();
	expect(result.warnings).toHaveLength(100);
	expect(result.warnings[0]!.id).toBe(lastId);
});
