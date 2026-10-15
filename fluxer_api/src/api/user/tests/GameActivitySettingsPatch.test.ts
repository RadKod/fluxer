// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {UserSettingsRow} from '@app/api/database/types/UserTypes';
import {UserSettings} from '@app/api/models/UserSettings';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import type {GameActivityPolicyFence} from '@app/api/user/services/GameActivityPolicyService';
import {UserAccountSettingsService} from '@app/api/user/services/UserAccountSettingsService';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {describe, expect, it, vi} from 'vitest';

let nextUserId = 4100n;

async function fixture(
	initial: Partial<Pick<UserSettingsRow, 'game_activity_visibility' | 'game_activity_visibility_source'>> = {},
	dateOfBirth = '2000-01-01',
) {
	const userId = createUserID(nextUserId++);
	const repository = new UserSettingsRepository();
	await repository.upsertSettings({
		...UserSettings.getDefaultUserSettings({userId, locale: 'en-US', isAdult: true}),
		game_activity_policy_revision: null,
		...initial,
	});
	const order: Array<string> = [];
	const patch = repository.patchSettings.bind(repository);
	vi.spyOn(repository, 'patchSettings').mockImplementation(async (...args) => {
		order.push('patch');
		return patch(...args);
	});
	const policy = {
		fenceUserPolicy: vi.fn(async () => {
			order.push('fence');
			return {
				request_id: 'fence',
				owner_epoch: '1',
				policy_revision: (await repository.findSettings(userId, {
					authoritative: true,
				}))!.gameActivityPolicyRevision.toString(),
			};
		}),
		applyUserPolicy: vi.fn(async (_userId: UserID, _fence: GameActivityPolicyFence, _settings: UserSettings | null) => {
			order.push('apply');
		}),
	};
	const account = {id: userId, isBot: false, isSystem: false, dateOfBirth};
	const service = new UserAccountSettingsService({
		// The account is a stub; settings reads and writes reach the real settings table.
		userAccountRepository: Object.assign(Object.create(repository), {findUnique: vi.fn(async () => account)}) as never,
		updatePropagator: {dispatchUserSettingsUpdate: vi.fn(async () => {})} as never,
		gatewayService: {} as never,
		userCacheService: {} as never,
		guildRepository: {} as never,
		limitConfigService: {} as never,
		gameActivityPolicyService: policy,
	});
	const read = async () => (await repository.findSettings(userId, {authoritative: true}))!;
	return {userId, service, policy, order, read};
}

async function minimumAgeError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(InputValidationError);
	return (error as InputValidationError).getLocalizedErrors();
}

