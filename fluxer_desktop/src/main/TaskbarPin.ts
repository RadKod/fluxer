// SPDX-License-Identifier: AGPL-3.0-or-later

import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';
import {loadWinShell} from '@electron/main/WinShell';
import {type BrowserWindow, type IpcMainInvokeEvent, ipcMain} from 'electron';

export function registerTaskbarPinIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
	if (process.platform !== 'win32') return;
	let requested = false;
	const requireMainWindow = (event: IpcMainInvokeEvent, channel: string): BrowserWindow => {
		requirePrivilegedRendererDocumentSender(event, channel);
		const window = getMainWindow();
		if (!window || window.isDestroyed() || event.sender !== window.webContents) {
			throw new Error(`${channel} requires the main window`);
		}
		return window;
	};
	ipcMain.handle('taskbar-pin:get-state', (event) => {
		requireMainWindow(event, 'taskbar-pin:get-state');
		return loadWinShell()?.getTaskbarPinState() ?? {supported: false, pinned: false, lafRequired: false};
	});
	ipcMain.handle('taskbar-pin:request', async (event): Promise<boolean> => {
		const window = requireMainWindow(event, 'taskbar-pin:request');
		if (!window.isFocused() || window.isMinimized()) {
			throw new Error('Taskbar pinning requires the foreground main window');
		}
		const binding = loadWinShell();
		if (!binding) return false;
		if (requested) throw new Error('Taskbar pin already requested this session');
		requested = true;
		// Native starts WinRT on this UI thread, rechecks LAF/foreground, then waits off-thread.
		try {
			return await binding.requestTaskbarPin(window.getNativeWindowHandle());
		} catch (error) {
			requested = false;
			throw error;
		}
	});
}
