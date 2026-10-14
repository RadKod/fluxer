// SPDX-License-Identifier: AGPL-3.0-or-later

import {EMAIL_I18N_LOCALE_MESSAGES} from '@pkgs/email/src/email_i18n/EmailI18nLocales';
import {describe, expect, it} from 'vitest';

// Micup: product_name is "Micup" (back vowel u, hard p), so Turkish suffixes are 'u, 'un, 'a, 'ta, 'tan, 'taki.
const WRONG_SUFFIX = /\{product_name\}'(u|un|ı|ın|a|ya|ye|ta|tan|taki|te|ten|teki|da|dan|daki)(?![a-zçğıöşü])/g;

describe('sanalyer Turkish email suffixes', () => {
	it('attaches suffixes that agree with "sanalyer"', () => {
		expect(JSON.stringify(EMAIL_I18N_LOCALE_MESSAGES.tr).match(WRONG_SUFFIX)).toBeNull();
	});
});
