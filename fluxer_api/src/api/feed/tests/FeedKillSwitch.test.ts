// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {
	createDefaultLimitConfig,
	mergeWithCurrentDefaults,
	sanitizeLimitConfigForInstance,
} from '@app/api/constants/LimitConfig';
import {getLimitConfigService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {LimitConfigSnapshot, LimitRule} from '@fluxer/limits/src/LimitTypes';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

// feature_feed is the feed's kill switch. The admin Limit Config form sends a whole rule, the API
// merges it with the current defaults (LimitConfigService.updateConfig), and a trait rule only raises a limit
// (Math.max in LimitRuleRuntime). So the admin form has to send the 0, and the feed closes for an account only once
// no rule it matches keeps feature_feed at 1: default, premium and any trait rule made from the defaults.
const INSTANCE = {selfHosted: false} as const;
const SUPPORTER_TRAIT = 'feed_supporter';
const SUPPORTER_RULE = 'feed_supporters';

type RuleId = 'default' | 'premium' | typeof SUPPORTER_RULE;

// null = the form posted no feature_feed field for that rule.
type FeedByRule = Partial<Record<RuleId, number | null>>;

// Every route behind FeedEnabled. The switch runs before validation, so placeholder IDs and no bodies are enough.
const PLACEHOLDER_ID = '1';
const FEED_ROUTES: ReadonlyArray<readonly ['get' | 'post' | 'put' | 'delete', string]> = [
	['post', '/feed/attachments'],
	['post', '/feed/posts'],
	['get', `/feed/posts/${PLACEHOLDER_ID}`],
	['delete', `/feed/posts/${PLACEHOLDER_ID}`],
	['get', '/feed/home'],
	['get', '/feed/discover'],
	['get', `/users/${PLACEHOLDER_ID}/posts`],
	['put', `/feed/posts/${PLACEHOLDER_ID}/like`],
	['delete', `/feed/posts/${PLACEHOLDER_ID}/like`],
	['put', `/feed/posts/${PLACEHOLDER_ID}/poll/vote`],
	['get', `/feed/posts/${PLACEHOLDER_ID}/likes`],
	['get', `/feed/posts/${PLACEHOLDER_ID}/comments`],
	['post', `/feed/posts/${PLACEHOLDER_ID}/comments`],
	['delete', `/feed/posts/${PLACEHOLDER_ID}/comments/${PLACEHOLDER_ID}`],
	['post', '/reports/feed-post'],
	['post', '/reports/feed-comment'],
	['get', '/feed/notifications'],
	['post', '/feed/videos'],
	['post', `/feed/videos/${PLACEHOLDER_ID}/signature`],
	['delete', `/feed/videos/${PLACEHOLDER_ID}`],
	['get', '/feed/videos'],
	['post', '/feed/views'],
];

function withFeed(limits: LimitRule['limits'], value: number | null): LimitRule['limits'] {
	const {feature_feed: _posted, ...others} = limits;
	return value === null ? others : {...others, feature_feed: value};
}

// The config the API holds after the admin saves: the stock rules plus a trait rule made in the admin (its "create"
// copies defaults["default"], fluxer_admin system_actions.rs), feature_feed as posted, merged the way updateConfig does.
function savedLimitConfig(feed: FeedByRule): LimitConfigSnapshot {
	const stock = createDefaultLimitConfig(INSTANCE);
	const copiedDefaults = stock.rules.find((rule) => rule.id === 'default')!.limits;
	const rules: Array<LimitRule> = [
		...stock.rules,
		{id: SUPPORTER_RULE, filters: {traits: [SUPPORTER_TRAIT]}, limits: {...copiedDefaults}},
	];
	const stored: LimitConfigSnapshot = {
		traitDefinitions: stock.traitDefinitions,
		rules: rules.map((rule) => {
			const value = feed[rule.id as RuleId];
			return value === undefined ? rule : {...rule, limits: withFeed(rule.limits, value)};
		}),
	};
	return mergeWithCurrentDefaults(sanitizeLimitConfigForInstance(stored, INSTANCE), INSTANCE);
}

function ruleOf(config: LimitConfigSnapshot, id: RuleId): LimitRule {
	return config.rules.find((rule) => rule.id === id)!;
}

describe('feed kill switch', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	function useLimitConfig(feed: FeedByRule): void {
		vi.spyOn(getLimitConfigService(), 'getConfigSnapshot').mockReturnValue(savedLimitConfig(feed));
	}

	async function account(options: {premium?: boolean; supporter?: boolean} = {}): Promise<TestAccount> {
		const created = await createTestAccount(harness);
		if (options.premium) {
			await grantPremium(harness, created.userId, UserPremiumTypes.SUBSCRIPTION);
		}
		if (options.supporter) {
			const id = createUserID(BigInt(created.userId));
			const user = (await getUserRepository().findUnique(id))!;
			await getUserRepository().patchUpsert(id, {traits: new Set([SUPPORTER_TRAIT])}, user.toRow());
		}
		return created;
	}

	async function expectFeedOpen(viewer: TestAccount): Promise<void> {
		await createBuilder(harness, viewer.token).get('/feed/home').expect(HTTP_STATUS.OK).execute();
	}

	// The routes that do not answer 403 FEATURE_TEMPORARILY_DISABLED, with what they answered instead.
	async function routesStillOpen(viewer: TestAccount): Promise<Array<string>> {
		const open: Array<string> = [];
		for (const [method, path] of FEED_ROUTES) {
			try {
				await createBuilder(harness, viewer.token)
					[method](path)
					.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
					.execute();
			} catch (error) {
				open.push(`${method.toUpperCase()} ${path}: ${(error as Error).message}`);
			}
		}
		return open;
	}

	it('keeps feature_feed 0 written to the default rule after the merge with defaults', () => {
		const saved = ruleOf(savedLimitConfig({default: 0}), 'default');
		expect(saved.limits.feature_feed).toBe(0);
		expect(saved.modifiedFields).toContain('feature_feed');
		// Before F0 an unticked box posted no field, and the merge put the default (1) back.
		expect(ruleOf(savedLimitConfig({default: null}), 'default').limits.feature_feed).toBe(1);
	});

	it('0 in the default rule closes the feed routes for an account without premium', async () => {
		const plain = await account();
		await expectFeedOpen(plain);
		useLimitConfig({default: 0});
		expect(await routesStillOpen(plain)).toEqual([]);
	});

	it('a premium account keeps the feed until the premium rule is 0 too', async () => {
		const premium = await account({premium: true});
		useLimitConfig({default: 0});
		await expectFeedOpen(premium);
		useLimitConfig({default: 0, premium: 0});
		expect(await routesStillOpen(premium)).toEqual([]);
	});

	it('an admin-made trait rule copied from the defaults keeps the feed for its accounts until it is 0 too', async () => {
		const supporter = await account({supporter: true});
		useLimitConfig({default: 0, premium: 0});
		await expectFeedOpen(supporter);
		useLimitConfig({default: 0, premium: 0, [SUPPORTER_RULE]: 0});
		expect(await routesStillOpen(supporter)).toEqual([]);
	});

	it('0 in every rule where it was 1 closes the feed for everyone', async () => {
		const viewers = [
			await account(),
			await account({premium: true}),
			await account({supporter: true}),
			await account({premium: true, supporter: true}),
		];
		const everyRuleOff = {default: 0, premium: 0, [SUPPORTER_RULE]: 0};
		const stillOn = savedLimitConfig(everyRuleOff).rules.filter((rule) => (rule.limits.feature_feed ?? 0) > 0);
		expect(stillOn.map((rule) => rule.id)).toEqual([]);

		useLimitConfig(everyRuleOff);
		for (const viewer of viewers) {
			expect(await routesStillOpen(viewer)).toEqual([]);
		}

		useLimitConfig({});
		for (const viewer of viewers) {
			await expectFeedOpen(viewer);
		}
	});
});
