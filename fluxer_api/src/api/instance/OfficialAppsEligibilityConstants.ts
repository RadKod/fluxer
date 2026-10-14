// SPDX-License-Identifier: AGPL-3.0-or-later

export const OFFICIAL_APP_ELIGIBILITY_LEASE_MS = 35000;
export const OFFICIAL_APP_RESTRICTIVE_WRITE_DELAY_MS = OFFICIAL_APP_ELIGIBILITY_LEASE_MS + 100;
export const officialAppMutationKey = (id: string): string => `official-app-mutation:${id}`;
export const officialAppEligibilityLeaseKey = (id: string): string => `official-app-eligibility-lease:${id}`;
