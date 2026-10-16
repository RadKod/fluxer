// SPDX-License-Identifier: AGPL-3.0-or-later

import type {NativePermissionResult} from '@app/features/permissions/system/utils/NativePermissions';
import {assign, initialTransition, type SnapshotFrom, setup, transition} from 'xstate';

interface ScreenSharePickerDisplayPermissionContext {
	settingsOpened: boolean;
}

// 'restart-required': macOS already holds the grant but this app process started before it, so the
// source list stays empty until the app is relaunched.
export type ScreenSharePickerScreenRecordingPermission = NativePermissionResult | 'restart-required';

export type ScreenSharePickerDisplayPermissionEvent =
	| {type: 'permission.check'}
	| {type: 'permission.result'; permission: ScreenSharePickerScreenRecordingPermission}
	| {type: 'permission.settingsOpened'}
	| {type: 'permission.clear'};

export type ScreenSharePickerDisplayPermissionPrompt = 'none' | 'checking' | 'needs-permission' | 'restart-required';

function permissionAllowsDisplaySources(permission: ScreenSharePickerScreenRecordingPermission): boolean {
	return permission === 'granted' || permission === 'unsupported';
}

export function screenRecordingPermissionAllowsPickerSources(
	permission: ScreenSharePickerScreenRecordingPermission,
): boolean {
	return permissionAllowsDisplaySources(permission);
}

const screenSharePickerDisplayPermissionStateMachine = setup({
	types: {} as {
		context: ScreenSharePickerDisplayPermissionContext;
		events: ScreenSharePickerDisplayPermissionEvent;
	},
	guards: {
		permissionAllowsDisplaySources: ({event}) =>
			event.type === 'permission.result' && permissionAllowsDisplaySources(event.permission),
		permissionNeedsRestart: ({event}) => event.type === 'permission.result' && event.permission === 'restart-required',
		settingsAlreadyOpened: ({context}) => context.settingsOpened,
	},
	actions: {
		clear: assign(() => ({
			settingsOpened: false,
		})),
		markSettingsOpened: assign(() => ({
			settingsOpened: true,
		})),
	},
}).createMachine({
	id: 'screenSharePickerDisplayPermission',
	context: () => ({
		settingsOpened: false,
	}),
	initial: 'idle',
	states: {
		idle: {
			on: {
				'permission.check': {target: 'checking'},
				'permission.clear': {actions: 'clear'},
			},
		},
		checking: {
			on: {
				'permission.result': [
					{
						guard: 'permissionAllowsDisplaySources',
						target: 'ready',
					},
					{
						guard: 'permissionNeedsRestart',
						target: 'restartRequired',
					},
					{
						guard: 'settingsAlreadyOpened',
						target: 'restartRequired',
					},
					{target: 'blocked'},
				],
				'permission.clear': {target: 'idle', actions: 'clear'},
			},
		},
		ready: {
			on: {
				'permission.check': {target: 'checking'},
				'permission.settingsOpened': {target: 'restartRequired', actions: 'markSettingsOpened'},
				'permission.clear': {target: 'idle', actions: 'clear'},
			},
		},
		blocked: {
			on: {
				'permission.check': {target: 'checking'},
				'permission.result': [
					{
						guard: 'permissionAllowsDisplaySources',
						target: 'ready',
					},
					{
						guard: 'permissionNeedsRestart',
						target: 'restartRequired',
					},
					{target: 'blocked'},
				],
				'permission.settingsOpened': {target: 'restartRequired', actions: 'markSettingsOpened'},
				'permission.clear': {target: 'idle', actions: 'clear'},
			},
		},
		restartRequired: {
			on: {
				'permission.check': {target: 'checking'},
				'permission.result': [
					{
						guard: 'permissionAllowsDisplaySources',
						target: 'ready',
					},
					{target: 'restartRequired'},
				],
				'permission.settingsOpened': {actions: 'markSettingsOpened'},
				'permission.clear': {target: 'idle', actions: 'clear'},
			},
		},
	},
});

export type ScreenSharePickerDisplayPermissionSnapshot = SnapshotFrom<
	typeof screenSharePickerDisplayPermissionStateMachine
>;

export function createScreenSharePickerDisplayPermissionSnapshot(): ScreenSharePickerDisplayPermissionSnapshot {
	return initialTransition(screenSharePickerDisplayPermissionStateMachine)[0];
}

export function transitionScreenSharePickerDisplayPermissionSnapshot(
	snapshot: ScreenSharePickerDisplayPermissionSnapshot,
	event: ScreenSharePickerDisplayPermissionEvent,
): ScreenSharePickerDisplayPermissionSnapshot {
	return transition(
		screenSharePickerDisplayPermissionStateMachine,
		snapshot,
		event,
	)[0] as ScreenSharePickerDisplayPermissionSnapshot;
}

export function selectScreenSharePickerDisplayPermissionPrompt(
	snapshot: ScreenSharePickerDisplayPermissionSnapshot,
): ScreenSharePickerDisplayPermissionPrompt {
	if (snapshot.matches('checking')) return 'checking';
	if (snapshot.matches('blocked')) return 'needs-permission';
	if (snapshot.matches('restartRequired')) return 'restart-required';
	return 'none';
}
