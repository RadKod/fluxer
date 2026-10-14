// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {PREMIUM_TRIAL_BY_EMAIL_COLUMNS, type PremiumTrialByEmailRow} from '@app/api/database/types/PremiumTrialTypes';

export const PremiumTrialsByEmail = defineTable<PremiumTrialByEmailRow, 'email_hash'>({
	name: 'premium_trials_by_email',
	columns: PREMIUM_TRIAL_BY_EMAIL_COLUMNS,
	primaryKey: ['email_hash'],
});
