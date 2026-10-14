// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ErrorCodeToI18nKey} from '@fluxer/errors/src/i18n/ErrorCodeMappings';
import {ERROR_I18N_MESSAGES} from '@fluxer/errors/src/i18n/ErrorI18nMessages';
import {describe, expect, it} from 'vitest';

describe('username error registry connections', () => {
	it.each([
		APIErrorCodes.USERNAME_TAKEN,
		APIErrorCodes.USERNAME_RESERVED,
		APIErrorCodes.USERNAME_BLOCKED,
		APIErrorCodes.USERNAME_RELEASE_EMBARGO,
		APIErrorCodes.USERNAME_COOLDOWN,
		APIErrorCodes.USERNAME_BUSY,
		APIErrorCodes.USERNAME_RATE_LIMITED,
		APIErrorCodes.USERNAME_INVALID,
		APIErrorCodes.USERNAME_RESERVED_TERM,
		APIErrorCodes.USERNAME_TOO_SHORT,
		APIErrorCodes.USERNAME_REQUIRES_ENTITLEMENT,
		APIErrorCodes.USERNAME_UNAVAILABLE,
		APIErrorCodes.USERNAME_SELECTION_REQUIRED,
	])('connects %s to an existing message without required interpolation variables', (code) => {
		const key = ErrorCodeToI18nKey[code as keyof typeof ErrorCodeToI18nKey];
		expect(key).toBeDefined();
		expect(ERROR_I18N_MESSAGES[key]).toBeTypeOf('string');
		expect(ERROR_I18N_MESSAGES[key]).not.toContain('{');
	});
});
