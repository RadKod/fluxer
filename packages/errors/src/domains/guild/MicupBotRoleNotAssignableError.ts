// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

export class MicupBotRoleNotAssignableError extends BadRequestError {
	constructor(roleId: string) {
		super({
			code: APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE,
			data: {
				role_id: roleId,
			},
		});
	}
}
