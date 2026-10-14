// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {getProfile, sharedGuild} from '@app/api/user/tests/ProfileTestUtils';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {ProfilePrivacyLevels, ThemeTypes} from '@fluxer/constants/src/UserConstants';
import type {UserSettingsResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

interface ValidationErrorResponse {
	code: string;
	errors?: Array<{path: string; code: string; message: string}>;
}

// A local calendar date `years` years and `extraDays` days before today (calculateAge counts local dates).
function bornYearsAgo(years: number, extraDays = 0): string {
	const date = new Date();
	date.setFullYear(date.getFullYear() - years);
	date.setDate(date.getDate() - extraDays);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// the public profile needs a date of birth and 16 years; the legacy 1 is stored as written.
describe('PATCH /users/@me/settings profile_privacy (Kapı 2 Ş6, Ş9)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(() => vi.useRealTimers());
	afterAll(async () => {
		await harness?.shutdown();
	});

	const patch = (token: string, body: Record<string, unknown>) =>
		createBuilder<UserSettingsResponse>(harness, token).patch('/users/@me/settings').body(body);
	const settingsOf = (token: string) => createBuilder<UserSettingsResponse>(harness, token).get('/users/@me/settings');

	it('refuses the public profile under 16 or without a date of birth (400, MUST_BE_MINIMUM_AGE, min 16)', async () => {
		const young = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)});
		const undated = await createTestAccount(harness);
		const repository = getUserRepository();
		const row = (await repository.findUnique(createUserID(BigInt(undated.userId))))!.toRow();
		await repository.patchUpsert(row.user_id, {date_of_birth: null}, row);

		for (const account of [young, undated]) {
			const before = (await settingsOf(account.token).execute()).profile_privacy;
			const refused = await createBuilder<ValidationErrorResponse>(harness, account.token)
				.patch('/users/@me/settings')
				.body({profile_privacy: ProfilePrivacyLevels.EVERYONE})
				.expect(400, 'INVALID_FORM_BODY')
				.execute();
			const error = refused.errors?.find((entry) => entry.path === 'profile_privacy');
			expect(error?.code).toBe('MUST_BE_MINIMUM_AGE');
			expect(error?.message).toContain('16');
			expect((await settingsOf(account.token).execute()).profile_privacy).toBe(before);
		}
	});

	it('keeps the legacy 1 as written for an older client; it reads as shared communities', async () => {
		const [owner, member] = [await createTestAccount(harness), await createTestAccount(harness)];
		await sharedGuild(harness, owner, member);
		await patch(owner.token, {profile_privacy: ProfilePrivacyLevels.SMALL_GUILDS_ONLY}).execute();
		expect((await settingsOf(owner.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.SMALL_GUILDS_ONLY);
		expect((await getProfile(harness, member.token, owner).execute()).profile_limited).toBeUndefined();
	});

	it('accepts 100 at 16 and 101 at any age, and the next profile request already sees the new level', async () => {
		const sixteen = await createTestAccount(harness, {dateOfBirth: bornYearsAgo(16, 1)});
		await patch(sixteen.token, {profile_privacy: ProfilePrivacyLevels.EVERYONE}).execute();
		expect((await settingsOf(sixteen.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.EVERYONE);

		const [young, friend] = [
			await createTestAccount(harness, {dateOfBirth: bornYearsAgo(15)}),
			await createTestAccount(harness),
		];
		await createFriendship(harness, young, friend);
		expect((await getProfile(harness, friend.token, young).execute()).profile_limited).toBeUndefined();
		await patch(young.token, {profile_privacy: ProfilePrivacyLevels.ONLY_ME}).execute();
		expect((await getProfile(harness, friend.token, young).execute()).profile_limited).toBe(true);
	});

	// a stored "Everyone" never opens by itself when the account later turns 16.
	it('the next profile request uses the DOB downgrade and a later eligible DOB cannot reopen it', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_UPDATE_DOB,
		]);
		const owner = await createTestAccount(harness);
		const stranger = await createTestAccount(harness);
		vi.useFakeTimers({now: Date.now() + 25 * 3_600_000, toFake: ['Date']});
		await patch(owner.token, {profile_privacy: ProfilePrivacyLevels.EVERYONE}).execute();
		await getProfile(harness, stranger.token, owner).execute();
		const changeDob = (dateOfBirth: string) =>
			createBuilder(harness, admin.token)
				.patch(`/admin/users/${owner.userId}/date-of-birth`)
				.body({date_of_birth: dateOfBirth})
				.execute();

		await changeDob(bornYearsAgo(15));
		await getProfile(harness, stranger.token, owner).expect(HTTP_STATUS.FORBIDDEN).execute();
		await changeDob(bornYearsAgo(17));
		await getProfile(harness, stranger.token, owner).expect(HTTP_STATUS.FORBIDDEN).execute();
		expect((await settingsOf(owner.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
	});

	it('an admin date of birth under 16 turns a stored 100 into 0; 16 or older, or another level, is left alone', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_UPDATE_DOB,
		]);
		const [publicMinor, publicAdult, friendsMinor] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		await patch(publicMinor.token, {profile_privacy: ProfilePrivacyLevels.EVERYONE}).execute();
		await patch(publicAdult.token, {profile_privacy: ProfilePrivacyLevels.EVERYONE}).execute();
		await patch(friendsMinor.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY}).execute();
		const changeDob = (account: TestAccount, dateOfBirth: string) =>
			createBuilder(harness, admin.token)
				.patch(`/admin/users/${account.userId}/date-of-birth`)
				.body({date_of_birth: dateOfBirth})
				.expect(HTTP_STATUS.OK)
				.execute();

		await changeDob(publicMinor, bornYearsAgo(14));
		await changeDob(publicAdult, bornYearsAgo(17));
		await changeDob(friendsMinor, bornYearsAgo(14));
		expect((await settingsOf(publicMinor.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.ALL_GUILDS);
		expect((await settingsOf(publicAdult.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.EVERYONE);
		expect((await settingsOf(friendsMinor.token).execute()).profile_privacy).toBe(ProfilePrivacyLevels.FRIENDS_ONLY);
	});

	it('V-1: two concurrent PATCHes (profile_privacy and theme) both land', async () => {
		const owner = await createTestAccount(harness);
		await Promise.all([
			patch(owner.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY}).execute(),
			patch(owner.token, {theme: ThemeTypes.LIGHT}).execute(),
		]);
		const settings = await settingsOf(owner.token).execute();
		expect(settings.profile_privacy).toBe(ProfilePrivacyLevels.FRIENDS_ONLY);
		expect(settings.theme).toBe(ThemeTypes.LIGHT);
	});
});
