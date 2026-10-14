// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as constants from '@app/features/app/config/I18nDisplayConstants';
import {
	EXAMPLE_FLUXER_TAG,
	EXAMPLE_PERSONAL_EMAIL,
	PREMIUM_PRODUCT_FULL_NAME,
	PREMIUM_PRODUCT_NAME,
	PRODUCT_NAME,
	SUPPORT_EMAIL,
	SUPPORT_EMAIL_MAILTO,
} from '@app/features/app/config/I18nDisplayConstants';
import {findGifts} from '@app/features/gift/utils/GiftCodeUtils';
import {findInvite} from '@app/features/invite/utils/InviteUtils';
import {isInternalChannelHost} from '@app/features/navigation/utils/DeepLinkUtils';
import {findThemes} from '@app/features/theme/utils/ThemeUtils';
import TrustedDomain from '@app/features/trusted_domain/state/TrustedDomain';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {}}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {getItem: () => null},
	onBeforeAppStorageScopeChange: () => () => {},
	subscribeAppStorageScope: () => () => {},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		isSelfHosted: () => false,
		inviteUrlBase: '',
		mediaEndpoint: 'https://sanalyer.com/media',
		staticCdnEndpoint: '',
	},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {trustedDomains: [], trustAllDomains: () => false},
}));
// DeepLinkUtils' UI side (modals, commands, router) is not under test here.
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/gift/commands/GiftCommands', () => ({}));
vi.mock('@app/features/invite/commands/InviteCommands', () => ({}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({}));
vi.mock('@app/features/app/components/dialogs/LoadableSettingsModals', () => ({}));
vi.mock('@app/features/navigation/state/Navigation', () => ({default: {}}));
vi.mock('@app/features/premium/commands/PlutoniumPageCommands', () => ({}));
vi.mock('@app/features/premium/state/PlutoniumPageRollout', () => ({default: {}}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({setPathQueryParams: vi.fn()}));
vi.mock('@app/features/user/components/settings_utils/UserSettingsDeepLinks', () => ({}));

describe('sanalyer brand hosts', () => {
	it('recognizes sanalyer.com invite, gift and theme links and app links', () => {
		expect(findInvite('https://sanalyer.com/invite/abcDEF12')).toBe('abcDEF12');
		expect(findGifts('https://sanalyer.com/gift/abcDEF12')).toEqual(['abcDEF12']);
		expect(findThemes('https://sanalyer.com/theme/abcDEF12')).toEqual(['abcDEF12']);
		expect(isInternalChannelHost('sanalyer.com')).toBe(true);
	});

	// Micup is not Fluxer: a fluxer.gg/<code> link is another service's invite, and Fluxer's hosts are not ours.
	it('treats no Fluxer link as a sanalyer invite, gift, theme or app link', () => {
		expect(findInvite('https://fluxer.gg/abcDEF12')).toBeNull();
		expect(findInvite('https://fluxer.app/invite/abcDEF12')).toBeNull();
		expect(findGifts('https://fluxer.gift/abcDEF12')).toEqual([]);
		expect(findThemes('https://fluxer.app/theme/abcDEF12')).toEqual([]);
		for (const host of ['fluxer.app', 'canary.fluxer.app', 'web.fluxer.app', 'web.canary.fluxer.app']) {
			expect(isInternalChannelHost(host)).toBe(false);
		}
	});

	it('trusts sanalyer.com and the configured media host', () => {
		expect(TrustedDomain.isTrustedDomain('sanalyer.com')).toBe(true);
	});

	it('warns before opening any Fluxer host', () => {
		for (const host of [
			'fluxer.app',
			'evil.fluxer.app',
			'fluxer.gg',
			'fluxer.gift',
			'fluxerstatus.com',
			'x.fluxerstatus.com',
		]) {
			expect(TrustedDomain.isTrustedDomain(host)).toBe(false);
		}
	});

	// No *.sanalyer.com wildcard: one dangling CNAME taken over by someone else would otherwise open phishing links
	// without a warning.
	it('warns before opening any sanalyer.com subdomain and the old micup.gg hosts', () => {
		expect(TrustedDomain.isTrustedDomain('evil.sanalyer.com')).toBe(false);
		expect(TrustedDomain.isTrustedDomain('micup.gg')).toBe(false);
		expect(TrustedDomain.isTrustedDomain('canary.micup.gg')).toBe(false);
	});

	it('points the support contact to info@sanalyer.com', () => {
		expect(SUPPORT_EMAIL).toBe('info@sanalyer.com');
		expect(SUPPORT_EMAIL_MAILTO).toBe('mailto:info@sanalyer.com');
	});
});

// An upstream merge must not bring Fluxer's name, its premium name or its jokes back into what users read.
describe('sanalyer brand text', () => {
	const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../i18n/locales');
	const catalogs = readdirSync(localesDir, {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			// Every msgid/msgstr pair, not a map: msgctxt lets the same msgid appear more than once.
			// Tolerates CRLF checkouts and gettext continuation lines.
			const entries: Array<[msgid: string, msgstr: string]> = [];
			let field: string | null = null;
			for (const line of readFileSync(join(localesDir, entry.name, 'messages.po'), 'utf8').split(/\r?\n/)) {
				const start = /^(msgid|msgstr) "(.*)"$/.exec(line);
				if (start) {
					field = start[1];
					if (field === 'msgid') entries.push([start[2], '']);
					else entries[entries.length - 1][1] = start[2];
				} else if (field && line.startsWith('"') && line.endsWith('"')) {
					entries[entries.length - 1][field === 'msgid' ? 0 : 1] += line.slice(1, -1);
				} else {
					field = null;
				}
			}
			return {locale: entry.name, entries: entries.filter(([msgid]) => msgid !== '')};
		});
	const tr = catalogs.find(({locale}) => locale === 'tr')?.entries ?? [];
	// Not brand text: the domain verification file name, placeholder and environment variable names the API and code rely
	// on, and the bundled typeface's own name (Fluxer Sans, offered as the non-system font on Windows).
	const ALLOWED = /fluxer-verification|\{exampleFluxerTagFull\}|\{fluxerTag\}|FLUXER_SETUP_TOKEN|Fluxer Sans/g;
	// Never rendered: the self-hosted setup wizard placeholder and a settings search synonym.
	const UNRENDERED_MSGIDS = new Set(['Fluxer', 'Plutonium']);
	// This consent notice attributes a third-party relay, linked to its provider's privacy notice.
	const EXTERNAL_PUSH_RELAY_MSGID =
		"The official Fluxer mobile apps receive notifications through Fluxer's push relay, which hands them to Apple and Google. Self-hosted UnifiedPush and ntfy endpoints never reach the relay and need no agreement.";

	it('keeps sanalyer product branding in all 34 languages', () => {
		expect(catalogs).toHaveLength(34);
		const leaks = catalogs.flatMap(({locale, entries}) =>
			entries
				.filter(([msgid, msgstr]) => {
					const text = msgstr.replace(ALLOWED, '');
					const productText = msgid === EXTERNAL_PUSH_RELAY_MSGID ? text.replace(/fluxer/gi, '') : text;
					return !UNRENDERED_MSGIDS.has(msgid) && /fluxer|plutonium|capacitor|kapasitör/i.test(productText);
				})
				.map(([msgid]) => `${locale}: ${msgid}`),
		);
		expect(leaks).toEqual([]);
	});

	it('keeps the external push relay attribution with its provider privacy notice', () => {
		expect(
			catalogs
				.find(({locale}) => locale === 'en-US')
				?.entries.find(([msgid]) => msgid === EXTERNAL_PUSH_RELAY_MSGID)?.[1],
		).toBe(EXTERNAL_PUSH_RELAY_MSGID);
		const wizard = readFileSync(resolve(localesDir, '../../app/components/setup/SetupWizardSteps.tsx'), 'utf8');
		expect(wizard).toContain("const PUSH_RELAY_NOTICE_URL = 'https://fluxer.com/push-relay'");
		expect(wizard).toContain('href={PUSH_RELAY_NOTICE_URL}');
	});

	// "sanalyer" ends in a front vowel and a voiced r, like upstream's "Fluxer": sanalyer'i, sanalyer'e, sanalyer'de,
	// sanalyer'den, sanalyer'in. Micup's back-vowel suffixes (Micup'u, Micup'a, Micup'ta, Micup'tan, Micup'un) must not
	// come back.
	it('attaches Turkish suffixes that fit "sanalyer" to the product name', () => {
		const suffixes = tr.flatMap(([, msgstr]) =>
			[...msgstr.matchAll(/\{(?:productName|PRODUCT_NAME)\}['’](\p{L}+)/gu)].map((match) => match[1]),
		);
		expect(suffixes.length).toBeGreaterThan(0);
		expect(suffixes.filter((suffix) => suffix !== 's' && (/[aıou]/.test(suffix) || /^[tyn]/.test(suffix)))).toEqual([]);
	});

	// No window in the service worker, so its push notification titles use this fallback.
	it('names the product sanalyer and its premium plan sanalyer Premium without a bootstrap', () => {
		expect(PRODUCT_NAME).toBe('sanalyer');
		expect(PREMIUM_PRODUCT_NAME).toBe('sanalyer Plus');
		expect(PREMIUM_PRODUCT_FULL_NAME).toBe('sanalyer Plus');
	});

	it('uses neutral example values in form placeholders', () => {
		expect(EXAMPLE_FLUXER_TAG).toBe('Username');
		expect(EXAMPLE_PERSONAL_EMAIL).toBe('name@example.com');
	});

	// Catalog text is checked above; these values are filled into it at runtime. Micup: Weblate and fluxer.dev links
	// render only when the instance is not self-hosted, the Bluesky handle is unused.
	it('keeps Fluxer addresses only in display constants sanalyer never shows', () => {
		const fluxerValued = Object.entries(constants)
			.filter(([, value]) => typeof value === 'string' && /fluxer/i.test(value))
			.map(([name]) => name)
			.sort();
		// DESKTOP_DOWNLOAD_URL: until sanalyer ships its own clients, members use the official Fluxer apps.
		expect(fluxerValued).toEqual([
			'DESKTOP_DOWNLOAD_URL',
			'FLUXER_BLUESKY_HANDLE',
			'FLUXER_DOCS_DOMAIN',
			'FLUXER_DOCS_URL',
			'I18N_WEBLATE_DOMAIN',
			'I18N_WEBLATE_URL',
		]);
	});
});
