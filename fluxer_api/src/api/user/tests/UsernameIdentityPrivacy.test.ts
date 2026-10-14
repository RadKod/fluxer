// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {GuildMemberRow} from '@app/api/database/types/GuildTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {mapGuildMemberToResponse} from '@app/api/guild/GuildModel';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {LimitConfigService, resetGlobalLimitConfigServiceForTesting} from '@app/api/limits/LimitConfigService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {GuildMember} from '@app/api/models/GuildMember';
import {User} from '@app/api/models/User';
import {
	hasPartialUserFieldsChanged,
	mapUserToOAuthResponse,
	mapUserToPartialResponse,
	mapUserToPrivateResponse,
	mapUserToProfileResponse,
} from '@app/api/user/UserMappers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {OAuth2UserInfoResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {FriendRequestByTagRequest, UserTagCheckQueryRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {InMemoryProvider} from '@pkgs/cache/src/providers/InMemoryProvider';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

function makeUser(flags = 0n, identityVersion = 12n) {
	return new User({
		...EMPTY_USER_ROW,
		user_id: createUserID(123n),
		username: 'chosen',
		discriminator: 0,
		username_state: 'selected',
		identity_version: identityVersion,
		flags,
	});
}

describe('username identity privacy', () => {
	beforeAll(() => {
		new LimitConfigService(new InstanceConfigRepository(), new InMemoryProvider()).setAsGlobalInstance();
	});
	afterAll(() => {
		resetGlobalLimitConfigServiceForTesting();
	});
	it('loads private state and public generation from the same users projection', () => {
		const user = makeUser();
		expect(user.usernameState).toBe('selected');
		expect(user.identityVersion).toBe(12n);
		expect(user.toRow().username_state).toBe('selected');
		expect(user.toRow().identity_version).toBe(12n);
		expect(mapUserToPrivateResponse(user)).toMatchObject({username_state: 'selected', identity_version: '12'});
	});
	it.each([0n, UserFlags.PROFILE_HIDDEN])(
		'keeps private state out of public and OAuth responses (flags %s)',
		(flags) => {
			const user = makeUser(flags);
			const partial = mapUserToPartialResponse(user);
			expect(partial.identity_version).toBe('12');
			for (const response of [partial, mapUserToProfileResponse(user), mapUserToOAuthResponse(user)]) {
				for (const field of ['username_state', 'changeAvailableAt', 'freeChangeAvailable', 'reselect_reason'])
					expect(response).not.toHaveProperty(field);
			}
		},
	);
	it('detects owner generation changes even when projected identity is unchanged', () => {
		expect(hasPartialUserFieldsChanged(makeUser(0n, 11n), makeUser(0n, 12n))).toBe(true);
	});
	it('preserves the public generation in the OAuth identify response schema', () => {
		const response = OAuth2UserInfoResponse.parse(mapUserToOAuthResponse(makeUser()));
		expect(response).toHaveProperty('identity_version', '12');
		for (const field of ['username_state', 'changeAvailableAt', 'freeChangeAvailable', 'reselect_reason'])
			expect(response).not.toHaveProperty(field);
		expect(OAuth2UserInfoResponse.safeParse({...response, identity_version: '-1'}).success).toBe(false);
	});
	it('keeps private selection fields out of visible and hidden guild members', async () => {
		for (const flags of [0n, UserFlags.PROFILE_HIDDEN]) {
			const user = makeUser(flags);
			const member = new GuildMember({
				guild_id: createGuildID(456n),
				user_id: user.id,
				joined_at: new Date(),
				version: 1,
			} as GuildMemberRow);
			const response = await mapGuildMemberToResponse(
				member,
				{getUserPartialResponse: async () => mapUserToPartialResponse(user)},
				createRequestCache(),
			);
			expect(response.user.identity_version).toBe('12');
			expect(response.user).not.toHaveProperty('username_state');
			expect(response.user).not.toHaveProperty('changeAvailableAt');
		}
	});
	it('accepts bare names and @ names while keeping legacy tag requests', () => {
		expect(UserTagCheckQueryRequest.safeParse({username: 'chosen'}).success).toBe(true);
		expect(FriendRequestByTagRequest.parse({username: '@chosen'})).toEqual({username: 'chosen'});
		expect(FriendRequestByTagRequest.parse({username: 'chosen', discriminator: 1234}).discriminator).toBe(1234);
	});
	it('localizes the selection error with the old-client recovery instruction', () => {
		expect(getErrorMessageUnsafe('USERNAME_SELECTION_REQUIRED', 'tr')).toBe(
			'Kullanıcı adınızı seçmek için uygulamayı güncelleyin ya da web/masaüstünden seçin.',
		);
		expect(getErrorMessageUnsafe('USERNAME_SELECTION_REQUIRED', 'en-US')).toContain('update the app');
	});
});
