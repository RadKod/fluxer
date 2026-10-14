// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value);
		},
	},
}));
// initI18n turns any error into the en-US fallback and only logs it; throwing here keeps such a failure visible
// instead of passing for an ordinary en-US result.
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error(...args: Array<unknown>): never {
			throw new Error(`i18n logged an error: ${args.map(String).join(' ')}`);
		}
		warn(): void {}
		info(): void {}
		debug(): void {}
		log(): void {}
	},
}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteLocale: () => {}}));
vi.mock('@app/features/i18n/locales/en-US/messages.mjs', () => ({messages: {}}));
vi.mock('@app/features/i18n/locales/de/messages.mjs', () => ({messages: {}}));
vi.mock('@app/features/i18n/locales/en-GB/messages.mjs', () => ({messages: {}}));
vi.mock('@app/features/i18n/locales/fr/messages.mjs', () => ({messages: {}}));
vi.mock('@app/features/i18n/locales/ru/messages.mjs', () => ({messages: {}}));
vi.mock('@app/features/i18n/locales/tr/messages.mjs', () => ({messages: {}}));

// captured once, before any spy. vitest 5 hands back the existing spy when a spied method is spied again, so
// capturing inside openedLocale would capture the spy itself and recurse on the second call.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

interface InstanceSetting {
	defaultLocale?: string | null;
	defaultLocaleTimeZones?: Array<string>;
}

// The setting arrives as app_public.localization in the boot script's discovery document; an instance whose server
// predates the field sends app_public without it.
function bootWindow(setting: InstanceSetting | null): Record<string, unknown> {
	if (setting === null) {
		return {};
	}
	const hasLocalization = 'defaultLocale' in setting || 'defaultLocaleTimeZones' in setting;
	const localization = {
		default_locale: setting.defaultLocale ?? null,
		default_locale_time_zones: setting.defaultLocaleTimeZones ?? [],
	};
	return {
		__FLUXER_BOOTSTRAP__: {
			config: {releaseChannel: 'stable', bootstrapApiEndpoint: '/api'},
			instance: {app_public: hasLocalization ? {localization} : {}},
		},
	};
}

const MICUP: InstanceSetting = {defaultLocale: 'tr', defaultLocaleTimeZones: ['Europe/Istanbul', 'Asia/Istanbul']};

interface Visit {
	/** The instance default locale setting; null means no boot script at all. */
	setting: InstanceSetting | null;
	timeZone: string | undefined;
	languages: Array<string>;
	savedLocale?: string;
}

async function openedLocale({setting, timeZone, languages, savedLocale}: Visit): Promise<string> {
	vi.resetModules();
	storage.clear();
	if (savedLocale) {
		storage.set('locale', savedLocale);
	}
	vi.stubGlobal('window', bootWindow(setting));
	vi.stubGlobal('navigator', {languages, language: languages[0], userAgent: 'vitest'});
	vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
		return {...realResolvedOptions.call(this), timeZone} as Intl.ResolvedDateTimeFormatOptions;
	});
	const {applyInstanceDefaultLocale, initI18n} = await import('@app/app/I18n');
	await applyInstanceDefaultLocale(
		setting === null
			? undefined
			: {
					default_locale: setting.defaultLocale ?? null,
					default_locale_time_zones: setting.defaultLocaleTimeZones ?? [],
				},
	);
	return (await initI18n()).locale;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('instance default locale', () => {
	it.each([
		{timeZone: 'Europe/Istanbul', languages: ['en-US']},
		{timeZone: 'Europe/Istanbul', languages: ['de-DE', 'de']},
		{timeZone: 'Asia/Istanbul', languages: ['en-GB']},
	])(
		'opens in the instance locale in $timeZone whatever the browser says ($languages)',
		async ({timeZone, languages}) => {
			expect(await openedLocale({setting: MICUP, timeZone, languages})).toBe('tr');
		},
	);

	it.each([
		{timeZone: 'Europe/Berlin', languages: ['de-DE'], expected: 'de'},
		{timeZone: 'America/New_York', languages: ['en-US'], expected: 'en-US'},
		{timeZone: 'Asia/Baku', languages: ['az-AZ', 'ru-RU'], expected: 'ru'},
	])(
		'in $timeZone opens in the first supported browser language of $languages',
		async ({timeZone, languages, expected}) => {
			expect(await openedLocale({setting: MICUP, timeZone, languages})).toBe(expected);
		},
	);

	it('falls back to the instance locale when no browser language is supported', async () => {
		expect(await openedLocale({setting: MICUP, timeZone: 'Asia/Baku', languages: ['az-AZ', 'ku']})).toBe('tr');
	});

	it.each(['en-US', 'de'])('never overrides the saved locale %s', async (savedLocale) => {
		expect(await openedLocale({setting: MICUP, timeZone: 'Europe/Istanbul', languages: ['tr-TR'], savedLocale})).toBe(
			savedLocale,
		);
	});

	it('accepts a regional spelling of a shipped locale', async () => {
		const setting = {...MICUP, defaultLocale: 'tr-TR'};
		expect(await openedLocale({setting, timeZone: 'Europe/Istanbul', languages: ['en-US']})).toBe('tr');
	});

	it.each(['xx', 'turkish', '</script><script>alert(1)</script>'])(
		'ignores the instance locale %s the client does not ship and detects as upstream does',
		async (defaultLocale) => {
			const setting = {...MICUP, defaultLocale};
			expect(await openedLocale({setting, timeZone: 'Europe/Istanbul', languages: ['az-AZ', 'ru-RU']})).toBe('en-US');
		},
	);

	it('without time zones the instance locale only replaces the English fallback', async () => {
		const setting = {defaultLocale: 'tr'};
		expect(await openedLocale({setting, timeZone: 'Europe/Istanbul', languages: ['en-US']})).toBe('en-US');
		expect(await openedLocale({setting, timeZone: 'Europe/Istanbul', languages: ['az-AZ']})).toBe('tr');
	});

	it.each([undefined, 'UTC'])(
		'a browser that reports the time zone %s gets the browser language path',
		async (timeZone) => {
			expect(await openedLocale({setting: MICUP, timeZone, languages: ['en-US']})).toBe('en-US');
		},
	);
});

