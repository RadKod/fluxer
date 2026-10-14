// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createUserID} from '@app/api/BrandedTypes';
import {referralPendingMonth} from '@app/api/database/types/ReferralTypes';
import {getReferralRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {expect} from 'vitest';

const OFFSITE_REWARD = {type: 'offsite', description: 'Coverage gift card'};

async function createTier(harness: ApiTestHarness, token: string): Promise<string> {
	const response = await harness.requestJson({
		path: '/admin/referral/tiers',
		method: 'POST',
		body: {threshold: 5, reward: OFFSITE_REWARD},
		headers: {Authorization: token},
	});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	return ((await response.json()) as {id: string}).id;
}

// The off-site reward the grant job would leave: pending_admin plus its row in the month's pending list.
async function seedPendingReward(userId: string, tierId: string): Promise<void> {
	const repository = getReferralRepository();
	const grantedAt = new Date();
	const user = createUserID(BigInt(userId));
	await repository.claimReward({
		user_id: user,
		tier_id: BigInt(tierId),
		reward: JSON.stringify(OFFSITE_REWARD),
		status: 'pending_admin',
		granted_at: grantedAt,
		delivered_at: null,
		delivered_by: null,
		note: null,
		code: null,
	});
	await repository.insertPendingReward({
		month: referralPendingMonth(grantedAt),
		created_at: grantedAt,
		user_id: user,
		tier_id: BigInt(tierId),
	});
}

export const ReferralAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/referral',
		async prepare() {
			return {
				request: {path: '/admin/referral'},
				expected: {action: 'view_referral', targetType: 'referral', targetId: '0', metadata: {result_count: '0'}},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/referral/settings',
		async prepare() {
			return {
				request: {path: '/admin/referral/settings', body: {daily_valid_cap: 20}},
				expected: {
					action: 'update_referral_settings',
					targetType: 'referral',
					targetId: '0',
					metadata: {daily_valid_cap_old: '50', daily_valid_cap_new: '20'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/referral/tiers',
		async prepare() {
			return {
				request: {path: '/admin/referral/tiers', body: {threshold: 5, reward: OFFSITE_REWARD}},
				expected: {
					action: 'create_referral_tier',
					targetType: 'referral_tier',
					targetId: expect.any(String),
					metadata: {threshold: '5', reward_type: 'offsite', enabled: 'true'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/referral/tiers/:tier_id',
		async prepare({harness, admin}) {
			const tierId = await createTier(harness, admin.token);
			return {
				request: {path: `/admin/referral/tiers/${tierId}`, body: {threshold: 3}},
				expected: {
					action: 'update_referral_tier',
					targetType: 'referral_tier',
					targetId: tierId,
					metadata: {threshold_old: '5', threshold_new: '3'},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/referral/pending-rewards',
		async prepare() {
			return {
				request: {path: '/admin/referral/pending-rewards?month=2026-10'},
				expected: {
					action: 'view_referral_pending_rewards',
					targetType: 'referral',
					targetId: '0',
					metadata: {month: '2026-10', result_count: '0'},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/users/:user_id/referrals',
		async prepare({admin}) {
			return {
				request: {path: `/admin/users/${admin.userId}/referrals`},
				expected: {
					action: 'view_user_referrals',
					targetType: 'user',
					targetId: admin.userId,
					metadata: {result_count: '0'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/users/:user_id/referral-rewards/:tier_id/deliver',
		async prepare({harness, admin}) {
			const tierId = await createTier(harness, admin.token);
			await seedPendingReward(admin.userId, tierId);
			return {
				request: {
					path: `/admin/users/${admin.userId}/referral-rewards/${tierId}/deliver`,
					body: {code: 'COVERAGE-CODE-1', note: 'sent'},
				},
				expected: {
					action: 'deliver_referral_reward',
					targetType: 'user',
					targetId: admin.userId,
					metadata: {tier_id: tierId, has_code: 'true', note: 'sent'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/users/:user_id/referral-rewards/:tier_id/notify',
		async prepare({harness, admin}) {
			const tierId = await createTier(harness, admin.token);
			await seedPendingReward(admin.userId, tierId);
			const content = 'Referans ödülün için destek ekibimize yaz.';
			return {
				request: {
					path: `/admin/users/${admin.userId}/referral-rewards/${tierId}/notify`,
					body: {content},
					expectStatus: 204,
				},
				expected: {
					action: 'notify_referral_reward',
					targetType: 'user',
					targetId: admin.userId,
					metadata: {tier_id: tierId, content_length: String(content.length)},
				},
			};
		},
	},
];
