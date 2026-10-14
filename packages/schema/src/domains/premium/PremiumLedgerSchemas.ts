// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

export const EndUserPremiumResponse = z.object({
	previous_paid_until: z.iso.datetime().nullable().describe('Paid premium end before the change; null when none'),
	paid_until: z.iso.datetime().nullable().describe('Paid premium end now'),
});

export type EndUserPremiumResponse = z.infer<typeof EndUserPremiumResponse>;
