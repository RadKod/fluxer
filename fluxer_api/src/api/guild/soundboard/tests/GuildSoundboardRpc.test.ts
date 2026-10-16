// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('Soundboard distributed rate limit internal RPC', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	const body = {type: 'soundboard_play_rate_limit', user_id: '101', channel_id: '301'};
	const request = () =>
		createBuilder<{type: string; data: {allowed: boolean}}>(harness, '')
			.post('/internal/rpc')
			.header('x-fluxer-rpc-auth', Config.internal.gatewayRpcAuthToken)
			.body(body)
			.expect(200)
			.execute();
	it('authenticates the reverse RPC before charging a bucket', async () => {
		await createBuilder(harness, '').post('/internal/rpc').body(body).expect(401).execute();
		for (let i = 0; i < 4; i++) expect(await request()).toEqual({type: body.type, data: {allowed: true}});
		expect(await request()).toEqual({type: body.type, data: {allowed: false}});
	});
});
