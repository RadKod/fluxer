// SPDX-License-Identifier: AGPL-3.0-or-later

import {describeAdminAuditCoverage} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {BanAdminAuditCases} from '@app/api/admin/tests/audit_coverage/BanAdminAuditCases';
import {InstanceConfigAdminAuditCases} from '@app/api/admin/tests/audit_coverage/InstanceConfigAdminAuditCases';
import {UserAdminAuditCases} from '@app/api/admin/tests/audit_coverage/UserAdminAuditCases';
import {expect, test} from 'vitest';

const usernameAuditCases = [...InstanceConfigAdminAuditCases, ...BanAdminAuditCases, ...UserAdminAuditCases].filter(
	(coverageCase) =>
		coverageCase.route === '/admin/instance/username-policy' ||
		coverageCase.route === '/admin/username-dictionary' ||
		coverageCase.route === '/admin/instance/username-migration' ||
		coverageCase.route.startsWith('/admin/instance/username-migration/') ||
		coverageCase.route.startsWith('/admin/usernames/') ||
		coverageCase.route === '/admin/users/:user_id/username/reselect',
);

test('registers audit coverage for every username policy, dictionary, ownership, and migration route', () => {
	expect(usernameAuditCases.map(({method, route}) => `${method} ${route}`).sort()).toEqual([
		'GET /admin/instance/username-migration',
		'GET /admin/instance/username-policy',
		'GET /admin/username-dictionary',
		'GET /admin/usernames/reservations',
		'PATCH /admin/instance/username-policy',
		'PATCH /admin/username-dictionary',
		'POST /admin/instance/username-migration/prepare',
		'POST /admin/instance/username-migration/rollback',
		'POST /admin/instance/username-migration/start',
		'POST /admin/usernames/assign',
		'POST /admin/usernames/reserve',
		'POST /admin/usernames/unreserve',
		'POST /admin/users/:user_id/username/reselect',
	]);
});

describeAdminAuditCoverage('username policy', usernameAuditCases);
