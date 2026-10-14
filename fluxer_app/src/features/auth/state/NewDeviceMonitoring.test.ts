// SPDX-License-Identifier: AGPL-3.0-or-later

import {expect, it, vi} from 'vitest';

const state = vi.hoisted(() => {
	let markDevicesInUse = () => {};
	const devicesInUse = new Promise<void>((resolve) => {
		markDevicesInUse = resolve;
	});
	return {ensureDevices: vi.fn(async () => ({})), subscribe: vi.fn(() => () => {}), devicesInUse, markDevicesInUse};
});
vi.mock('@lingui/core/macro', () => {
	const descriptor = (value: unknown): unknown => (typeof value === 'string' ? {message: value} : value);
	return {msg: descriptor, t: descriptor, plural: () => '', select: () => '', selectOrdinal: () => ''};
});
vi.mock('@lingui/react/macro', () => ({Trans: () => null}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: vi.fn(), push: vi.fn(), pop: vi.fn()}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
vi.mock('@app/features/app/domain_migration/DomainMigrationDeviceRemap', () => ({
	remapMigratedDeviceIds: (ids: Array<string>) => ids,
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {getInputDeviceId: () => 'default', getOutputDeviceId: () => 'default'},
}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {
		ensureDevices: state.ensureDevices,
		subscribe: state.subscribe,
		whenDevicesInUse: () => state.devicesInUse,
	},
}));

it('does not enumerate or watch devices at startup until devices are first used', async () => {
	vi.stubGlobal('window', globalThis);
	const {default: monitoring} = await import('./NewDeviceMonitoring');
	const started = monitoring.start();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(state.ensureDevices).not.toHaveBeenCalled();
	expect(state.subscribe).not.toHaveBeenCalled();
	state.markDevicesInUse();
	await started;
	expect(state.ensureDevices).toHaveBeenCalledExactlyOnceWith({requestPermissions: false});
	expect(state.subscribe).toHaveBeenCalledOnce();
	monitoring.dispose();
});
