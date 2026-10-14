// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {blockUser, createFriendship, updateUserSettings} from '@app/api/channel/tests/ChannelTestUtils';
import {feedDayAt} from '@app/api/feed/FeedRepository';
import {followDirectly} from '@app/api/feed/tests/FeedTestUtils';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {
	authorizeOAuth2,
	createOAuth2TestSetup,
	exchangeOAuth2AuthorizationCode,
} from '@app/api/oauth/tests/OAuthTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {STRANGER_DAILY_CAP} from '@app/api/user/profile/ProfileAccessCache';
import {getProfile, sharedGroupDm, sharedGuild, storeLevel} from '@app/api/user/tests/ProfileTestUtils';
import {sendFriendRequest} from '@app/api/user/tests/RelationshipTestUtils';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const {EVERYONE, ALL_GUILDS, SMALL_GUILDS_ONLY, FRIENDS_ONLY, ONLY_ME} = ProfilePrivacyLevels;

type Outcome = 'full' | 'public' | 'limited' | 403;

// A local calendar date `years` years before today, a day earlier so a birthday today never decides the case.
function bornYearsAgo(years: number): string {
	const date = new Date();
	date.setFullYear(date.getFullYear() - years);
	date.setDate(date.getDate() - 1);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Profile visibility matrix. Test accounts are brand new: a day
// later (aDayLater) a clean, verified viewer has a stranger's standing.
describe('GET /users/:id/profile — the visibility matrix (Kapı 2)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(() => vi.useRealTimers());
	afterAll(async () => {
		await harness?.shutdown();
	});

	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const account = () => createTestAccount(harness);
	const level = (owner: TestAccount, value: number) =>
		updateUserSettings(harness, owner.token, {profile_privacy: value});
	const strangerSet = (viewer: TestAccount) => `profile:stranger:${viewer.userId}:${feedDayAt(Date.now())}`;

	// full = everything the owner's field settings allow plus the mutual lists asked for; public = no mutual lists.
	async function expectView(token: string, owner: TestAccount, outcome: Outcome): Promise<void> {
		const request = getProfile(harness, token, owner);
		if (outcome === 403) return void (await request.expect(HTTP_STATUS.FORBIDDEN).execute());
		const profile = await request.execute();
		expect(profile.profile_limited === true, 'profile_limited').toBe(outcome === 'limited');
		if (outcome === 'full') expect(profile.mutual_friends, 'mutual lists on the full view').toBeDefined();
		if (outcome === 'public') {
			expect(profile.mutual_friends).toBeUndefined();
			expect(profile.mutual_guilds).toBeUndefined();
		}
	}

	it.each([
		[EVERYONE, 'public'],
		[ALL_GUILDS, 403],
		[FRIENDS_ONLY, 403],
		[ONLY_ME, 403],
	] as const)('1–4: a standing stranger, level %s → %s', async (value, outcome) => {
		const [owner, stranger] = [await account(), await account()];
		aDayLater();
		await level(owner, value);
		await expectView(stranger.token, owner, outcome);
	});

	it('5: a stranger younger than 24 hours or with an unverified email → 403', async () => {
		const [owner, fresh] = [await account(), await account()];
		await level(owner, EVERYONE);
		await expectView(fresh.token, owner, 403);
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		aDayLater();
		await getProfile(harness, unverified.token, owner).expect(HTTP_STATUS.FORBIDDEN).execute();
	});

	it('6: a bot token is never a stranger → 403', async () => {
		const owner = await account();
		const bot = await createTestBotAccount(harness);
		aDayLater();
		await level(owner, EVERYONE);
		await expectView(`Bot ${bot.botToken}`, owner, 403);
	});

	it('7: an OAuth bearer is never a stranger → 403', async () => {
		const owner = await account();
		const {endUser, redirectURI, application} = await createOAuth2TestSetup(harness);
		aDayLater();
		await level(owner, EVERYONE);
		const {code} = await authorizeOAuth2(harness, endUser.token, {
			client_id: application.id,
			redirect_uri: redirectURI,
			scope: 'identify',
		});
		const {access_token: accessToken} = await exchangeOAuth2AuthorizationCode(harness, {
			client_id: application.id,
			client_secret: application.client_secret,
			code,
			redirect_uri: redirectURI,
		});
		await expectView(`Bearer ${accessToken}`, owner, 403);
		await expectView(endUser.token, owner, 'public'); // the same account's session is a stranger
	});

	it('8: 100 stored for a 15-year-old reads as shared communities → 403', async () => {
		const [owner, stranger] = [await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)}), await account()];
		await storeLevel(owner, EVERYONE);
		aDayLater();
		await expectView(stranger.token, owner, 403);
	});

	it.each([
		['SPAMMER', UserFlags.SPAMMER],
		['DISABLED_SUSPICIOUS_ACTIVITY', UserFlags.DISABLED_SUSPICIOUS_ACTIVITY],
	] as const)('9: an owner flagged %s → 403', async (_name, flag) => {
		const [owner, stranger] = [await account(), await account()];
		await level(owner, EVERYONE);
		const repository = getUserRepository();
		const user = (await repository.findUnique(createUserID(BigInt(owner.userId))))!;
		await repository.patchUpsert(user.id, {flags: user.flags | flag}, user.toRow());
		aDayLater();
		await expectView(stranger.token, owner, 403);
	});

	it('10: a standing stranger the owner blocked → 403', async () => {
		const [owner, stranger] = [await account(), await account()];
		await blockUser(harness, owner, stranger.userId);
		aDayLater();
		await level(owner, EVERYONE);
		await expectView(stranger.token, owner, 403);
	});

	it('11: a shared guild member who blocked the owner → limited', async () => {
		const [owner, member] = [await account(), await account()];
		await sharedGuild(harness, owner, member);
		await blockUser(harness, member, owner.userId);
		await level(owner, EVERYONE);
		await expectView(member.token, owner, 'limited');
	});

	it('12: a friend under the legacy 1 → full', async () => {
		const [owner, friend] = [await account(), await account()];
		await createFriendship(harness, owner, friend);
		await storeLevel(owner, SMALL_GUILDS_ONLY);
		await expectView(friend.token, owner, 'full');
	});

	it('13: a shared group DM alone under the legacy 1 → limited (Ş5)', async () => {
		const [owner, viewer] = [await account(), await account()];
		await sharedGroupDm(harness, owner, viewer);
		await storeLevel(owner, SMALL_GUILDS_ONLY);
		await expectView(viewer.token, owner, 'limited');
	});

	it('14: a mutual follow under 2 → full (the widening, variant L)', async () => {
		const [owner, viewer] = [await account(), await account()];
		await followDirectly(viewer.userId, owner.userId);
		await followDirectly(owner.userId, viewer.userId);
		await level(owner, FRIENDS_ONLY);
		await expectView(viewer.token, owner, 'full');
	});

	it('15: a shared guild under 2 → limited', async () => {
		const [owner, member] = [await account(), await account()];
		await sharedGuild(harness, owner, member);
		await level(owner, FRIENDS_ONLY);
		await expectView(member.token, owner, 'limited');
	});

	it('16: the owner under 101 → the whole profile', async () => {
		const owner = await account();
		await level(owner, ONLY_ME);
		expect((await getProfile(harness, owner.token, owner).execute()).profile_limited).toBeUndefined();
	});

	it('17a/b: with the day full of 1 000 strangers a new one → 403, one already opened today → public (Ş10)', async () => {
		const [opened, fresh, stranger] = [await account(), await account(), await account()];
		aDayLater();
		await level(opened, EVERYONE);
		await level(fresh, EVERYONE);
		const others = Array.from({length: STRANGER_DAILY_CAP - 1}, (_, index) => String(9_000_000 + index));
		await harness.kvProvider.sadd(strangerSet(stranger), opened.userId, ...others);
		await expectView(stranger.token, fresh, 403);
		await expectView(stranger.token, opened, 'public');
	});

	it('17c: opening the same stranger profile again spends nothing (Ş10)', async () => {
		const [owner, stranger] = [await account(), await account()];
		aDayLater();
		await level(owner, EVERYONE);
		for (let request = 0; request < 5; request++) await expectView(stranger.token, owner, 'public');
		expect(await harness.kvProvider.scard(strangerSet(stranger))).toBe(1);
	});

	it('18: a pending request with standing under 100 → public, no mutual lists (denetim 1)', async () => {
		const [owner, viewer] = [await account(), await account()];
		await sendFriendRequest(harness, viewer.token, owner.userId);
		aDayLater();
		await level(owner, EVERYONE);
		await expectView(viewer.token, owner, 'public');
	});

	it('19: a pending request without standing under 100 → limited', async () => {
		const [owner, viewer] = [await account(), await account()];
		await sendFriendRequest(harness, viewer.token, owner.userId);
		await level(owner, EVERYONE);
		await expectView(viewer.token, owner, 'limited');
	});

	it("20: an account's 121st profile request in a minute → 429 from USER_GET_PROFILE_ACCOUNT, whatever the target", async () => {
		const [first, second, viewer] = [await account(), await account(), await account()];
		await createFriendship(harness, first, viewer);
		await createFriendship(harness, second, viewer);
		vi.useFakeTimers({now: Date.now(), toFake: ['Date']}); // the leaky bucket does not drain during the loop
		// 60 per target: the per-target bucket (100 in 10 s) never answers, only the account bucket can.
		const request = (index: number) =>
			getProfile(harness, viewer.token, index % 2 === 0 ? first : second)
				.header('x-fluxer-test-enable-rate-limits', 'true')
				.header('x-fluxer-test-global-rate-limit', '100000');
		for (let index = 0; index < 120; index++) await request(index).execute();
		const refused = await request(120).executeRaw();
		expect(refused.response.status).toBe(429);
		expect(refused.response.headers.get('X-RateLimit-Bucket')).toBe(
			createHash('sha256').update('user:profile:account').digest('hex').slice(0, 16),
		);
	});
});
