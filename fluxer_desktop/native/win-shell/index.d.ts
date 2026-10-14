// SPDX-License-Identifier: AGPL-3.0-or-later

export interface CreateShortcutOptions {
	lnkPath: string;
	target: string;
	args?: string;
	appUserModelId?: string;
	toastActivatorClsid?: string;
	iconPath?: string;
	iconIndex?: number;
	workingDir?: string;
	description?: string;
}

export interface SetRunValueOptions {
	name: string;
	command: string;
}

export interface ProcessInfo {
	exe: string;
	pid: number;
}

export declare function listProcesses(): Promise<Array<ProcessInfo>>;

export declare function createShortcut(opts: CreateShortcutOptions): Promise<void>;

export declare function setCurrentUserRunValue(opts: SetRunValueOptions): Promise<void>;

export declare function deleteCurrentUserRunValue(name: string): Promise<void>;

export declare function getCurrentUserRunValue(name: string): Promise<string | null>;

export type StartupTaskState =
	| 'disabled'
	| 'disabled-by-user'
	| 'enabled'
	| 'disabled-by-policy'
	| 'enabled-by-policy'
	| 'unknown';

export declare function getStartupTaskState(taskId: string): Promise<StartupTaskState>;

export declare function setStartupTaskEnabled(taskId: string, enabled: boolean): Promise<StartupTaskState>;

export declare function getUserNotificationState(): string;

export declare const loadError: Error | null;

export interface TaskbarPinState {
	supported: boolean;
	pinned: boolean;
	lafRequired: boolean;
}

export declare function getTaskbarPinState(): Promise<TaskbarPinState>;

export declare function requestTaskbarPin(hwnd: Buffer): Promise<boolean>;
