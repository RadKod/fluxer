// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {installElectronStub} from './LocalAppTestSupport.test.mjs';

installElectronStub();
const {desktopRuntimeInitialInput, runtimePlanFromServedDiscovery} = await import(
	'@electron/main/DesktopRuntimeDiscovery'
);
const {BUILD_CHANNEL} = await import('@electron/common/BuildChannel');
const {CHANNEL_APP_URLS} = await import('@electron/common/Constants');
const {DEPLOYED_OFFICIAL_DOCUMENT} = await import('@fluxer/instance_bootstrap/src/__tests__/DiscoveryFixtures');

test('a sessionless bundled renderer starts discovery at the configured Micup channel API', () => {
	assert.equal(desktopRuntimeInitialInput(), `${CHANNEL_APP_URLS[BUILD_CHANNEL]}/api`);
});

test('a development launch endpoint remains an explicit override of the channel API', () => {
	const originalArgv = process.argv;
	const originalDefaultApp = process.defaultApp;
	try {
		process.argv = ['electron', '--fluxer-instance=https://self.example/api/'];
		process.defaultApp = true;
		assert.equal(desktopRuntimeInitialInput(), 'https://self.example/api');
		process.defaultApp = false;
		assert.throws(desktopRuntimeInitialInput, /only accepted in a development build/);
	} finally {
		process.argv = originalArgv;
		process.defaultApp = originalDefaultApp;
	}
});

describe('runtime plans from a served discovery document', () => {
	test('a document served by its own API origin builds a plan keyed on that origin', () => {
		const built = runtimePlanFromServedDiscovery(
			'https://api.fluxer.app/.well-known/fluxer',
			DEPLOYED_OFFICIAL_DOCUMENT,
		);
		assert.equal(built.instanceKey, 'https://api.fluxer.app');
		assert.equal(built.document, DEPLOYED_OFFICIAL_DOCUMENT);
	});

	test('a document that claims another instance API is refused before a plan exists', () => {
		const spoofed = {
			...DEPLOYED_OFFICIAL_DOCUMENT,
			endpoints: {
				...DEPLOYED_OFFICIAL_DOCUMENT.endpoints,
				gateway: 'wss://gw.evil.example',
				media: 'https://evil.example',
				webapp: 'https://evil.example',
				upload_relay: 'https://evil.example/upload',
			},
		};
		assert.throws(() => runtimePlanFromServedDiscovery('https://evil.example/.well-known/fluxer', spoofed), {
			name: 'InstanceDiscoveryOriginMismatchError',
		});
	});

	test('an api_client on another origin is refused even when api matches', () => {
		const spoofed = {
			...DEPLOYED_OFFICIAL_DOCUMENT,
			endpoints: {
				...DEPLOYED_OFFICIAL_DOCUMENT.endpoints,
				api: 'https://evil.example',
				api_client: 'https://api.fluxer.app',
			},
		};
		assert.throws(() => runtimePlanFromServedDiscovery('https://evil.example/.well-known/fluxer', spoofed), {
			name: 'InstanceDiscoveryOriginMismatchError',
		});
	});
});
