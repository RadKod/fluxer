// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';

const electronApi = {
	platform: 'darwin',
	getScreenRecordingPermissionStatus: vi.fn(),
	checkMediaAccess: vi.fn(),
};

vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => electronApi,
	isNativeMacOS: () => true,
}));
vi.mock('@app/features/permissions/system/state/MacPermissions', () => ({
	default: {refreshKind: vi.fn(), request: vi.fn(), openSettings: vi.fn()},
}));
vi.mock('@app/features/permissions/system/state/MediaPermission', () => ({
	default: {updateScreenRecordingPermissionGranted: vi.fn(), markScreenRecordingExplicitlyDenied: vi.fn()},
}));

const {
	createScreenSharePickerDisplayPermissionSnapshot,
	selectScreenSharePickerDisplayPermissionPrompt,
	transitionScreenSharePickerDisplayPermissionSnapshot,
} = await import(
	'@app/features/voice/components/modals/screen_share_picker_modal/ScreenSharePickerDisplayPermissionStateMachine'
);
const {readScreenSharePickerScreenRecordingPermission} = await import(
	'@app/features/voice/components/modals/screen_share_picker_modal/useScreenSharePickerDisplayPermission'
);
const {normalizeNativePermissionResult} = await import('@app/features/permissions/system/utils/NativePermissions');

type Snapshot = ReturnType<typeof createScreenSharePickerDisplayPermissionSnapshot>;
type Event = Parameters<typeof transitionScreenSharePickerDisplayPermissionSnapshot>[1];

function run(events: Array<Event>): Snapshot {
	return events.reduce(
		(snapshot, event) => transitionScreenSharePickerDisplayPermissionSnapshot(snapshot, event),
		createScreenSharePickerDisplayPermissionSnapshot(),
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('screen share picker display permission', () => {
	it('blocks the source list and asks for the permission when macOS has not granted it', () => {
		const snapshot = run([{type: 'permission.check'}, {type: 'permission.result', permission: 'denied'}]);
		expect(selectScreenSharePickerDisplayPermissionPrompt(snapshot)).toBe('needs-permission');
	});

	it('asks for a relaunch when macOS holds the grant but this process cannot use it yet', () => {
		const snapshot = run([{type: 'permission.check'}, {type: 'permission.result', permission: 'restart-required'}]);
		expect(selectScreenSharePickerDisplayPermissionPrompt(snapshot)).toBe('restart-required');
	});

	it('moves from the permission prompt to the relaunch prompt on a focus re-check', () => {
		const snapshot = run([
			{type: 'permission.check'},
			{type: 'permission.result', permission: 'not-determined'},
			{type: 'permission.result', permission: 'restart-required'},
		]);
		expect(selectScreenSharePickerDisplayPermissionPrompt(snapshot)).toBe('restart-required');
	});

	it('shows the sources once the permission is usable', () => {
		const snapshot = run([
			{type: 'permission.check'},
			{type: 'permission.result', permission: 'restart-required'},
			{type: 'permission.result', permission: 'granted'},
		]);
		expect(selectScreenSharePickerDisplayPermissionPrompt(snapshot)).toBe('none');
	});

	it('passes the relaunch state from the desktop shell through to the picker', async () => {
		electronApi.getScreenRecordingPermissionStatus.mockResolvedValueOnce('restart-required');
		await expect(readScreenSharePickerScreenRecordingPermission('test')).resolves.toBe('restart-required');
		electronApi.getScreenRecordingPermissionStatus.mockResolvedValueOnce('granted');
		await expect(readScreenSharePickerScreenRecordingPermission('test')).resolves.toBe('granted');
		electronApi.getScreenRecordingPermissionStatus.mockResolvedValueOnce('something-new');
		await expect(readScreenSharePickerScreenRecordingPermission('test')).resolves.toBe('not-determined');
	});

	it('treats the relaunch state as not granted everywhere outside the picker', () => {
		expect(normalizeNativePermissionResult('restart-required')).toBe('denied');
	});
});