describe('without the instance default the detection is upstream (K3)', () => {
	const visits = [
		{label: 'a Turkish browser in Istanbul', timeZone: 'Europe/Istanbul', languages: ['tr-TR', 'tr'], expected: 'tr'},
		{label: 'an English browser in Istanbul', timeZone: 'Europe/Istanbul', languages: ['en-US'], expected: 'en-US'},
		{label: 'a German browser in Berlin', timeZone: 'Europe/Berlin', languages: ['de-DE'], expected: 'de'},
		{label: 'an unsupported first language', timeZone: 'Asia/Baku', languages: ['az-AZ', 'ru-RU'], expected: 'en-US'},
		{label: 'a saved locale', timeZone: 'Europe/Istanbul', languages: ['tr-TR'], savedLocale: 'fr', expected: 'fr'},
	];
	it.each(visits)('$label, with no instance setting', async ({expected, label: _label, ...visit}) => {
		expect(await openedLocale({...visit, setting: {}})).toBe(expected);
	});
	it.each(visits)('$label, with an empty instance setting', async ({expected, label: _label, ...visit}) => {
		expect(await openedLocale({...visit, setting: {defaultLocale: null, defaultLocaleTimeZones: []}})).toBe(expected);
	});
	it.each(visits)('$label, with no boot script at all', async ({expected, label: _label, ...visit}) => {
		expect(await openedLocale({...visit, setting: null})).toBe(expected);
	});
	it.each(visits)('$label, with time zones but no default locale', async ({expected, label: _label, ...visit}) => {
		expect(await openedLocale({...visit, setting: {defaultLocaleTimeZones: ['Europe/Istanbul']}})).toBe(expected);
	});
});

describe('runtime locale policy after early shell initialization', () => {
	it('applies the instance locale when the device had no saved choice', async () => {
		expect(await openedLocale({setting: null, timeZone: 'Europe/Istanbul', languages: ['en-US']})).toBe('en-US');
		const {applyInstanceDefaultLocale, default: i18n} = await import('@app/app/I18n');
		await applyInstanceDefaultLocale({default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']});
		expect(i18n.locale).toBe('tr');
	});
	it('preserves a saved choice when instance discovery arrives', async () => {
		expect(
			await openedLocale({setting: null, timeZone: 'Europe/Istanbul', languages: ['en-US'], savedLocale: 'fr'}),
		).toBe('fr');
		const {applyInstanceDefaultLocale, default: i18n} = await import('@app/app/I18n');
		await applyInstanceDefaultLocale({default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']});
		expect(i18n.locale).toBe('fr');
	});
});
