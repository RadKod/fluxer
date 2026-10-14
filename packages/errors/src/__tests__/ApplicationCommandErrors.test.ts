// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ApplicationCommandBotUnavailableError} from '@fluxer/errors/src/domains/application_command/ApplicationCommandBotUnavailableError';
import {ApplicationCommandFeatureDisabledError} from '@fluxer/errors/src/domains/application_command/ApplicationCommandFeatureDisabledError';
import {ApplicationCommandStaleError} from '@fluxer/errors/src/domains/application_command/ApplicationCommandStaleError';
import {ApplicationCommandVersionConflictError} from '@fluxer/errors/src/domains/application_command/ApplicationCommandVersionConflictError';
import {InteractionDeadlineExceededError} from '@fluxer/errors/src/domains/application_command/InteractionDeadlineExceededError';
import {InteractionNonceConflictError} from '@fluxer/errors/src/domains/application_command/InteractionNonceConflictError';
import {InteractionOutcomeUnknownError} from '@fluxer/errors/src/domains/application_command/InteractionOutcomeUnknownError';
import {InteractionTokenConsumedError} from '@fluxer/errors/src/domains/application_command/InteractionTokenConsumedError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {describe, expect, test} from 'vitest';

const CASES = [
	['APPLICATION_COMMAND_STALE', ApplicationCommandStaleError, 409],
	['APPLICATION_COMMAND_VERSION_CONFLICT', ApplicationCommandVersionConflictError, 412],
	['APPLICATION_COMMAND_FEATURE_DISABLED', ApplicationCommandFeatureDisabledError, 403],
	['APPLICATION_COMMAND_BOT_UNAVAILABLE', ApplicationCommandBotUnavailableError, 503],
	['INTERACTION_DEADLINE_EXCEEDED', InteractionDeadlineExceededError, 410],
	['INTERACTION_TOKEN_CONSUMED', InteractionTokenConsumedError, 409],
	['INTERACTION_NONCE_CONFLICT', InteractionNonceConflictError, 409],
	['INTERACTION_OUTCOME_UNKNOWN', InteractionOutcomeUnknownError, 503],
] as const;

describe('application command domain errors', () => {
	test.each(CASES)('%s uses the Fluxer envelope', async (code, ErrorClass, status) => {
		expect(APIErrorCodes[code]).toBe(code);
		const error = new ErrorClass();
		expect(error).toBeInstanceOf(FluxerError);
		expect(error.status).toBe(status);
		expect(error.code).toBe(code);
		expect(error.data).toBeUndefined();
		expect(error.toJSON()).toEqual({code, message: code});
		expect(await error.getResponse().json()).toEqual(error.toJSON());
		expect(error.getResponse().status).toBe(status);
		for (const locale of ['en-US', 'tr']) {
			expect(getErrorMessageUnsafe(code, locale)).not.toBe(code);
		}
	});

	test('unknown outcome directs status recovery using the same nonce', () => {
		expect(getErrorMessageUnsafe('INTERACTION_OUTCOME_UNKNOWN', 'en-US')).toBe(
			'The interaction outcome is unknown. Check its status using the same nonce.',
		);
		expect(getErrorMessageUnsafe('INTERACTION_OUTCOME_UNKNOWN', 'tr')).toBe(
			'Etkileşimin sonucu bilinmiyor. Aynı nonce ile durumunu kontrol edin.',
		);
	});
});
