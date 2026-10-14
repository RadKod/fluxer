// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

export class InteractionOutcomeUnknownError extends ServiceUnavailableError {
	constructor() {
		super({code: APIErrorCodes.INTERACTION_OUTCOME_UNKNOWN});
	}
}
