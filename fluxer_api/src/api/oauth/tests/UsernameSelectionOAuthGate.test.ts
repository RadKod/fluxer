// SPDX-License-Identifier: AGPL-3.0-or-later

import {createApplicationID, createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {User} from '@app/api/models/User';
import {ApplicationService} from '@app/api/oauth/ApplicationService';
import {OAuth2RequestService} from '@app/api/oauth/OAuth2RequestService';
import type {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

describe('OAuth bot selection gates', () => {
	const originalSelfHosted = getConfig().instance.selfHosted;
	beforeAll(() => {
		getConfig().instance.selfHosted = true;
	});
	afterAll(() => {
		getConfig().instance.selfHosted = originalSelfHosted;
	});
	afterEach(() => {
		setCachedAccountIdentity(null);
		setInjectedUsernameOwnershipService(undefined);
		vi.restoreAllMocks();
	});
	it.each([{guild_id: 234n}, {channel_id: 345n}])(
		'gates the initiating human before consent or bot addition (%s)',
		async (target) => {
			vi.spyOn(InstanceConfigRepository.prototype, 'readUsernameMigrationConfig').mockResolvedValue({
				state: 'selecting',
				epoch: 1,
				started_at: null,
				forced_at: new Date(0).toISOString(),
			});
			setCachedAccountIdentity({
				mode: AccountIdentityModes.EMAIL,
				tagStyle: TagStyles.NONE,
				usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: new Date(0).toISOString()},
			});
			const user = new User({...EMPTY_USER_ROW, user_id: createUserID(123n), username: 'legacy', discriminator: 1234});
			const authorize = vi.fn().mockRejectedValue(new Error('unexpected consent write'));
			const service = new OAuth2RequestService(
				{services: {users: {findUniqueAssert: vi.fn().mockResolvedValue(user)}}} as never,
				{authorizeAndConsent: authorize} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
			);
			await expect(
				service.authorizeConsent({
					body: {client_id: 456n, scope: 'bot', ...target},
					userId: user.id,
					clientFeatures: new Set(),
					viewer: {userId: user.id} as never,
					requestCache: createRequestCache(),
				}),
			).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED'});
			expect(authorize).not.toHaveBeenCalled();
		},
	);
	it.each(['held', 'banned', 'assigned', 'pending'])(
		'checks bot policy and rejects a %s human claim without ownership writes',
		async (state) => {
			setCachedAccountIdentity({
				mode: AccountIdentityModes.EMAIL,
				tagStyle: TagStyles.NONE,
				usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null},
			});
			const owner = new User({
				...EMPTY_USER_ROW,
				user_id: createUserID(123n),
				username: 'legacy',
				discriminator: 1234,
				email: 'owner@example.com',
				password_hash: 'hash',
			});
			const check = vi.spyOn(UsernamePolicyService.prototype, 'check').mockReturnValue(null);
			vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue({
				migration: {state: 'selecting'},
				dictionary: {gen: 1},
			} as never);
			vi.spyOn(UsernamePolicyService.prototype, 'readAuthoritative').mockResolvedValue({} as never);
			const readClaimForAvailability = vi.fn().mockResolvedValue({state});
			const readEntitlement = vi.fn().mockResolvedValue(null);
			setInjectedUsernameOwnershipService({
				readClaimForAvailability,
				repository: {readEntitlement},
			} as unknown as UsernameOwnershipService);
			const create = vi.fn().mockRejectedValue(new Error('unexpected bot write'));
			const service = new ApplicationService(
				{
					services: {
						users: {findUniqueAssert: vi.fn().mockResolvedValue(owner), create},
						snowflake: {generate: vi.fn().mockResolvedValue(456n)},
					},
				} as never,
				{
					discriminatorService: {
						generateDiscriminator: vi.fn().mockResolvedValue({available: true, discriminator: 1234}),
					},
				} as never,
			);
			await expect(service.createApplication({ownerUserId: owner.id, name: 'Chosenname'})).rejects.toMatchObject({
				code:
					state === 'held'
						? 'USERNAME_RESERVED'
						: state === 'banned'
							? 'USERNAME_BLOCKED'
							: state === 'pending'
								? 'USERNAME_BUSY'
								: 'USERNAME_TAKEN',
			});
			expect(check).toHaveBeenCalledWith(
				'chosenname',
				{kind: 'bot', userId: createUserID(456n)},
				false,
				expect.anything(),
				null,
			);
			expect(create).not.toHaveBeenCalled();
		},
	);
	it('rejects a zero discriminator result on bot rename before persisting identity', async () => {
		const ownerId = createUserID(123n);
		const bot = new User({
			...EMPTY_USER_ROW,
			user_id: createUserID(456n),
			username: 'oldname',
			discriminator: 1234,
			bot: true,
		});
		vi.spyOn(UsernamePolicyService.prototype, 'check').mockReturnValue(null);
		vi.spyOn(UsernamePolicyService.prototype, 'readAuthoritative').mockResolvedValue({} as never);
		setInjectedUsernameOwnershipService({
			readClaimForAvailability: vi.fn().mockResolvedValue(null),
			repository: {readEntitlement: vi.fn().mockResolvedValue(null)},
		} as unknown as UsernameOwnershipService);
		const patchUpsert = vi.fn().mockRejectedValue(new Error('unexpected bot identity write'));
		const service = new ApplicationService(
			{
				services: {
					users: {findUnique: vi.fn().mockResolvedValue(bot), patchUpsert},
					rateLimit: {checkLimit: vi.fn().mockResolvedValue({allowed: true})},
				},
			} as never,
			{
				applicationRepository: {
					getApplication: vi.fn().mockResolvedValue({ownerUserId: ownerId, getBotUserId: () => bot.id}),
				},
				discriminatorService: {
					resolveUsernameChange: vi.fn().mockResolvedValue({username: 'newname', discriminator: 0}),
				},
			} as never,
		);
		await expect(
			service.updateBotProfile(ownerId, createApplicationID(456n), {username: 'newname'}),
		).rejects.toMatchObject({code: 'BOT_USER_GENERATION_FAILED'});
		expect(patchUpsert).not.toHaveBeenCalled();
	});
});
