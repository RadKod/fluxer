// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';

// Stale version, taken position, already at another table, or a seat change while playing.
export class TableGameConflictError extends ConflictError {
	constructor() {
		super({code: APIErrorCodes.TABLE_GAME_CONFLICT});
	}
}
