// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {
	createUniqueEmail,
	createUniqueUsername,
	registerUser,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {setInjectedUsernameMigrationPreconditions} from '@app/api/middleware/ServiceRegistry';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS, TEST_IDS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {compileUsernameDictionary, UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import type {CreateRegistrationUrlResponse} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {afterEach, vi} from 'vitest';

afterEach(() => vi.restoreAllMocks());

async function createRegistrationUrl(harness: ApiTestHarness, admin: TestAccount): Promise<string> {
	const created = await createBuilder<CreateRegistrationUrlResponse>(harness, admin.token)
		.post('/admin/instance/registration-urls')
		.body({approval_required: false})
		.expect(HTTP_STATUS.OK)
		.execute();
	return created.registration_url.id;
}

export const InstanceConfigAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/instance/username-migration',
		async prepare() {
			return {
				request: {path: '/admin/instance/username-migration'},
				expected: {
					action: 'get_username_migration',
					targetType: 'username_migration',
					targetId: '0',
					metadata: {epoch: '0', state: 'legacy'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/username-migration/prepare',
		async prepare() {
			const preparingAt = '2026-10-09T00:00:00.000Z';
			vi.spyOn(getInstanceConfigRepository(), 'prepareUsernameMigration').mockResolvedValue({
				state: 'preparing',
				epoch: 1,
				preparing_at: preparingAt,
				started_at: null,
				forced_at: null,
			});
			return {
				request: {path: '/admin/instance/username-migration/prepare', body: {processes_ready: true}},
				expected: {
					action: 'prepare_username_migration',
					targetType: 'username_migration',
					targetId: '0',
					metadata: {epoch: '1', processes_ready: 'true', preparing_at: preparingAt},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/username-migration/start',
		async prepare() {
			setInjectedUsernameMigrationPreconditions(async () => ({
				holdsReady: true,
				capacityReady: true,
				reserveVersion: 0,
			}));
			vi.spyOn(getInstanceConfigRepository(), 'setUsernameMigrationGuildCapacity').mockResolvedValue(undefined);
			const guildCapacity = {
				max_guild_members: 100,
				max_guild_online: 10,
				source: 'activity report',
				observed_at: new Date().toISOString(),
			};
			vi.spyOn(UsernamePolicyService.prototype, 'readAuthoritative').mockResolvedValue({
				policyRevision: 1,
				tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
				migration: {state: 'preparing', epoch: 1, startedAt: null, forcedAt: null},
				admission: {globalPerSecond: 100, paused: false},
				dictionary: compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []}),
			});
			vi.spyOn(getInstanceConfigRepository(), 'startUsernameMigration').mockResolvedValue({
				state: 'selecting',
				epoch: 1,
				preparing_at: '2026-10-09T00:00:00.000Z',
				started_at: '2026-10-09T01:00:00.000Z',
				forced_at: '2026-10-16T01:00:00.000Z',
			});
			return {
				request: {
					path: '/admin/instance/username-migration/start',
					body: {epoch: 1, mobile_published: true, mobile_version: '1.2.3', guild_capacity: guildCapacity},
				},
				expected: {
					action: 'start_username_migration',
					targetType: 'username_migration',
					targetId: '0',
					metadata: {
						epoch: '1',
						mobile_published: 'true',
						mobile_version: '1.2.3',
						dictionary_gen: '1',
						max_guild_members: '100',
						max_guild_online: '10',
						source: guildCapacity.source,
						observed_at: guildCapacity.observed_at,
					},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/username-migration/rollback',
		async prepare() {
			vi.spyOn(getInstanceConfigRepository(), 'rollbackUsernameMigration').mockResolvedValue({
				state: 'legacy',
				epoch: 1,
				preparing_at: null,
				started_at: null,
				forced_at: null,
			});
			return {
				request: {path: '/admin/instance/username-migration/rollback', body: {epoch: 1}},
				expected: {
					action: 'rollback_username_migration',
					targetType: 'username_migration',
					targetId: '0',
					metadata: {epoch: '1'},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/instance/username-policy',
		async prepare() {
			const policy = await getInstanceConfigRepository().readUsernamePolicyConfig();
			return {
				request: {path: '/admin/instance/username-policy'},
				expected: {
					action: 'get_instance_config',
					targetType: 'username_policy',
					targetId: '0',
					metadata: {revision: String(policy.revision)},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/instance/username-policy',
		async prepare() {
			const policy = await getInstanceConfigRepository().readUsernamePolicyConfig();
			const tiers = {'1': 'public', '2': 'public', '3': 'public'};
			return {
				request: {path: '/admin/instance/username-policy', body: {tiers}},
				expected: {
					action: 'update_username_policy',
					targetType: 'username_policy',
					targetId: '0',
					metadata: {
						revision: String(policy.revision + 1),
						tiers: JSON.stringify(tiers),
						admission: JSON.stringify(policy.admission),
						held_manifest: JSON.stringify(policy.held_manifest),
					},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/instance/config',
		async prepare({harness, admin}) {
			await createRegistrationUrl(harness, admin);
			return {
				request: {path: '/admin/instance/config'},
				expected: {
					action: 'get_instance_config',
					targetType: 'instance_config',
					targetId: '0',
					metadata: {registration_url_count: '1'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/instance/config',
		async prepare() {
			return {
				request: {
					path: '/admin/instance/config',
					body: {
						registration: {mode: 'approval'},
						experiment_delivery: {poll_interval_seconds: 600},
						sso: null,
					},
				},
				expected: {
					action: 'update_instance_config',
					targetType: 'instance_config',
					targetId: '0',
					metadata: {sections: 'experiment_delivery,registration'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/config/branding-assets',
		async prepare() {
			return {
				request: {path: '/admin/instance/config/branding-assets', body: {kind: 'icon', image: getPngDataUrl()}},
				expected: {
					action: 'upload_branding_asset',
					targetType: 'instance_config',
					targetId: '0',
					metadata: {kind: 'icon', cleared: 'false'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/config/smtp-tests',
		async prepare() {
			return {
				request: {
					path: '/admin/instance/config/smtp-tests',
					body: {host: '127.0.0.1', port: 1, username: 'coverage', password: 'coverage-password', tls_mode: 'none'},
				},
				expected: {
					action: 'test_smtp_connection',
					targetType: 'instance_config',
					targetId: '0',
					metadata: {port: '1', tls_mode: 'none', ok: 'false'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/instance/registration-urls',
		async prepare() {
			return {
				request: {
					path: '/admin/instance/registration-urls',
					body: {label: 'Coverage invite', max_uses: 5, approval_required: true},
				},
				expected: {
					action: 'create_registration_url',
					targetType: 'registration_url',
					targetId: '0',
					metadata: {approval_required: 'true', max_uses: '5'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/instance/registration-urls/:registration_url_id',
		async prepare({harness, admin}) {
			const registrationUrlId = await createRegistrationUrl(harness, admin);
			return {
				request: {path: `/admin/instance/registration-urls/${registrationUrlId}`},
				expected: {
					action: 'revoke_registration_url',
					targetType: 'registration_url',
					targetId: '0',
					metadata: {},
				},
			};
		},
	},
	{
		method: 'GET',
		route: '/admin/instance/pending-registrations',
		async prepare({harness}) {
			await getInstanceConfigRepository().setRegistrationConfig({mode: 'approval'});
			await registerUser(harness, {
				email: createUniqueEmail('coverage-listed'),
				username: createUniqueUsername('coveragelisted'),
				global_name: 'Coverage Listed',
				password: 'coverage-listed-password',
				date_of_birth: '2000-01-01',
				consent: true,
			});
			return {
				request: {path: '/admin/instance/pending-registrations'},
				expected: {
					action: 'list_pending_registrations',
					targetType: 'instance_config',
					targetId: '0',
					metadata: {pending_registration_count: '1'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/instance/pending-registrations/:user_id',
		async prepare({harness}) {
			await getInstanceConfigRepository().setRegistrationConfig({mode: 'approval'});
			const pending = await registerUser(harness, {
				email: createUniqueEmail('coverage-pending'),
				username: createUniqueUsername('coveragepending'),
				global_name: 'Coverage Pending',
				password: 'coverage-pending-password',
				date_of_birth: '2000-01-01',
				consent: true,
			});
			return {
				request: {path: `/admin/instance/pending-registrations/${pending.user_id}`, body: {status: 'approved'}},
				expected: {
					action: 'approve_registration',
					targetType: 'user',
					targetId: pending.user_id,
					metadata: {},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/instance/pending-registrations/:user_id',
		name: 'missing account',
		async prepare() {
			await getInstanceConfigRepository().setRegistrationConfig({mode: 'approval'});
			return {
				request: {
					path: `/admin/instance/pending-registrations/${TEST_IDS.NONEXISTENT_USER}`,
					body: {status: 'rejected'},
				},
				expected: {
					action: 'reject_registration',
					targetType: 'user',
					targetId: TEST_IDS.NONEXISTENT_USER,
					metadata: {account_found: 'false'},
				},
			};
		},
	},
];
