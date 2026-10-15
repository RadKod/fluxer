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
		it.each([
			['NAME_STYLES_REQUIRE_PREMIUM', 'en-US', {}, 'Name styles require Plus.'],
			['PROFILE_THEMES_REQUIRE_PREMIUM', 'tr', {}, 'Profil temaları için Plus gerekli.'],
			[
				'NAME_COLORS_NOT_READABLE',
				'tr',
				{},
				'Bu ad renkleri koyu zeminde okunamayacak kadar koyu. Daha açık bir renk seç.',
			],
			[
				'NAME_STYLE_CHANGED_TOO_MANY_TIMES',
				'en-US',
				{minutes: 1},
				"You've changed your name style too often recently. Please try again in 1 minute.",
			],
			[
				'THEME_COLORS_CHANGED_TOO_MANY_TIMES',
				'tr',
				{minutes: 12},
				'Son zamanlarda profil temanı çok sık değiştirdin. Lütfen 12 dakika sonra tekrar dene.',
			],
		])('localizes the Plus appearance error %s in %s', (code, locale, variables, expected) => {
			expect(getErrorMessageUnsafe(code, locale, variables)).toBe(expected);
			expect(consoleWarnSpy).not.toHaveBeenCalled();
		});
		it('returns message for valid key in supported locale', () => {
			const message = getErrorMessage('rate_limits.rate_limited', 'fr');
			expect(message).toBe('Vous avez atteint la limite de requêtes.');
		});
		it('returns key when translation missing', () => {
			const message = getErrorMessageUnsafe('nonexistent.key', 'en-US');
			expect(message).toBe('nonexistent.key');
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'Missing translation for error message: nonexistent.key (locale: en-US)',
			);
		});
		it('returns fallbackMessage when provided and key missing', () => {
			const message = getErrorMessageUnsafe('nonexistent.key', 'en-US', undefined, 'Custom fallback');
			expect(message).toBe('Custom fallback');
		});
	});
	describe('getMessage() - locale handling', () => {
		it('normalizes en-GB locale to en-US', () => {
			const message = getErrorMessage('rate_limits.rate_limited', 'en-GB');
			expect(message).toBe("You're being rate limited.");
		});
		it('normalizes en-CA locale to en-US', () => {
			const message = getErrorMessage('rate_limits.rate_limited', 'en-CA');
			expect(message).toBe("You're being rate limited.");
		});
		it('falls back to en-US for unsupported locales', () => {
			const message = getErrorMessage('rate_limits.rate_limited', 'de-DE');
			expect(message).toBe("You're being rate limited.");
			expect(consoleWarnSpy).toHaveBeenCalledWith('Unsupported locale, falling back to en-US: de-DE');
		});
		it('handles null locale by defaulting to en-US', () => {
			const message = getErrorMessage('rate_limits.rate_limited', null);
			expect(message).toBe("You're being rate limited.");
		});
		it('handles undefined locale by defaulting to en-US', () => {
			const message = getErrorMessage('rate_limits.rate_limited', undefined);
			expect(message).toBe("You're being rate limited.");
		});
		it('loads locale on-demand when first accessed', () => {
			expect(hasErrorLocale('fr')).toBe(true);
			const message = getErrorMessage('account.suspended_permanently', 'fr');
			expect(message).toBe('Ce compte a été suspendu définitivement.');
		});
	});
	describe('getMessage() - variable interpolation', () => {
		it('interpolates simple {variable} placeholders', () => {
			const message = getErrorMessage('channels_and_guilds.invalid_channel_id', 'en-US', {
				channelId: '123456789',
			});
			expect(message).toBe('Invalid channel ID: 123456789.');
		});
		it('handles MessageFormat plural syntax', () => {
			const message = getErrorMessage('rate_limits.username_changed_too_often', 'en-US', {
				minutes: 1,
			});
			expect(message).toBe("You've changed your username too often recently. Please try again in 1 minute.");
		});
		it('handles MessageFormat plural syntax for multiple values', () => {
			const message = getErrorMessage('rate_limits.username_changed_too_often', 'en-US', {
				minutes: 5,
			});
			expect(message).toBe("You've changed your username too often recently. Please try again in 5 minutes.");
		});
		it('falls back to simple interpolation on MessageFormat failure', () => {
			const message = getErrorMessage('channels_and_guilds.invalid_channel_id', 'en-US', {
				channelId: 'test-channel',
			});
			expect(message).toBe('Invalid channel ID: test-channel.');
		});
		it('returns raw message when no variables provided', () => {
			const message = getErrorMessage('rate_limits.rate_limited', 'en-US');
			expect(message).toBe("You're being rate limited.");
		});
		it('handles complex nested error keys', () => {
			const message = getErrorMessage('roles.invalid_role_id', 'en-US', {roleId: '999'});
			expect(message).toBe('Invalid role ID: 999.');
		});
	});
	describe('global IP block messages', () => {
		const HOSTED = {
			ipAddress: '203.0.113.20',
			appealEmail: 'support@fluxer.com',
			expiresAt: 'Jan 12, 2027, 9:00 AM UTC',
			reason: 'none',
			product_name: 'Fluxer',
		};
		const SELF_HOSTED = {...HOSTED, appealEmail: null, product_name: 'chat.example.org'};
		const SHARED_NETWORK =
			'If you share this network, for example at school, at work, on public Wi-Fi, through your mobile carrier or a VPN, this block may have nothing to do with you. The quickest fix is to switch networks, for example to mobile data instead of Wi-Fi, or to turn your VPN on or off.';

		it('names the instance and no mailbox in any locale when there is no appeal address', () => {
			for (const locale of Object.keys(ERROR_I18N_LOCALE_MESSAGES)) {
				for (const code of ['GLOBAL_IP_BANNED', 'GLOBAL_IP_TEMPORARILY_BANNED']) {
					const neutral = getErrorMessageUnsafe(code, locale, SELF_HOSTED);
					expect(neutral, `${locale} ${code}`).not.toMatch(/@|\bnull\b|\{/);
					expect(neutral, `${locale} ${code}`).toContain('chat.example.org');
					expect(neutral, `${locale} ${code}`).not.toContain('Fluxer');
					const hosted = getErrorMessageUnsafe(code, locale, HOSTED);
					expect(hosted, `${locale} ${code}`).toContain('support@fluxer.com');
					expect(hosted, `${locale} ${code}`).toContain('203.0.113.20');
					expect(hosted, `${locale} ${code}`).toContain('Fluxer');
				}
			}
		});

		it('leads with the shared-network advice and never blames the reader', () => {
			const permanent = getErrorMessageUnsafe('GLOBAL_IP_BANNED', 'en-US', HOSTED);
			expect(permanent).toBe(
				`Fluxer blocked access from this network. ${SHARED_NETWORK} If you think this block is a mistake, email support@fluxer.com and include your IP address, 203.0.113.20.`,
			);
			expect(getErrorMessageUnsafe('GLOBAL_IP_TEMPORARILY_BANNED', 'en-US', SELF_HOSTED)).toBe(
				`chat.example.org blocked access from this network. The block ends on Jan 12, 2027, 9:00 AM UTC. ${SHARED_NETWORK}`,
			);
			expect(getErrorMessageUnsafe('GLOBAL_IP_BANNED', 'en-US', {...HOSTED, reason: 'shown'})).toMatch(
				/^Fluxer blocked access from this network because of activity that broke its rules\. /,
			);
			for (const message of [permanent, getErrorMessageUnsafe('GLOBAL_IP_TEMPORARILY_BANNED', 'en-US', HOSTED)]) {
				expect(message).not.toMatch(/platform admin|sign in|\byou did\b/i);
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
