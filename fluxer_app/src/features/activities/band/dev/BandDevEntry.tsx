// SPDX-License-Identifier: AGPL-3.0-or-later

// Entry of the local band harness (rspack.band-dev.config.mjs). Only what the game's components lean on is set up:
// the app's global and theme CSS and fonts, signed-out app storage (persisted band settings), an instance runtime
// whose endpoints all point back at this page (the user store needs one to build users), Turkish messages and the
// icon context. No API, gateway, LiveKit or router. The game's song library is pointed at the local song server.

import '@app/app/AbortSignalPolyfill';
import '@fluxer/fonts/css/fluxer-sans.css';
import '@fluxer/fonts/css/fluxer-mono.css';
import '@fluxer/fonts/css/variables.css';
import '@fluxer/fonts/css/locale-fallbacks.css';
import '@app/app/font-fallback.css';
import '@app/app/fonts/fallback/fallback-faces.css';
import '@app/app/globals.css';
import '@app/features/theme/styles/generated/color-system.css';
import '@app/features/theme/styles/preflight.css';
import {BandDevApp} from '@app/features/activities/band/dev/BandDevApp';
import {BandDevHarness} from '@app/features/activities/band/dev/BandDevHarness';
import {songServerUrlFromLocation} from '@app/features/activities/band/dev/BandDevSongs';
import {setBandSongLibraryBaseUrl} from '@app/features/activities/band/flow/BandSongLibrary';
import {runtimeSnapshotFromDiscovery} from '@app/features/app/state/InstanceSnapshotStore';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {AppI18nProvider} from '@app/features/i18n/components/AppI18nProvider';
import {messages} from '@app/features/i18n/locales/tr/messages.mjs';
import {instanceDiscoveryFixture} from '@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture';
import {activateAppStorageScope, initializeAppStorage} from '@app/features/platform/state/PersistentStorage';
import {parseInstanceDiscoveryDocument} from '@fluxer/instance_bootstrap/src/Discovery';
import {i18n} from '@lingui/core';
import {IconContext} from '@phosphor-icons/react';
import {configure} from 'mobx';
import ReactDOM from 'react-dom/client';

configure({enforceActions: 'observed'});

// Every endpoint is this page's own origin, so nothing the components touch can reach a real instance.
function installOfflineRuntime(): void {
	const origin = window.location.origin;
	const discovery = instanceDiscoveryFixture(`${origin}/api`);
	const endpoints = Object.fromEntries(
		Object.keys(discovery.endpoints).map((name) => [name, origin]),
	) as typeof discovery.endpoints;
	endpoints.gateway = origin.replace(/^http/, 'ws');
	endpoints.api = endpoints.api_client = endpoints.api_public = `${origin}/api`;
	RuntimeConfig.applySnapshot(runtimeSnapshotFromDiscovery(parseInstanceDiscoveryDocument({...discovery, endpoints})));
}

async function start(): Promise<void> {
	await initializeAppStorage();
	await activateAppStorageScope(null);
	installOfflineRuntime();
	i18n.load('tr', messages);
	i18n.activate('tr');

	const container = document.getElementById('root');
	if (!container) throw new Error('Missing #root element');
	const songServerUrl = songServerUrlFromLocation(window.location);
	setBandSongLibraryBaseUrl(songServerUrl);
	const harness = new BandDevHarness(songServerUrl);
	Object.assign(window, {bandDev: harness});
	ReactDOM.createRoot(container).render(
		<AppI18nProvider i18n={i18n}>
			<IconContext.Provider value={{color: 'currentColor', weight: 'fill'}}>
				<BandDevApp harness={harness} data-flx="activities.band.dev.band-dev-entry.start.band-dev-app" />
			</IconContext.Provider>
		</AppI18nProvider>,
	);
}

void start();
