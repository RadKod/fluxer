// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const locales = vi.hoisted(() => ({hydrated: false, saved: 'en-US', onScreen: 'tr'}));
const request = vi.hoisted(() =>
	vi.fn(async (_request: {headers?: Record<string, string>; target?: unknown}) => ({body: {}})),
);
const TARGET = {instanceKey: 'https://micup.test/api', apiEndpoint: 'https://micup.test/api', apiVersion: 1};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({instanceRequest: request}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({default: {getItem: () => null, setItem: () => {}}}));
vi.mock('@app/features/auth/state/Accounts', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/gateway/transport/GatewayConnection', () => ({default: {}}));
vi.mock('@app/features/user/commands/UserSettingsCommands', () => ({}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {getLocale: () => locales.saved, isHydrated: () => locales.hydrated},
}));
vi.mock('@app/app/I18n', () => ({
	default: {
		get locale() {
			return locales.onScreen;
		},
	},
	loadLocaleCatalog: async (locale: string) => locale,
	normalizeLocale: (locale: string) => locale,
}));

const {completeSso, register} = await import('@app/features/auth/commands/AuthenticationCommands');

const REGISTRATION = {
	email: 'ayse@micup.test',
	username: 'ayse',
	global_name: 'Ayşe',
	password: 'a-long-enough-password',
	date_of_birth: '2000-01-01',
	consent: true,
} as unknown as Parameters<typeof register>[0];

function acceptLanguageSent(): string | undefined {
	const [options] = request.mock.calls.at(-1)!;
	return options.headers?.['Accept-Language'];
}

beforeEach(() => {
	request.mockClear();
	locales.hydrated = false;
	locales.saved = 'en-US';
});

describe('auth requests carry the language on screen (K1)', () => {
	it('registers a signed-out visitor in the language the page shows, not the unsaved en-US default', async () => {
		await register(REGISTRATION, {http: TARGET});
		expect(acceptLanguageSent()).toBe('tr');
		expect(request.mock.lastCall?.[0].target).toEqual(TARGET);
	});

	it('completes an SSO sign-up in the language the page shows', async () => {
		await completeSso({code: 'code', state: 'state', target: TARGET});
		expect(acceptLanguageSent()).toBe('tr');
	});

	it('keeps sending the saved language once the account settings are loaded', async () => {
		locales.hydrated = true;
		locales.saved = 'de';
		await register(REGISTRATION, {http: TARGET});
		expect(acceptLanguageSent()).toBe('de');
	});
});
