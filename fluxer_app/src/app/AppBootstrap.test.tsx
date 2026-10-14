// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AppStorageBootstrapHandle} from '@app/features/platform/state/AppStorageBootstrap';
import {beforeEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	localization: {default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']},
	active: false,
	steps: [] as Array<string>,
	applyLocale: vi.fn(),
	render: vi.fn(),
}));
vi.mock('@app/app/HistoryBootstrap', () => ({bootstrapSyntheticHistory: vi.fn()}));
vi.mock('@app/app/I18n', () => ({
	default: {},
	initI18n: vi.fn(),
	applyInstanceDefaultLocale: state.applyLocale,
}));
vi.mock('@app/features/app/components/AppErrorBoundary', () => ({AppErrorBoundary: () => null}));
vi.mock('@app/features/app/components/ErrorFallback', () => ({ErrorFallback: () => null}));
vi.mock('@app/features/devtools/utils/SelfXssNotice', () => ({installSelfXssNotice: vi.fn()}));
vi.mock('@app/features/i18n/components/AppI18nProvider', () => ({AppI18nProvider: () => null}));
vi.mock('@app/features/i18n/utils/LocaleSwitchWatchdog', () => ({installLocaleSwitchWatchdog: vi.fn()}));
vi.mock('@app/features/i18n/utils/TranslationDomGuard', () => ({installTranslationDomGuard: vi.fn()}));
vi.mock('@app/features/platform/components/router/ScrollRestoration', () => ({installScrollRestoration: vi.fn()}));
vi.mock('@app/features/platform/DesktopLocalAppRuntime', () => ({isDesktopLocalAppDocument: () => false}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		info() {}
		warn() {}
	},
}));
vi.mock('@app/features/platform/utils/ClientInfo', () => ({
	getFormattedClientInfo: async () => '',
	getFormattedClientInfoSync: () => '',
	installFluxerConfigDebugApi: vi.fn(),
	preloadClientInfo: vi.fn(),
}));
vi.mock('@app/features/platform/utils/LazyModuleLoader', () => ({loadLazyModule: (load: () => unknown) => load()}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({scheduleNonLatinScriptFaces: vi.fn()}));
vi.mock('@app/features/voice/diagnostics/VoiceSubscriptionDebugApi', () => ({
	installVoiceSubscriptionDebugApi: vi.fn(),
}));
vi.mock('react-dom/client', () => ({default: {createRoot: () => ({render: state.render})}}));
vi.mock('@app/app/App', () => ({App: () => null}));
vi.mock('@app/app/SetupHttp', () => ({setupHttp: () => state.steps.push('http')}));
vi.mock('@app/features/auth/altcha/CaptchaInterceptor', () => ({default: {setI18n: vi.fn()}}));
vi.mock('@app/features/messaging/utils/markdown/EmojiProviderSetup', () => ({initializeEmojiParser: vi.fn()}));
vi.mock('@app/features/messaging/utils/markdown/parser/MarkdownParserWasm', () => ({
	preloadMarkdownParserWasm: vi.fn(),
}));
vi.mock('@app/features/platform/service_worker/Register', () => ({registerServiceWorker: vi.fn()}));
vi.mock('@app/features/auth/state/Accounts', () => ({
	default: {bootstrap: async () => state.steps.push('accounts'), currentAccount: null, currentUserId: null},
}));
vi.mock('@app/features/channel/state/ChannelDisplayName', () => ({default: {setI18n: vi.fn()}}));
vi.mock('@app/features/channel/state/ChannelFrecency', () => ({}));
vi.mock('@app/features/app/state/GeoIP', () => ({}));
vi.mock('@app/features/input/state/InputKeybind', () => ({default: {setI18n: vi.fn()}}));
vi.mock('@app/features/auth/state/NewDeviceMonitoring', () => ({default: {setI18n: vi.fn()}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {setI18n: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {setI18n: vi.fn(), preloadModal: vi.fn()}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => (state.active ? {appPublic: {localization: state.localization}} : null),
		resolveEndpoint: async () => ({snapshot: {appPublic: {localization: state.localization}}}),
		applySnapshot: () => {
			state.active = true;
			state.steps.push('instance');
		},
	},
}));
vi.mock('@app/features/user/state/StatusPage', () => ({default: {checkIncidents: vi.fn(), startPolling: vi.fn()}}));
vi.mock('@app/features/app/domain_migration/DomainMigrationDeviceRemap', () => ({installMigratedDeviceRemap: vi.fn()}));
vi.mock('@app/features/app/domain_migration/DomainMigrationTrigger', () => ({probeSignedOutDeviceEnrollment: vi.fn()}));
vi.mock('@app/features/auth/flow/AuthFirstScreen', () => ({prepareSignedOutFirstScreen: vi.fn()}));

const {runApp} = await import('@app/app/AppBootstrap');

beforeEach(() => {
	state.active = false;
	state.steps.length = 0;
	vi.clearAllMocks();
	state.applyLocale.mockImplementation(async () => state.steps.push('locale'));
	document.body.innerHTML = '<div id="root"></div>';
	window.history.replaceState(null, '', '/login');
});

it('activates the signed-out instance and applies its locale before mounting the login screen', async () => {
	const finalizeAfterSessionResolution = vi.fn(async () => state.steps.push('storage'));
	await runApp({finalizeAfterSessionResolution} as unknown as AppStorageBootstrapHandle);
	expect(finalizeAfterSessionResolution).toHaveBeenCalledWith(null);
	expect(state.applyLocale).toHaveBeenCalledWith(state.localization);
	expect(state.steps).toEqual(['accounts', 'storage', 'instance', 'locale', 'http']);
	expect(state.render).toHaveBeenCalledOnce();
});
