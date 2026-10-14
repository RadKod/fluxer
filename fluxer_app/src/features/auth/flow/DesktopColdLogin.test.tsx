// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {AuthRuntimeTargetBoundary} from '@app/features/auth/flow/AuthRuntimeTargetBoundary';
import {shouldRenderInstanceStep} from '@app/features/auth/flow/auth_login_core/AuthLoginInstanceStep';
import {useAuthLoginFlow} from '@app/features/auth/flow/auth_login_core/useAuthLoginFlow';
import {useAuthRuntimeTarget} from '@app/features/auth/state/AuthRuntimeTarget';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';

const discovery = vi.hoisted(() => ({resolve: vi.fn()}));
const initialInput = vi.hoisted(() => ({read: vi.fn()}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	isDesktop: () => true,
	getElectronAPI: () => ({capabilities: {appStore: true}, desktopRuntimeConfig: {initialInput: initialInput.read}}),
}));
vi.mock('@app/features/app/state/InstanceSnapshotStore', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	return {...original, default: {resolve: discovery.resolve}};
});
vi.mock('@app/features/auth/flow/AuthShellLoadingState', () => ({AuthShellLoadingState: () => null}));
vi.mock('@app/features/auth/flow/AuthRouteLoadError', () => ({AuthRouteLoadError: () => 'runtime-error'}));
vi.mock('@app/features/auth/flow/AuthInstanceSelectorControl', () => ({AuthInstanceSelectorControl: () => null}));

function LoginDecision() {
	const target = useAuthRuntimeTarget();
	const showInstanceSelector = shouldRenderInstanceStep(null);
	const flow = useAuthLoginFlow({
		startWithAddAccount: false,
		forceCredentials: false,
		desktopHandoff: false,
		hasStoredAccounts: false,
		initialIdentifier: null,
		initialInstanceSelected: target.initialSnapshot != null,
		shouldShowInstanceSelector: showInstanceSelector,
	});
	return (
		<div data-instance={target.snapshot?.apiEndpoint}>
			{showInstanceSelector && !flow.hasCompletedInstanceStep ? 'choose-instance' : 'login-method'}
		</div>
	);
}

it('carries the native cold-start sanalyer target through the auth boundary into the login decision', async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const repo = resolve(process.cwd(), '..');
	const input = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"import {installElectronStub} from './fluxer_desktop/src/main/LocalAppTestSupport.test.mjs'; installElectronStub(); const {desktopRuntimeInitialInput} = await import('./fluxer_desktop/src/main/DesktopRuntimeDiscovery.ts'); const {BUILD_CHANNEL} = await import('./fluxer_desktop/src/common/BuildChannel.ts'); const {CHANNEL_APP_URLS} = await import('./fluxer_desktop/src/common/Constants.ts'); process.stdout.write(JSON.stringify({input: desktopRuntimeInitialInput(), expected: CHANNEL_APP_URLS[BUILD_CHANNEL] + '/api'}));",
		],
		{cwd: repo, encoding: 'utf8'},
	);
	const startup = JSON.parse(input) as {input: string | null; expected: string};
	initialInput.read.mockResolvedValue(startup.input);
	discovery.resolve.mockImplementation(async ({input}: {input: string}) => ({snapshot: {apiEndpoint: input}}));
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(createElement(AuthRuntimeTargetBoundary, null, createElement(LoginDecision))));
		expect(discovery.resolve).toHaveBeenCalledWith({input: startup.expected, signal: expect.any(AbortSignal)});
		expect(container.textContent).toBe('login-method');
		expect(container.firstElementChild?.getAttribute('data-instance')).toBe(startup.expected);
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});
