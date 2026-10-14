// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

export const PremiumTrialEligibilityResponse = z.object({
	eligible: z.boolean().describe('Whether the authenticated user can start the free premium trial now'),
	days: z.number().int().describe('Length of the trial in days, 0 when the instance offers no trial'),
	reason: z
		.enum(['unavailable', 'not_eligible', 'already_used'])
		.nullable()
		.describe('Why the user cannot start the trial, null when eligible'),
});

export type PremiumTrialEligibilityResponse = z.infer<typeof PremiumTrialEligibilityResponse>;
