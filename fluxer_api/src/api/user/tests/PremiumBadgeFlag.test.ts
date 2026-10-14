// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import type {UserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {fetchUser, fetchUserMe, grantPremium, updateUserSettings} from '@app/api/user/tests/UserTestUtils';
import {
	hasPartialUserFieldsChanged,
	mapUserToPartialResponse,
	mapUserToPrivateResponse,
} from '@app/api/user/UserMappers';
import {ProfilePrivacyLevels, PublicUserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {UserPrivateResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// Micup: the same vectors drive the Rust twin (fluxer_common user_flags::public_user_flags, used by fluxer_users and
// fluxer_messages), so a rule change that only one side makes fails somewhere.
const VECTORS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../fluxer_common/src/testdata/premium_badge_flag_vectors.json',
);

interface PremiumBadgeFlagVector {
	name: string;
	row: {flags: number; bot: boolean; premium_type: number | null; premium_flags: number | null};
	public_flags: number;
}

function readVectors(): Array<PremiumBadgeFlagVector> {
	const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`no premium badge flag vectors in ${VECTORS_PATH}`);
	}
	return parsed as Array<PremiumBadgeFlagVector>;
}

function userFromRow(row: PremiumBadgeFlagVector['row']): User {
	return new User({...EMPTY_USER_ROW, ...row, flags: BigInt(row.flags), user_id: 42n as UserID});
}

const vectors = readVectors();

describe('premium badge public flag', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function setUserFlags(userId: string, flags: bigint): Promise<void> {
		await createBuilder(harness, '')
			.patch(`/test/users/${userId}/flags`)
			.body({flags: flags.toString()})
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	async function shareGuild(owner: TestAccount, member: TestAccount): Promise<void> {
		const guild = await createGuild(harness, owner.token, 'Premium Badge Guild');
		const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, member.token, invite.code);
	}

	function spyOnPropagationJobs() {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		return () => (addJob.mock.calls as Array<Array<unknown>>).filter(([task]) => task === 'propagatePartialUserChange');
	}

	it.each(vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
		const user = userFromRow(vector.row);
		expect(mapUserToPartialResponse(user).flags).toBe(vector.public_flags);
		expect(mapUserToPrivateResponse(user).flags).toBe(vector.public_flags);
	});

	// The partial user does not depend on the viewer: any signed-in account sees the bit, shared guild or not.
	it('shows PREMIUM_BADGE to the account itself, a shared-guild member and an account with no shared guild', async () => {
		const premium = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const stranger = await createTestAccount(harness);
		await shareGuild(premium, viewer);
		await grantPremium(harness, premium.userId, UserPremiumTypes.SUBSCRIPTION);

		const {json: me} = await fetchUserMe(harness, premium.token);
		expect(me.flags & PublicUserFlags.PREMIUM_BADGE).toBe(PublicUserFlags.PREMIUM_BADGE);
		const {json: partial} = await fetchUser(harness, premium.userId, viewer.token);
		expect(partial.flags & PublicUserFlags.PREMIUM_BADGE).toBe(PublicUserFlags.PREMIUM_BADGE);
		const {json: strangerView} = await fetchUser(harness, premium.userId, stranger.token);
		expect(strangerView.flags & PublicUserFlags.PREMIUM_BADGE).toBe(PublicUserFlags.PREMIUM_BADGE);
	});

	it('hiding the premium badge removes the bit and queues one partial user propagation', async () => {
		const premium = await createTestAccount(harness);
		await grantPremium(harness, premium.userId, UserPremiumTypes.LIFETIME);
		const propagationJobs = spyOnPropagationJobs();

		const {json: updated} = await createBuilder<UserPrivateResponse>(harness, premium.token)
			.patch('/users/@me')
			.body({premium_badge_hidden: true})
			.expect(HTTP_STATUS.OK)
			.executeWithResponse();

		expect(updated.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
		expect(propagationJobs()).toHaveLength(1);
	});

	it('keeps the badge for a FRIENDS_ONLY premium account', async () => {
		const premium = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await shareGuild(premium, viewer);
		await grantPremium(harness, premium.userId, UserPremiumTypes.SUBSCRIPTION);
		await updateUserSettings(harness, premium.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});

		const {json: partial} = await fetchUser(harness, premium.userId, viewer.token);
		expect(partial.flags & PublicUserFlags.PREMIUM_BADGE).toBe(PublicUserFlags.PREMIUM_BADGE);
	});

	it('never lets a stored bit 30 reach a response', async () => {
		const account = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setUserFlags(account.userId, 1n << 30n);

		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
		const {json: partial} = await fetchUser(harness, account.userId, viewer.token);
		expect(partial.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
	});

	it('ignores bit 30 in PATCH /users/@me flags', async () => {
		const account = await createTestAccount(harness);
		const {json: updated} = await createBuilder<UserPrivateResponse>(harness, account.token)
			.patch('/users/@me')
			.body({bio: 'self badge attempt', flags: PublicUserFlags.PREMIUM_BADGE})
			.expect(HTTP_STATUS.OK)
			.executeWithResponse();
		expect(updated.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
	});

	it('counts the premium badge appearing or disappearing as a partial user change', () => {
		const base = {flags: 0, bot: false, premium_flags: 0};
		const none = userFromRow({...base, premium_type: null});
		const premium = userFromRow({...base, premium_type: UserPremiumTypes.SUBSCRIPTION});
		const lifetime = userFromRow({...base, premium_type: UserPremiumTypes.LIFETIME});
		expect(hasPartialUserFieldsChanged(none, premium)).toBe(true);
		expect(hasPartialUserFieldsChanged(premium, none)).toBe(true);
		expect(hasPartialUserFieldsChanged(premium, lifetime)).toBe(false);
	});
});
