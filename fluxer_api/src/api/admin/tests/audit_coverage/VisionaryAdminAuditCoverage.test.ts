// SPDX-License-Identifier: AGPL-3.0-or-later

import {describeAdminAuditCoverage} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {VisionaryAdminAuditCases} from '@app/api/admin/tests/audit_coverage/VisionaryAdminAuditCases';

describeAdminAuditCoverage('VisionaryAdminController', VisionaryAdminAuditCases);
