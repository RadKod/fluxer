// SPDX-License-Identifier: AGPL-3.0-or-later

import {IpBannedError} from '@fluxer/errors/src/domains/moderation/IpBannedError';
import {CannotRedeemPlutoniumWithVisionaryError} from '@fluxer/errors/src/domains/payment/CannotRedeemPlutoniumWithVisionaryError';
import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {ERROR_I18N_LOCALE_MESSAGES} from '@fluxer/errors/src/i18n/ErrorI18nLocales';
import {ERROR_I18N_MESSAGES} from '@fluxer/errors/src/i18n/ErrorI18nMessages';
import {describe, expect, it} from 'vitest';

// Micup: user-facing error text names Micup, Micup Plus and Micup support.
// Fails when an upstream merge brings back the Fluxer product, tier name or support address.
const UPSTREAM_BRAND = /Fluxer|fluxer\.app|Plutonium/;

const CATALOGS: Record<string, Record<string, string>> = {
	'en-US': ERROR_I18N_MESSAGES,
	...ERROR_I18N_LOCALE_MESSAGES,
};

describe('sanalyer error brand', () => {
	it.each(Object.keys(CATALOGS))('%s names no upstream brand or support address', (locale) => {
		const leaks = Object.entries(CATALOGS[locale])
			.filter(([, message]) => UPSTREAM_BRAND.test(message))
			.map(([key]) => key);
		expect(leaks).toEqual([]);
	});

	it('sends IP ban appeals to sanalyer support', () => {
		const message = getErrorMessageUnsafe('GLOBAL_IP_BANNED', 'en-US', {ipAddress: '203.0.113.1'});
		expect(message).toContain('sanalyer API');
		expect(message).toContain('info@sanalyer.com');
		const error = new IpBannedError({
			ipAddress: '203.0.113.1',
			kind: 'permanent',
			appealEmail: 'info@sanalyer.com',
			productName: 'sanalyer',
		});
		expect(error.data?.appeal_email).toBe('info@sanalyer.com');
	});

	it('calls the premium tier sanalyer Plus', () => {
		expect(new CannotRedeemPlutoniumWithVisionaryError().messageVariables).toEqual({
			premium_tier_name: 'sanalyer Plus',
		});
	});
});
