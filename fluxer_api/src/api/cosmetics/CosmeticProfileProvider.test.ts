// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {registerCosmeticProfileExtension} from '@app/api/cosmetics/CosmeticProfileProvider';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {applyProfileExtensions} from '@app/api/user/profile/ProfileExtensionProviders';
import {DeletionReasons} from '@fluxer/constants/src/Core';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it} from 'vitest';

registerCosmeticProfileExtension();

async function extend(overrides: Partial<UserRow>) {
	const user = new User({
		...EMPTY_USER_ROW,
		user_id: createUserID(1174109840998400001n),
		username: 'owner',
		profile_effect_id: 123n,
		profile_effect_asset: 'effect',
		...overrides,
	});
	const profile: UserProfileFullResponse = {
		user: {
			id: user.id.toString(),
			username: 'owner',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
		timezone_offset: null,
	};
	return applyProfileExtensions(profile, {user, userId: user.id, viewerId: createUserID(2n), restrictProfile: false});
}

describe('cosmetic profile visibility', () => {
	it.each([
		{flags: UserFlags.PROFILE_HIDDEN},
		{flags: UserFlags.SPAMMER},
		{flags: UserFlags.DISABLED, temp_banned_until: new Date(Date.now() + 86_400_000)},
		{pending_deletion_at: new Date(Date.now() + 86_400_000), deletion_reason_code: DeletionReasons.SPAM},
	])('clears a hidden profile effect so an earlier cached effect cannot remain: %o', async (standing) => {
		expect((await extend(standing)).profile_effect_data).toBeNull();
	});

	it('keeps the effect on an ordinary profile', async () => {
		expect((await extend({})).profile_effect_data).toEqual({item_id: '123', asset: 'effect'});
	});
});
