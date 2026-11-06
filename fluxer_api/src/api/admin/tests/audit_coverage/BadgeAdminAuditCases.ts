// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestCustomBadge} from '@app/api/admin/tests/AdminTestUtils';
import type {
	AdminAuditCoverageCase,
	AdminAuditCoverageContext,
} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import {expect} from 'vitest';

// sanalyer: the Micup badge catalog (icon + description, granted one by one, pioneer numbering) lives next to
// upstream's custom badges, under /admin/badge-catalog.
async function createBadge({harness, admin}: AdminAuditCoverageContext): Promise<BadgeResponse> {
	const response = await harness.requestJson({
		path: '/admin/badge-catalog',
		method: 'POST',
		body: {icon: getPngDataUrl(), description: 'Early supporter'},
		headers: {Authorization: admin.token},
	});
	if (response.status !== 200) {
		throw new Error(`Creating the coverage badge failed with ${response.status}: ${await response.text()}`);
	}
	return (await response.json()) as BadgeResponse;
}

async function grantBadge(context: AdminAuditCoverageContext, userId: string, badgeId: string): Promise<void> {
	const response = await context.harness.requestJson({
		path: `/admin/users/${userId}/badges/${badgeId}`,
		method: 'POST',
		headers: {Authorization: context.admin.token},
	});
	if (response.status !== 204) {
		throw new Error(`Granting the coverage badge failed with ${response.status}: ${await response.text()}`);
	}
}

