// SPDX-License-Identifier: AGPL-3.0-or-later

import {EMAIL_I18N_LOCALE_MESSAGES} from '@pkgs/email/src/email_i18n/EmailI18nLocales';
import {describe, expect, it} from 'vitest';

// Micup: product_name is "Micup" (back vowel u, hard p), so Turkish suffixes are 'u, 'un, 'a, 'ta, 'tan, 'taki.
const WRONG_SUFFIX = /\{product_name\}'(ı|ın|i|in|e|ye|ya|da|de|dan|den|daki|deki)(?![a-zçğıöşü])/g;

describe('Micup Turkish email suffixes', () => {
	it('attaches suffixes that agree with "Micup"', () => {
		expect(JSON.stringify(EMAIL_I18N_LOCALE_MESSAGES.tr).match(WRONG_SUFFIX)).toBeNull();
	});
});
