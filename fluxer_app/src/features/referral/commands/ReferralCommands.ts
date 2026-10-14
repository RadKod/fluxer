// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

// Asking for the own referral state creates the code on first read while the programme is open.
export async function fetchReferral(): Promise<ReferralMeResponse> {
	const response = await http.get<ReferralMeResponse>(Endpoints.USER_REFERRAL);
	return response.body;
}
