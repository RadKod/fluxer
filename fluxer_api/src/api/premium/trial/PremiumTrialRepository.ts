// SPDX-License-Identifier: AGPL-3.0-or-later

import {executeConditional, fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {PremiumTrialByEmailRow} from '@app/api/database/types/PremiumTrialTypes';
import {PremiumTrialsByEmail} from '@app/api/premium/trial/PremiumTrialTables';
import {seconds} from 'itty-time';

// KVKK: the address hash exists only to stop repeat trials, so it is kept two years and then expires on its own
// (purpose and period in micup-v2-infra docs/yasal-eksikler.md). Afterwards that address may claim once more.
const EMAIL_HASH_TTL_SECONDS = seconds('730 days');
const FETCH_BY_EMAIL_HASH_CQL = PremiumTrialsByEmail.selectCql({
	where: PremiumTrialsByEmail.where.eq('email_hash'),
	limit: 1,
});

export class PremiumTrialRepository {
	async find(emailHash: string): Promise<PremiumTrialByEmailRow | null> {
		return fetchOne<PremiumTrialByEmailRow>(FETCH_BY_EMAIL_HASH_CQL, {email_hash: emailHash});
	}

	async claim(row: PremiumTrialByEmailRow): Promise<boolean> {
		return executeConditional(PremiumTrialsByEmail.insertIfNotExistsWithTtl(row, EMAIL_HASH_TTL_SECONDS));
	}
}
