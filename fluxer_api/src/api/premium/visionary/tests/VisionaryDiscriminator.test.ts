// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {lifetimeUser, mirrorMode, premiumMode} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium, updateUserProfile} from '@app/api/user/tests/UserTestUtils';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('#0000 on a self-hosted instance', () => {
	let harness: ApiTestHarness;
	let previousSelfHosted: boolean;

	beforeAll(async () => {
		previousSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(async () => {
		await premiumMode('everyone');
	});
	afterAll(async () => {
		await harness?.shutdown();
		Config.instance.selfHosted = previousSelfHosted;
	});

	async function premiumMember(): Promise<TestAccount> {
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		return account;
	}

	function patchMe(account: TestAccount, body: Record<string, unknown>) {
		return createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({...body, password: account.password})
			.executeRaw();
	}

	it('in mirror mode neither Premium nor Visionary can write human #0000', async () => {
		await mirrorMode();
		const member = await premiumMember();
		const {account: visionary} = await lifetimeUser(harness, {sequence: 1});

		const refused = await patchMe(member, {discriminator: '0000'});
		const taken = await patchMe(visionary, {discriminator: '0000'});

		expect(refused.response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(refused.text).toContain(ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
		expect(taken.response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(taken.text).toContain(ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
	});

	it('an account that already wears #0000 keeps it until it changes its name', async () => {
		const member = await premiumMember();
		// Micup: historical zero tags are fixtures; current writers cannot create them.
		await upsertOne(Users.patchByPk({user_id: createUserID(BigInt(member.userId))}, {discriminator: Db.set(0)}));
		await mirrorMode();

		const other = await updateUserProfile(harness, member.token, {global_name: 'Kept Tag'});
		const renamedKeepingTag = await patchMe(member, {username: 'visionaryless'});
		const renamedWithNewTag = await updateUserProfile(harness, member.token, {
			username: 'visionaryless',
			discriminator: '4242',
			password: member.password,
		});

		expect(other.json).toMatchObject({global_name: 'Kept Tag', discriminator: '0000'});
		expect(renamedKeepingTag.response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(renamedKeepingTag.text).toContain(ValidationErrorCodes.VISIONARY_REQUIRED_FOR_DISCRIMINATOR);
		expect(renamedWithNewTag.json).toMatchObject({username: 'visionaryless', discriminator: '4242'});
	});

	it('everyone mode also rejects writing human #0000', async () => {
		await premiumMode('everyone');
		const member = await premiumMember();

		const updated = await patchMe(member, {discriminator: '0000'});

		expect(updated.response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(updated.text).toContain(ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
	});
});
