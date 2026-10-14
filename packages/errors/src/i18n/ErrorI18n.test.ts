// SPDX-License-Identifier: AGPL-3.0-or-later

import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {ERROR_I18N_LOCALE_MESSAGES} from '@fluxer/errors/src/i18n/ErrorI18nLocales';
import {beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';

describe('ErrorI18n', () => {
	let consoleWarnSpy: MockInstance;
	beforeEach(() => {
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleWarnSpy.mockClear();
	});
	describe('entrance sound entitlement errors', () => {
		it.each([
			['en-US', 'Entrance sounds require Plus.'],
			['tr', 'Giriş sesleri için Plus gerekli.'],
		])('localizes entrance sound entitlement errors in %s', (locale, expected) => {
			expect(getErrorMessageUnsafe('ENTRANCE_SOUNDS_REQUIRE_PREMIUM', locale)).toBe(expected);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});
	});
	describe('global IP block messages', () => {
		it('names the blocked address and the sanalyer support mailbox in every locale', () => {
			for (const locale of Object.keys(ERROR_I18N_LOCALE_MESSAGES)) {
				for (const code of ['GLOBAL_IP_BANNED', 'GLOBAL_IP_TEMPORARILY_BANNED']) {
					const message = getErrorMessageUnsafe(code, locale, {ipAddress: '203.0.113.20'});
					expect(message, `${locale} ${code}`).toContain('203.0.113.20');
					expect(message, `${locale} ${code}`).toContain('info@sanalyer.com');
					expect(message, `${locale} ${code}`).not.toContain('Fluxer');
				}
			}
		});
	});
	describe('payment processing error', () => {
		const HOSTED = {supportEmail: 'support@fluxer.com'};
		const SELF_HOSTED = {supportEmail: null};
		const ENGLISH_NEUTRAL =
			'Payment processing encountered an error. Please try again or contact the administrators of this instance.';

		it('has a translated neutral variant in every locale', () => {
			for (const locale of Object.keys(ERROR_I18N_LOCALE_MESSAGES)) {
				const hosted = getErrorMessageUnsafe('STRIPE_ERROR', locale, HOSTED);
				const neutral = getErrorMessageUnsafe('STRIPE_ERROR', locale, SELF_HOSTED);
				expect(neutral, locale).not.toBe(hosted);
				expect(neutral, locale).not.toMatch(/@|\bnull\b|\{|support/i);
				if (locale !== 'en-GB') {
					expect(neutral, locale).not.toBe(ENGLISH_NEUTRAL);
				}
			}
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});
	});
	describe('phone rejection messages', () => {
		it.each([
			[
				'phone.country_not_supported',
				"We don't send verification texts to this country. Use a mobile number from another country, or email info@sanalyer.com and a person will review your account.",
			],
			[
				'phone.inbound_verification_required',
				'This number is verified by texting us instead of us texting you. Start phone verification again to get the code and the number to text.',
			],
			[
				'phone.lookup_unavailable',
				'Our phone number check is down right now, so we stopped before sending your code. This is on us, not your number. Wait a few minutes and try the same number again.',
			],
			[
				'phone.number_not_in_service',
				"Your carrier says this number isn't in service. Check the number and try again, or email info@sanalyer.com if it's correct.",
			],
			[
				'phone.number_not_mobile',
				"This isn't a mobile number, so it can't receive our text. Use a mobile number, or email info@sanalyer.com if you think that's wrong.",
			],
			[
				'phone.verification_needs_review',
				"We couldn't verify this number automatically. Email info@sanalyer.com and a person will review your account.",
			],
		])('resolves %s to its own message', (code, expected) => {
			const message = getErrorMessageUnsafe(code, 'en-US');
			expect(message).toBe(expected);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});
		it.each([
			'phone.country_not_supported',
			'phone.number_not_in_service',
			'phone.number_not_mobile',
			'phone.verification_needs_review',
		])('routes %s to support', (code) => {
			expect(getErrorMessageUnsafe(code, 'en-US')).toContain('info@sanalyer.com');
		});
		it('blames us for a lookup outage and invites the same number again', () => {
			const message = getErrorMessageUnsafe('phone.lookup_unavailable', 'en-US');
			expect(message).toContain('This is on us, not your number.');
			expect(message).toContain('try the same number again');
			expect(message.toLowerCase()).not.toContain('invalid');
		});
		it('falls back to the source message when the locale has no catalog', () => {
			expect(getErrorMessageUnsafe('phone.lookup_unavailable', 'zz-ZZ')).toBe(
				getErrorMessageUnsafe('phone.lookup_unavailable', 'en-US'),
			);
		});
		it('serves a real translation for a locale that has one', () => {
			for (const locale of ['fr', 'de', 'ja', 'pt-BR']) {
				expect(getErrorMessageUnsafe('phone.lookup_unavailable', locale)).not.toBe(
					getErrorMessageUnsafe('phone.lookup_unavailable', 'en-US'),
				);
			}
		});
	});
	describe('account limited message', () => {
		it('resolves ACCOUNT_LIMITED to its own message', () => {
			expect(getErrorMessageUnsafe('ACCOUNT_LIMITED', 'en-US')).toBe(
				'Messaging is paused on your account. Check your email for a quick step to continue.',
			);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});
	});
});