describe('game activity settings patch', () => {
	it('everyone_is_accepted_from_fifteen_and_marks_a_user_choice', async () => {
		vi.useFakeTimers({now: new Date('2026-10-06T12:00:00Z'), toFake: ['Date']});
		try {
			const f = await fixture({game_activity_visibility_source: null}, '2011-10-06');
			const updated = await f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: 'everyone'}});
			expect(updated.gameActivityVisibility).toBe('everyone');
			expect(updated.gameActivityVisibilitySource).toBe('user');
			expect(updated.gameActivityPolicyRevision).toBe(1n);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['everyone', 'friends'] as const)('under_fifteen_%s_is_refused_with_minimum_age_fifteen', async (value) => {
		vi.useFakeTimers({now: new Date('2026-10-06T12:00:00Z'), toFake: ['Date']});
		try {
			const f = await fixture({}, '2011-10-07');
			expect(
				await minimumAgeError(f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: value}})),
			).toEqual([
				{
					path: 'game_activity_visibility',
					code: ValidationErrorCodes.MUST_BE_MINIMUM_AGE,
					variables: {minAge: 15},
				},
			]);
			expect(f.policy.fenceUserPolicy).not.toHaveBeenCalled();
			expect((await f.read()).gameActivityVisibilitySource).toBe('default');
		} finally {
			vi.useRealTimers();
		}
	});

	it('null_turns_sharing_off_as_a_user_choice', async () => {
		const f = await fixture({game_activity_visibility: 'friends', game_activity_visibility_source: null});
		const updated = await f.service.updateSettings({userId: f.userId, data: {game_activity_visibility: null}});
		expect(updated.gameActivityVisibility).toBe('off');
		expect(updated.gameActivityVisibilitySource).toBe('user');
	});

	it.each(['off', 'friends', null] as const)(
		'acknowledgement_resets_pending_stored_%s_to_the_null_default',
		async (stored) => {
			const f = await fixture({game_activity_visibility: stored, game_activity_visibility_source: null});
			const updated = await f.service.updateSettings({
				userId: f.userId,
				data: {game_activity_default_acknowledged: true},
			});
			expect(updated.gameActivityVisibilitySource).toBe('default');
			expect(updated.gameActivityVisibility).toBeNull();
			expect((await f.read()).toRow().game_activity_visibility).toBeNull();
			expect(updated.gameActivityPolicyRevision).toBe(1n);
			expect(f.order).toEqual(['fence', 'patch', 'apply']);
		},
	);

	it.each(['default', 'user'] as const)('acknowledgement_is_a_no_op_for_source_%s', async (source) => {
		const f = await fixture({game_activity_visibility: 'off', game_activity_visibility_source: source});
		const updated = await f.service.updateSettings({
			userId: f.userId,
			data: {game_activity_default_acknowledged: true},
		});
		expect(updated.gameActivityVisibilitySource).toBe(source);
		expect(updated.toRow().game_activity_visibility).toBe('off');
		expect(updated.gameActivityPolicyRevision).toBe(0n);
		expect(f.policy.fenceUserPolicy).not.toHaveBeenCalled();
		expect(f.policy.applyUserPolicy).not.toHaveBeenCalled();
	});

	it('every_effective_change_is_fenced_patched_applied_and_advances_the_revision', async () => {
		const f = await fixture({game_activity_visibility_source: null});
		const steps: Array<Parameters<UserAccountSettingsService['updateSettings']>[0]['data']> = [
			{game_activity_default_acknowledged: true},
			{game_activity_visibility: 'friends'},
			{game_activity_visibility: 'everyone'},
			{game_activity_visibility: 'off'},
		];
		for (const [index, data] of steps.entries()) {
			f.order.length = 0;
			const updated = await f.service.updateSettings({userId: f.userId, data});
			expect(f.order).toEqual(['fence', 'patch', 'apply']);
			expect(updated.gameActivityPolicyRevision).toBe(BigInt(index + 1));
			expect(f.policy.applyUserPolicy).toHaveBeenLastCalledWith(f.userId, expect.anything(), updated);
		}
		expect((await f.read()).gameActivityVisibilitySource).toBe('user');
	});

	it('a_full_row_write_cannot_change_the_source', async () => {
		const f = await fixture({game_activity_visibility_source: null});
		const repository = new UserSettingsRepository();
		const current = await f.read();
		await repository.upsertSettings({...current.toRow(), game_activity_visibility_source: 'default', theme: 'light'});
		const after = await f.read();
		expect(after.gameActivityVisibilitySource).toBeNull();
		expect(after.theme).toBe('light');
	});

	it('a_full_row_profile_write_requires_a_fence_while_the_default_shares', async () => {
		const f = await fixture({game_activity_visibility: null, game_activity_visibility_source: 'default'});
		const repository = new UserSettingsRepository();
		const current = await f.read();
		await expect(repository.upsertSettings({...current.toRow(), profile_privacy: 101})).rejects.toThrow();
		expect((await f.read()).profilePrivacy).toBe(current.profilePrivacy);
	});

	it.each([null, 'user'] as const)('a_full_row_profile_write_preserves_null_off_for_source_%s', async (source) => {
		const f = await fixture({game_activity_visibility: null, game_activity_visibility_source: source});
		const repository = new UserSettingsRepository();
		const current = await f.read();
		await repository.upsertSettings({...current.toRow(), profile_privacy: 101});
		expect((await f.read()).profilePrivacy).toBe(101);
	});
});
