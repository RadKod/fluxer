// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getPremiumLedgerService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	userId: z.string().regex(/^\d+$/),
});

const ensureUserPremium: WorkerTaskHandler = async (payload) => {
	const {userId} = PayloadSchema.parse(payload);
	await getPremiumLedgerService().ensureUserPremium(createUserID(BigInt(userId)));
};

export default ensureUserPremium;
