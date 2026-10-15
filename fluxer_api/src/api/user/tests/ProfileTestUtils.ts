// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	createChannelInvite,
	createFriendship,
	createGroupDmChannel,
	createGuild,
	getChannel,
} from '@app/api/channel/tests/ChannelTestUtils';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';

// the setups the profile visibility tests share.

export async function sharedGuild(harness: ApiTestHarness, owner: TestAccount, viewer: TestAccount): Promise<void> {
	const guild = await createGuild(harness, owner.token, 'Shared');
	const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
	const invite = await createChannelInvite(harness, owner.token, channel.id);
	await acceptInvite(harness, viewer.token, invite.code);
}

// A third account friends with both opens the group DM, so the two share it without being friends themselves.
export async function sharedGroupDm(harness: ApiTestHarness, owner: TestAccount, viewer: TestAccount): Promise<void> {
	const host = await createTestAccount(harness);
	await createFriendship(harness, host, owner);
	await createFriendship(harness, host, viewer);
	await createGroupDmChannel(harness, host.token, [owner.userId, viewer.userId]);
}

/** The level an older client or an earlier date of birth left in the row; no route check, no cache forget. */
export async function storeLevel(owner: TestAccount, level: number): Promise<void> {
	await getUserRepository().patchSettings(createUserID(BigInt(owner.userId)), {profile_privacy: level});
}

export function getProfile(harness: ApiTestHarness, token: string, owner: TestAccount) {
	return createBuilder<UserProfileFullResponse>(harness, token).get(
		`/users/${owner.userId}/profile?with_mutual_friends=true&with_mutual_guilds=true`,
	);
}