export const BadgeAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/badges',
		async prepare({harness, admin}) {
			await createTestCustomBadge(harness, admin.token);
			return {
				request: {path: '/admin/badges'},
				expected: {
					action: 'list_badges',
					targetType: 'badge',
					targetId: '0',
					metadata: {result_count: '1'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/badges',
		async prepare() {
			return {
				request: {path: '/admin/badges', body: {type: 'guild', name: 'Audit badge', image: getPngDataUrl()}},
				expected: {
					action: 'create_badge',
					targetType: 'badge',
					targetId: expect.any(String),
					metadata: {type: 'guild'},
				},
			};
		},
	},
	{
		method: 'PUT',
		route: '/admin/badges/order',
		async prepare({harness, admin}) {
			const first = await createTestCustomBadge(harness, admin.token, 'user');
			const second = await createTestCustomBadge(harness, admin.token, 'guild');
			return {
				request: {path: '/admin/badges/order', body: {badge_ids: [second.id, first.id]}},
				expected: {
					action: 'reorder_badges',
					targetType: 'badge',
					targetId: '0',
					metadata: {badge_ids: `${second.id},${first.id}`},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/badges/settings',
		async prepare() {
			return {
				request: {path: '/admin/badges/settings', body: {max_per_user: 20}},
				expected: {
					action: 'update_badge_settings',
					targetType: 'badge',
					targetId: '0',
					metadata: {max_per_user: '20', max_per_guild: '50'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/badges/order',
		async prepare({harness, admin}) {
			await createTestCustomBadge(harness, admin.token, 'user');
			const badge = await createTestCustomBadge(harness, admin.token, 'user');
			return {
				request: {path: '/admin/badges/order', body: {badge_id: badge.id, direction: 'up'}},
				expected: {
					action: 'move_badge',
					targetType: 'badge',
					targetId: badge.id,
					metadata: {direction: 'up'},
				},
			};
		},
	},
	{
		method: 'PUT',
		route: '/admin/badges/built-in/:kind',
		async prepare() {
			return {
				request: {path: '/admin/badges/built-in/staff', body: {image: getPngDataUrl()}},
				expected: {
					action: 'replace_built_in_badge_image',
					targetType: 'badge',
					targetId: '0',
					metadata: {kind: 'staff'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/badges/built-in/:kind',
		async prepare() {
			return {
				request: {path: '/admin/badges/built-in/guild_verified'},
				expected: {
					action: 'reset_built_in_badge_image',
					targetType: 'badge',
					targetId: '0',
					metadata: {kind: 'guild_verified'},
				},
			};
		},
	},
	{
		method: 'PUT',
		route: '/admin/badges/built-in/:kind/hidden',
		async prepare() {
			return {
				request: {path: '/admin/badges/built-in/guild_discoverable/hidden'},
				expected: {
					action: 'hide_built_in_badge',
					targetType: 'badge',
					targetId: '0',
					metadata: {kind: 'guild_discoverable'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/badges/built-in/:kind/hidden',
		async prepare() {
			return {
				request: {path: '/admin/badges/built-in/guild_discoverable/hidden'},
				expected: {
					action: 'show_built_in_badge',
					targetType: 'badge',
					targetId: '0',
					metadata: {kind: 'guild_discoverable'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/badges/:badge_id',
		async prepare({harness, admin}) {
			const badge = await createTestCustomBadge(harness, admin.token);
			return {
				request: {
					path: `/admin/badges/${badge.id}`,
					body: {name: 'Renamed badge', description: null, href: null},
				},
				expected: {
					action: 'update_badge',
					targetType: 'badge',
					targetId: badge.id,
					metadata: {image_replaced: 'false'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/badges/:badge_id',
		async prepare({harness, admin}) {
			const badge = await createTestCustomBadge(harness, admin.token);
			return {
				request: {path: `/admin/badges/${badge.id}`, expectStatus: 204},
				expected: {
					action: 'delete_badge',
					targetType: 'badge',
					targetId: badge.id,
					metadata: {},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/users/:user_id/badges',
		async prepare({harness, admin}) {
			const badge = await createTestCustomBadge(harness, admin.token);
			const target = await createTestAccount(harness);
			return {
				request: {path: `/admin/users/${target.userId}/badges`, body: {badge_ids: [badge.id]}},
				expected: {
					action: 'update_user_badges',
					targetType: 'user',
					targetId: target.userId,
					metadata: {badge_ids: badge.id},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/badge-catalog',
		async prepare(context) {
			await createBadge(context);
			return {
				request: {path: '/admin/badge-catalog'},
				expected: {action: 'list_badges', targetType: 'badge', targetId: '0', metadata: {result_count: '1'}},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/badge-catalog',
		async prepare() {
			return {
				request: {path: '/admin/badge-catalog', body: {icon: getPngDataUrl(), description: 'Early supporter'}},
				expected: {
					action: 'create_badge',
					targetType: 'badge',
					targetId: expect.any(String),
					metadata: {icon: expect.any(String), description: 'Early supporter'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/badge-catalog/:badge_id',
		async prepare(context) {
			const badge = await createBadge(context);
			return {
				request: {path: `/admin/badge-catalog/${badge.id}`, body: {description: 'Founding member'}},
				expected: {
					action: 'update_badge',
					targetType: 'badge',
					targetId: badge.id,
					metadata: {icon: badge.icon, description: 'Founding member'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/users/:user_id/badges/:badge_id',
		async prepare(context) {
			const badge = await createBadge(context);
			const target = await createTestAccount(context.harness);
			return {
				request: {path: `/admin/users/${target.userId}/badges/${badge.id}`, expectStatus: 204},
				expected: {
					action: 'grant_user_badge',
					targetType: 'user',
					targetId: target.userId,
					metadata: {badge_id: badge.id},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/users/:user_id/badges/:badge_id',
		async prepare(context) {
			const badge = await createBadge(context);
			const target = await createTestAccount(context.harness);
			await grantBadge(context, target.userId, badge.id);
			return {
				request: {path: `/admin/users/${target.userId}/badges/${badge.id}`, expectStatus: 204},
				expected: {
					action: 'revoke_user_badge',
					targetType: 'user',
					targetId: target.userId,
					metadata: {badge_id: badge.id},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/badges/pioneer/backfill',
		async prepare(context) {
			const response = await context.harness.requestJson({
				path: '/admin/badge-catalog',
				method: 'POST',
				body: {icon: getPngDataUrl(), description: 'Öncü #{n}'},
				headers: {Authorization: context.admin.token},
			});
			const badge = (await response.json()) as BadgeResponse;
			const first = await createTestAccount(context.harness);
			return {
				request: {
					path: '/admin/badges/pioneer/backfill',
					body: {badge_id: badge.id, first_user_id: first.userId, excluded_user_ids: [], dry_run: true},
					expectStatus: 204,
				},
				expected: {
					action: 'start_pioneer_backfill',
					targetType: 'badge',
					targetId: badge.id,
					metadata: {first_user_id: first.userId, excluded_count: '0', dry_run: 'true'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/badges/pioneer/stop',
		async prepare() {
			return {
				request: {path: '/admin/badges/pioneer/stop', expectStatus: 204},
				expected: {action: 'stop_pioneer', targetType: 'badge', targetId: '0', metadata: {}},
			};
		},
	},
];
