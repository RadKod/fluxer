// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAdminApiKey} from '@app/api/admin/tests/AdminTestUtils';
import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {getGifDataUrl, getPngDataUrl, getSvgDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {getBadgeRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS, TEST_IDS} from '@app/api/test/TestConstants';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder, createBuilderWithoutAuth, type TestRequestBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import type {BadgeListResponse, BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import sharp from 'sharp';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

interface ValidationErrorResponse {
	code: string;
	errors?: Array<{path?: string; code?: string}>;
}

const SVG_BASE64 = getSvgDataUrl().split(',')[1]!;

const BADGE_ENDPOINTS = [
	['get', '/admin/badges', null],
	['post', '/admin/badges', {icon: getPngDataUrl(), description: 'Early supporter'}],
	['patch', '/admin/badges/1', {description: 'Beta tester'}],
	['post', '/admin/users/:self/badges/1', null],
	['delete', '/admin/users/:self/badges/1', null],
	['post', '/admin/badges/pioneer/backfill', {badge_id: '1', first_user_id: '1', excluded_user_ids: []}],
	['post', '/admin/badges/pioneer/stop', null],
] as const;

type BadgeEndpoint = (typeof BADGE_ENDPOINTS)[number];

function badgeRequest(
	builder: TestRequestBuilder,
	method: BadgeEndpoint[0],
	path: BadgeEndpoint[1],
	body: BadgeEndpoint[2],
	selfId: string,
): TestRequestBuilder {
	const request = builder[method](path.replace(':self', selfId));
	if (body) request.body(body);
	return request;
}

async function webpDataUrl(color: string): Promise<string> {
	const webp = await sharp({create: {width: 2, height: 2, channels: 4, background: color}})
		.webp()
		.toBuffer();
	return `data:image/webp;base64,${webp.toString('base64')}`;
}

describe('badge admin routes and profile badges', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	// The test setup wipes the store after every test, so each test needs its own accounts.
	beforeEach(async () => {
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.BADGES_MANAGE,
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createBadge(description = 'Early supporter', icon = getPngDataUrl()): Promise<BadgeResponse> {
		return createBuilder<BadgeResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon, description})
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	async function grant(userId: string, badgeId: string): Promise<void> {
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${userId}/badges/${badgeId}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	}

	async function getProfile(viewer: TestAccount, target: TestAccount): Promise<UserProfileFullResponse> {
		return createBuilder<UserProfileFullResponse>(harness, viewer.token)
			.get(`/users/${target.userId}/profile`)
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	function storedIcon(badgeId: string, hash: string) {
		return harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, `branding/badge-${badgeId}/${hash}`);
	}

	function badgeIconUploads(): number {
		return harness.storageService.uploadObjectSpy.mock.calls.filter(([params]) =>
			String((params as {key: string}).key).startsWith('branding/badge-'),
		).length;
	}

	it('creates a badge, stores its icon under branding/badge-<id>/<hash> and lists it', async () => {
		const badge = await createBadge();

		expect(badge.description).toBe('Early supporter');
		expect(badge.icon).toMatch(/^[0-9a-f]{8}$/);
		expect(await storedIcon(badge.id, badge.icon)).not.toBeNull();
		const list = await createBuilder<BadgeListResponse>(harness, admin.token)
			.get('/admin/badges')
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(list).toEqual([badge]);
	});

	it('stores an animated icon under the bare hash and returns it with the a_ prefix', async () => {
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockResolvedValueOnce({
			format: 'apng',
			content_type: 'image/apng',
			content_hash: 'x',
			size: 1,
			width: 128,
			height: 128,
			animated: true,
			nsfw: false,
		});

		const badge = await createBadge();

		expect(badge.icon).toMatch(/^a_[0-9a-f]{8}$/);
		expect(await storedIcon(badge.id, badge.icon.slice(2))).not.toBeNull();
	});

	it('accepts a WebP icon', async () => {
		const badge = await createBadge('Beta tester', await webpDataUrl('#5865f2'));

		expect(await storedIcon(badge.id, badge.icon)).not.toBeNull();
	});

	it.each([
		['an SVG icon', getSvgDataUrl()],
		['SVG bytes sent as a PNG data URL', getPngDataUrl(SVG_BASE64)],
		['a GIF icon', getGifDataUrl()],
	])('rejects %s by its bytes and stores nothing', async (_label, icon) => {
		const uploadsBefore = badgeIconUploads();

		const json = await createBuilder<ValidationErrorResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon, description: 'Nope'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();

		expect(json.errors?.[0]).toMatchObject({path: 'icon', code: 'INVALID_IMAGE_FORMAT'});
		expect(badgeIconUploads()).toBe(uploadsBefore);
	});

	it('rejects an icon the media proxy reads as SVG even when it starts with a PNG signature', async () => {
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockResolvedValueOnce({
			format: 'svg',
			content_type: 'image/svg+xml',
			content_hash: 'x',
			size: 1,
			animated: false,
			nsfw: false,
		});

		const json = await createBuilder<ValidationErrorResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon: getPngDataUrl(), description: 'Nope'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();

		expect(json.errors?.[0]).toMatchObject({path: 'icon', code: 'INVALID_IMAGE_FORMAT'});
	});

	it('updates the text and the icon of a badge', async () => {
		const badge = await createBadge();

		const renamed = await createBuilder<BadgeResponse>(harness, admin.token)
			.patch(`/admin/badges/${badge.id}`)
			.body({description: 'Founding member'})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(renamed).toEqual({...badge, description: 'Founding member'});

		const reiconed = await createBuilder<BadgeResponse>(harness, admin.token)
			.patch(`/admin/badges/${badge.id}`)
			.body({icon: await webpDataUrl('#ff0000')})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(reiconed.description).toBe('Founding member');
		expect(reiconed.icon).not.toBe(badge.icon);
		expect(await storedIcon(badge.id, reiconed.icon)).not.toBeNull();
	});

	it('answers 404 for an unknown badge on update and on grant, and UNKNOWN_USER for an unknown user', async () => {
		const target = await createTestAccount(harness);
		await createBuilder(harness, admin.token)
			.patch('/admin/badges/123456789012345678')
			.body({description: 'Ghost'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${target.userId}/badges/123456789012345678`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		const badge = await createBadge();
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${TEST_IDS.NONEXISTENT_USER}/badges/${badge.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_USER)
			.execute();
	});

	async function badgeApiKey(acls: Array<string>) {
		const owner = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.BADGES_MANAGE,
			AdminACLs.ADMIN_API_KEY_MANAGE,
		]);
		return {owner, key: await createAdminApiKey(harness, owner, 'Badge key', acls, null)};
	}

	it.each(BADGE_ENDPOINTS)(
		'%s %s answers 403 MISSING_ACL to an admin without badges:manage',
		async (method, path, body) => {
			const plainAdmin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE]);
			await badgeRequest(createBuilder(harness, plainAdmin.token), method, path, body, plainAdmin.userId)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACL)
				.execute();
		},
	);

	it.each(BADGE_ENDPOINTS)('%s %s answers 401 without a session', async (method, path, body) => {
		await badgeRequest(createBuilderWithoutAuth(harness), method, path, body, admin.userId)
			.expect(HTTP_STATUS.UNAUTHORIZED, APIErrorCodes.UNAUTHORIZED)
			.execute();
	});

	it.each(BADGE_ENDPOINTS)(
		'%s %s answers 403 MISSING_PERMISSIONS to a user without admin:authenticate',
		async (method, path, body) => {
			const user = await createTestAccount(harness);
			await badgeRequest(createBuilder(harness, user.token), method, path, body, user.userId)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS)
				.execute();
		},
	);

	it.each(BADGE_ENDPOINTS)(
		'%s %s answers 403 MISSING_ACL to an admin API key without badges:manage',
		async (method, path, body) => {
			const {owner, key} = await badgeApiKey([AdminACLs.AUTHENTICATE]);
			await badgeRequest(createBuilder(harness, key.token), method, path, body, owner.userId)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACL)
				.execute();
		},
	);

	it('refused create and grant leave the catalog and the profile unchanged', async () => {
		const badge = await createBadge();
		const target = await createTestAccount(harness);
		const user = await createTestAccount(harness);
		const {key} = await badgeApiKey([AdminACLs.AUTHENTICATE]);
		const uploadsBefore = badgeIconUploads();
		const refusals: Array<[() => TestRequestBuilder, number, string]> = [
			[() => createBuilderWithoutAuth(harness), HTTP_STATUS.UNAUTHORIZED, APIErrorCodes.UNAUTHORIZED],
			[() => createBuilder(harness, user.token), HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS],
			[() => createBuilder(harness, key.token), HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACL],
		];

		for (const [builder, status, code] of refusals) {
			await builder()
				.post('/admin/badges')
				.body({icon: getPngDataUrl(), description: 'Forged'})
				.expect(status, code)
				.execute();
			await builder().post(`/admin/users/${target.userId}/badges/${badge.id}`).expect(status, code).execute();
		}

		const list = await createBuilder<BadgeListResponse>(harness, admin.token)
			.get('/admin/badges')
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(list).toEqual([badge]);
		expect((await getProfile(target, target)).badges).toEqual([]);
		expect(badgeIconUploads()).toBe(uploadsBefore);
	});

	it('an admin API key with badges:manage can grant', async () => {
		const badge = await createBadge();
		const target = await createTestAccount(harness);
		const {key} = await badgeApiKey([AdminACLs.AUTHENTICATE, AdminACLs.BADGES_MANAGE]);

		await createBuilder(harness, key.token)
			.post(`/admin/users/${target.userId}/badges/${badge.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect((await getProfile(target, target)).badges).toEqual([badge]);
		expect(await getBadgeRepository().listUserBadges(createUserID(BigInt(target.userId)))).toEqual([
			expect.objectContaining({sequence: null}),
		]);
	});

	it('shows a granted badge on the profile, never sets STAFF, and drops it after revoke', async () => {
		const target = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await createFriendship(harness, target, viewer);
		const badge = await createBadge();

		expect((await getProfile(viewer, target)).badges).toEqual([]);
		await grant(target.userId, badge.id);
		await grant(target.userId, badge.id);
		const granted = await getProfile(viewer, target);
		expect(granted.badges).toEqual([badge]);
		expect(granted.user.flags).toBe(0);

		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${target.userId}/badges/${badge.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getProfile(viewer, target)).badges).toEqual([]);
	});

	it('shows a badge renamed after the grant with its new text', async () => {
		const target = await createTestAccount(harness);
		const badge = await createBadge();
		await grant(target.userId, badge.id);
		expect((await getProfile(target, target)).badges).toEqual([badge]);

		await createBuilder(harness, admin.token)
			.patch(`/admin/badges/${badge.id}`)
			.body({description: 'Founding member'})
			.expect(HTTP_STATUS.OK)
			.execute();

		expect((await getProfile(target, target)).badges).toEqual([{...badge, description: 'Founding member'}]);
	});

	it('leaves badges out of a restricted profile', async () => {
		const target = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const badge = await createBadge();
		await grant(target.userId, badge.id);
		await createBuilder(harness, target.token)
			.patch('/users/@me/settings')
			.body({profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY})
			.execute();
		const guild = await createGuild(harness, target.token, 'Badge Privacy Guild');
		const channel = await getChannel(harness, target.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, target.token, channel.id);
		await acceptInvite(harness, viewer.token, invite.code);

		const profile = await getProfile(viewer, target);

		expect(profile.profile_limited).toBe(true);
		expect(profile).not.toHaveProperty('badges');
	});

	it('drops the granted badges on account deletion, twice without error', async () => {
		const target = await createTestAccount(harness);
		const first = await createBadge('First');
		const second = await createBadge('Second');
		await grant(target.userId, first.id);
		await grant(target.userId, second.id);
		const userId = createUserID(BigInt(target.userId));

		await runUserDeletionHook('badges', {userId});
		await runUserDeletionHook('badges', {userId});

		expect((await getProfile(target, target)).badges).toEqual([]);
	});

	it('lists the granted badges in the data export', async () => {
		const target = await createTestAccount(harness);
		const badge = await createBadge();
		await grant(target.userId, badge.id);

		const extensions = await collectUserHarvestExtensions({userId: createUserID(BigInt(target.userId))});

		expect(extensions.find((extension) => extension.name === 'badges')?.data).toEqual([
			{id: badge.id, icon: badge.icon, description: badge.description, granted_at: expect.any(String)},
		]);
	});
});
