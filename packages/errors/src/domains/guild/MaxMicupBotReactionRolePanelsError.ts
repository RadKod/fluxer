// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

export class MaxMicupBotReactionRolePanelsError extends BadRequestError {
	constructor(limit: number) {
		super({
			code: APIErrorCodes.MAX_MICUPBOT_REACTION_ROLE_PANELS,
			messageVariables: {count: limit},
			data: {
				max_micupbot_reaction_role_panels: limit,
			},
		});
	}
}
