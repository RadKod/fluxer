// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';

// Another activity session is still running in the voice channel.
export class VoiceActivityConflictError extends ConflictError {
	constructor() {
		super({code: APIErrorCodes.VOICE_ACTIVITY_CONFLICT});
	}
}
