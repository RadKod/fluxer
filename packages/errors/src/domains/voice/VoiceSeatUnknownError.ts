// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

// The seat is not in the channel's room theme, or it is a table seat (those go through the table game routes).
export class VoiceSeatUnknownError extends BadRequestError {
	constructor() {
		super({code: APIErrorCodes.VOICE_SEAT_UNKNOWN});
	}
}
