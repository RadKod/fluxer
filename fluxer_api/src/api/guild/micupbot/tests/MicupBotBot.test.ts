// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {isMicupBotLive, micupBotApplicationId, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness, previousId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(() => {
	previousId = Config.instance.micupBotApplicationId;
});
afterEach(() => {
	Config.instance.micupBotApplicationId = previousId;
	overrideLimits({});
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});
it('no application id means no bot and not live', () => {
	overrideLimits({feature_micupbot: 1});
	for (const value of [undefined, '', ' ', 'not-a-number', '1.5', '-1']) {
		Config.instance.micupBotApplicationId = value;
		expect(micupBotApplicationId()).toBeNull();
		expect(micupBotUserId()).toBeNull();
		expect(isMicupBotLive(getLimitConfigService())).toBe(false);
	}
});
it('flag 0 means not live', () => {
	Config.instance.micupBotApplicationId = '1490000000000000001';
	overrideLimits({feature_micupbot: 0});
	expect(isMicupBotLive(getLimitConfigService())).toBe(false);
});
it('flag 1 and id means live and bot user id equals the application id', () => {
	Config.instance.micupBotApplicationId = '1490000000000000001';
	overrideLimits({feature_micupbot: 1});
	expect(isMicupBotLive(getLimitConfigService())).toBe(true);
	expect(micupBotApplicationId()).toBe(1490000000000000001n);
	expect(micupBotUserId()).toBe(micupBotApplicationId());
});
