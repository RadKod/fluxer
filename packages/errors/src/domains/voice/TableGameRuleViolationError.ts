// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import type {TableGameRuleReason} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// The body carries only the closed reason enum, never a tile.
export class TableGameRuleViolationError extends BadRequestError {
	constructor(reason: TableGameRuleReason) {
		super({code: APIErrorCodes.TABLE_GAME_RULE_VIOLATION, data: {reason}});
	}
}
