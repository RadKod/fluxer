// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {UserAccountProfileService} from '@app/api/user/services/UserAccountProfileService';
import {processUserDeletion} from '@app/api/user/services/UserDeletionService';
import {
	deleteAccount,
	fetchUser,
	fetchUserMe,
	fetchUserProfile,
	grantPremium,
	setPendingDeletionAt,
} from '@app/api/user/tests/UserTestUtils';
import {initializeWorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import type {UserUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import type {UserPrivateResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

interface ErrorResponse {
	code: string;
	errors?: Array<{path?: string; code?: string}>;
}

const STYLE = {font_id: 6, colors: [0xffffff, 0x9b87ff]};
const THEME = [0x1e1b4b, 0x07a3b2];

describe('Plus name style and profile theme on PATCH /users/@me', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function plusAccount(): Promise<TestAccount> {
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		return account;
	}

	function patch(account: TestAccount, body: Record<string, unknown>) {
		return createBuilder<UserPrivateResponse>(harness, account.token).patch('/users/@me').body(body);
	}

	async function rejected(account: TestAccount, body: Record<string, unknown>): Promise<ErrorResponse> {
		return createBuilder<ErrorResponse>(harness, account.token)
			.patch('/users/@me')
			.body(body)
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
	}

	async function shareGuild(owner: TestAccount, member: TestAccount): Promise<void> {
		const guild = await createGuild(harness, owner.token, 'Plus Appearance Guild');
		const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, member.token, invite.code);
	}

	function spyOnPropagationJobs() {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		return () => (addJob.mock.calls as Array<Array<unknown>>).filter(([task]) => task === 'propagatePartialUserChange');
	}

	it.each([
		['name_style', STYLE, 'NAME_STYLES_REQUIRE_PREMIUM'],
		['theme_colors', THEME, 'PROFILE_THEMES_REQUIRE_PREMIUM'],
	])('rejects %s without Plus', async (field, value, code) => {
		const account = await createTestAccount(harness);
		const json = await rejected(account, {[field]: value});
		expect(json.errors?.[0]).toMatchObject({path: field, code});
	});

	it.each([
		['name_style', STYLE, 'NAME_STYLES_REQUIRE_PREMIUM'],
		['theme_colors', THEME, 'PROFILE_THEMES_REQUIRE_PREMIUM'],
	])(
		'rejects %s for a premium override without a premium type, which would never show it',
		async (field, value, code) => {
			const account = await createTestAccount(harness);
			await createBuilderWithoutAuth(harness)
				.patch(`/test/users/${account.userId}/premium-flags`)
				.body({premium_flags: PremiumFlags.ENABLED_OVERRIDE})
				.execute();
			const json = await rejected(account, {[field]: value});
			expect(json.errors?.[0]).toMatchObject({path: field, code});
		},
	);

	it('refuses a bot token on PATCH /users/@me', async () => {
		const bot = await createTestBotAccount(harness);
		const json = await createBuilder<ErrorResponse>(harness, `Bot ${bot.botToken}`)
			.patch('/users/@me')
			.body({name_style: STYLE, theme_colors: THEME})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		expect(json.code).toBe(APIErrorCodes.ACCESS_DENIED);
	});

	it.each([
		['name_style', {name_style: STYLE} as UserUpdateRequest, 'NAME_STYLES_REQUIRE_PREMIUM'],
		['theme_colors', {theme_colors: THEME} as UserUpdateRequest, 'PROFILE_THEMES_REQUIRE_PREMIUM'],
	])('refuses %s for a bot whose limits allow it, which would never show it', async (field, data, code) => {
		const bot = await createTestBotAccount(harness);
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(bot.botUserId)));
		const service = new UserAccountProfileService({
			limitConfigService: getLimitConfigService(),
			rateLimitService: {checkLimit: async () => ({allowed: true})},
		} as unknown as ConstructorParameters<typeof UserAccountProfileService>[0]);
		const error = await service.processProfileUpdates({user, data}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(InputValidationError);
		expect((error as InputValidationError).getLocalizedErrors()?.[0]).toMatchObject({path: field, code});
	});

	it('always accepts null without Plus', async () => {
		const account = await createTestAccount(harness);
		const updated = await patch(account, {name_style: null, theme_colors: null}).expect(HTTP_STATUS.OK).execute();
		expect(updated).toMatchObject({name_style: null, theme_colors: null});
	});

	it('saves both for Plus and shows the style on the partial user and the theme on the profile only', async () => {
		const account = await plusAccount();
		const viewer = await createTestAccount(harness);
		await shareGuild(account, viewer);
		const updated = await patch(account, {name_style: STYLE, theme_colors: THEME}).expect(HTTP_STATUS.OK).execute();
		expect(updated).toMatchObject({name_style: STYLE, theme_colors: THEME});

		const {json: partial} = await fetchUser(harness, account.userId, viewer.token);
		expect(partial.name_style).toEqual(STYLE);
		expect(partial).not.toHaveProperty('theme_colors');
		const {json: profile} = await fetchUserProfile(harness, account.userId, viewer.token);
		expect(profile.user_profile.theme_colors).toEqual(THEME);
		expect(profile.user.name_style).toEqual(STYLE);
		expect(profile.user).not.toHaveProperty('theme_colors');
	});

	it('saves a solid name and removes both with null', async () => {
		const account = await plusAccount();
		await patch(account, {name_style: {font_id: 3, colors: [0xff6b6b]}, theme_colors: THEME})
			.expect(HTTP_STATUS.OK)
			.execute();
		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.name_style).toEqual({font_id: 3, colors: [0xff6b6b]});
		const cleared = await patch(account, {name_style: null, theme_colors: null}).expect(HTTP_STATUS.OK).execute();
		expect(cleared).toMatchObject({name_style: null, theme_colors: null});
	});

	it('propagates a name style change to guilds and keeps a theme change on the account', async () => {
		const account = await plusAccount();
		const propagationJobs = spyOnPropagationJobs();
		await patch(account, {theme_colors: THEME}).expect(HTTP_STATUS.OK).execute();
		expect(propagationJobs()).toHaveLength(0);
		await patch(account, {name_style: STYLE}).expect(HTTP_STATUS.OK).execute();
		expect(propagationJobs()).toHaveLength(1);
	});

	it('rejects an unknown font', async () => {
		const account = await plusAccount();
		await rejected(account, {name_style: {font_id: 13, colors: [0xffffff]}});
		await rejected(account, {name_style: {font_id: 0, colors: [0xffffff]}});
	});

	it.each([
		['a colour too dark for the dark chat background', [0x202020]],
		['a gradient whose middle is too dark', [0xff0000, 0x00ff00]],
	])('rejects %s', async (_name, colors) => {
		const account = await plusAccount();
		const json = await rejected(account, {name_style: {font_id: 1, colors}});
		expect(json.errors?.[0]).toMatchObject({path: 'name_style', code: 'NAME_COLORS_NOT_READABLE'});
	});

	it('keeps the stored style and theme when Plus ends and shows them again when it returns', async () => {
		const account = await plusAccount();
		const viewer = await createTestAccount(harness);
		await patch(account, {name_style: STYLE, theme_colors: THEME}).expect(HTTP_STATUS.OK).execute();

		await createBuilderWithoutAuth(harness)
			.post(`/test/users/${account.userId}/premium`)
			.body({premium_type: null})
			.execute();
		const {json: lapsed} = await fetchUserMe(harness, account.token);
		expect(lapsed).toMatchObject({name_style: null, theme_colors: null});
		expect((await fetchUser(harness, account.userId, viewer.token)).json.name_style).toBeNull();

		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		const {json: renewed} = await fetchUserMe(harness, account.token);
		expect(renewed).toMatchObject({name_style: STYLE, theme_colors: THEME});
	});

	it('limits name style changes to five per window and does not count a resend', async () => {
		const account = await plusAccount();
		for (const font_id of [1, 2, 3, 4, 5]) {
			await patch(account, {name_style: {font_id, colors: [0xffffff]}})
				.expect(HTTP_STATUS.OK)
				.execute();
		}
		await patch(account, {name_style: {font_id: 5, colors: [0xffffff]}})
			.expect(HTTP_STATUS.OK)
			.execute();
		const json = await rejected(account, {name_style: {font_id: 6, colors: [0xffffff]}});
		expect(json.errors?.[0]).toMatchObject({path: 'name_style', code: 'NAME_STYLE_CHANGED_TOO_MANY_TIMES'});
	});

	it('limits profile theme changes to twenty-five per window', async () => {
		const account = await plusAccount();
		for (let step = 1; step <= 25; step++) {
			await patch(account, {theme_colors: [step, 0xffffff]})
				.expect(HTTP_STATUS.OK)
				.execute();
		}
		const json = await rejected(account, {theme_colors: [26, 0xffffff]});
		expect(json.errors?.[0]).toMatchObject({path: 'theme_colors', code: 'THEME_COLORS_CHANGED_TOO_MANY_TIMES'});
	});

	it('clears the stored style and theme when the account is deleted', async () => {
		const account = await plusAccount();
		await patch(account, {name_style: STYLE, theme_colors: THEME}).expect(HTTP_STATUS.OK).execute();
		await deleteAccount(harness, account.token, account.password);
		const schedule = new Date(Date.now() - 60000);
		await setPendingDeletionAt(harness, account.userId, schedule);
		const deps = await initializeWorkerDependencies(getSnowflakeService());
		const id = createUserID(BigInt(account.userId));
		await processUserDeletion(id, schedule, 0, deps);
		const deleted = await deps.userRepository.findUniqueAssert(id);
		expect([
			deleted.nameFont,
			deleted.nameColor,
			deleted.nameColor2,
			deleted.themePrimaryColor,
			deleted.themeAccentColor,
		]).toEqual([null, null, null, null, null]);
	});

	it.each([
		['name_style', STYLE],
		['theme_colors', THEME],
	])('requires a verified email for %s', async (field, value) => {
		const account = await plusAccount();
		await createBuilder(harness, '')
			.post(`/test/users/${account.userId}/security-flags`)
			.body({email_verified: false})
			.execute();
		const json = await createBuilder<ErrorResponse>(harness, account.token)
			.patch('/users/@me')
			.body({[field]: value})
			.expect(403)
			.execute();
		expect(json.code).toBe(APIErrorCodes.PROFILE_EMAIL_VERIFICATION_REQUIRED);
	});
});
