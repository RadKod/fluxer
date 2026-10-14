// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';

export class UnknownGuildRosterEventError extends NotFoundError {
	constructor() {
		super({code: APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT});
	}
}
