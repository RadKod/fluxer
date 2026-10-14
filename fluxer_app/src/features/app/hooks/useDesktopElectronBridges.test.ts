// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));
vi.mock('react', () => ({useEffect: (effect: () => void) => effect()}));
vi.mock('@app/features/app/state/ClientReadiness', () => ({isClientBooting: () => false}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/platform/utils/DesktopTrayBridge', () => ({initializeDesktopTrayBridge: () => undefined}));
vi.mock('@app/features/theme/state/ThemeLibrary', () => ({
	default: {init: async () => {}, startLinkedFileSync: () => () => {}},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({}));

let zoomReset: (() => void) | undefined;
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => ({
		onZoomReset: (callback: () => void) => {
			zoomReset = callback;
			return () => {};
		},
	}),
}));

const {default: Accessibility} = await import('@app/features/accessibility/state/Accessibility');
const {useDesktopElectronBridges} = await import('@app/features/app/hooks/useDesktopElectronBridges');

describe('desktop menu zoom reset', () => {
	it('resets app zoom to the 95% default', () => {
		useDesktopElectronBridges();
		Accessibility.updateSettings({zoomLevel: 1.25});

		zoomReset?.();

		expect(Accessibility.zoomLevel).toBe(0.95);
	});
});
