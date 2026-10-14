// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

export interface PremiumTrialByEmailRow {
	email_hash: string;
	user_id: UserID;
	created_at: Date;
}

export const PREMIUM_TRIAL_BY_EMAIL_COLUMNS = ['email_hash', 'user_id', 'created_at'] as const satisfies ReadonlyArray<
	keyof PremiumTrialByEmailRow
>;
