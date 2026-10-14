// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {FluxerError} from '@fluxer/errors/src/FluxerError';

export class ApplicationCommandVersionConflictError extends FluxerError {
	constructor() {
		super({code: APIErrorCodes.APPLICATION_COMMAND_VERSION_CONFLICT, status: 412});
	}
}
