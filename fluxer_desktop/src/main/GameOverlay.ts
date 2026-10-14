// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DesktopGameOverlayLayout} from '@electron/common/Types';
import {computeGameOverlayBounds, normalizeGameOverlayLayout} from '@electron/main/GameOverlayLayout';
import {isLocalAppRendererDocumentURL} from '@electron/main/LocalAppURL';
import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';
import {type BrowserWindow, ipcMain, screen} from 'electron';

export const GAME_OVERLAY_WINDOW_NAME = 'fluxer-game-overlay';
const GAME_OVERLAY_SET_LAYOUT_CHANNEL = 'game-overlay:set-layout';
const GAME_OVERLAY_LAYOUT_COALESCE_MS = 150;

let overlayWindow: BrowserWindow | null = null;
let overlayOpener: Electron.WebContents | null = null;
let latestLayout: DesktopGameOverlayLayout | null = null;
let applyTimer: NodeJS.Timeout | null = null;

export function getGameOverlayWindowOptions(): Electron.BrowserWindowConstructorOptions {
	return {
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		focusable: false,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		hasShadow: false,
		show: false,
	};
}

function applyGameOverlayLayout(): void {
	const window = overlayWindow;
	const layout = latestLayout;
	if (!window || window.isDestroyed() || !layout) {
		return;
	}
	if (!layout.visible) {
		window.hide();
		return;
	}
	window.setBounds(computeGameOverlayBounds(screen.getPrimaryDisplay().bounds, layout));
	window.setAlwaysOnTop(true, 'screen-saver');
	if (!window.isVisible()) {
		window.showInactive();
	}
}

export function attachGameOverlayWindow(window: BrowserWindow, opener: Electron.WebContents): void {
	if (opener.isDestroyed() || !isLocalAppRendererDocumentURL(opener.getURL())) {
		window.destroy();
		return;
	}
	if (overlayWindow && overlayWindow !== window && !overlayWindow.isDestroyed()) {
		overlayWindow.destroy();
	}
	overlayWindow = window;
	overlayOpener = opener;
	window.setIgnoreMouseEvents(true);
	window.setContentProtection(true);
	window.setAlwaysOnTop(true, 'screen-saver');
	window.webContents.on('will-navigate', (event) => {
		event.preventDefault();
	});
	window.webContents.on('will-frame-navigate', (event) => {
		event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));

	const destroyOverlay = (): void => {
		if (!window.isDestroyed()) {
			window.destroy();
		}
	};
	opener.once('destroyed', destroyOverlay);
	opener.on('did-navigate', destroyOverlay);
	opener.on('render-process-gone', destroyOverlay);
	window.webContents.on('render-process-gone', destroyOverlay);
	screen.on('display-metrics-changed', applyGameOverlayLayout);
	screen.on('display-added', applyGameOverlayLayout);
	screen.on('display-removed', applyGameOverlayLayout);
	window.once('closed', () => {
		screen.removeListener('display-metrics-changed', applyGameOverlayLayout);
		screen.removeListener('display-added', applyGameOverlayLayout);
		screen.removeListener('display-removed', applyGameOverlayLayout);
		if (!opener.isDestroyed()) {
			opener.removeListener('destroyed', destroyOverlay);
			opener.removeListener('did-navigate', destroyOverlay);
			opener.removeListener('render-process-gone', destroyOverlay);
		}
		if (overlayWindow === window) {
			overlayWindow = null;
			overlayOpener = null;
			latestLayout = null;
			if (applyTimer !== null) {
				clearTimeout(applyTimer);
				applyTimer = null;
			}
		}
	});
	applyGameOverlayLayout();
}

export function registerGameOverlayIpcHandlers(): void {
	if (process.platform !== 'win32') return;
	ipcMain.on(GAME_OVERLAY_SET_LAYOUT_CHANNEL, (event, raw: unknown): void => {
		try {
			requirePrivilegedRendererDocumentSender(event, GAME_OVERLAY_SET_LAYOUT_CHANNEL);
		} catch {
			return;
		}
		if (event.sender !== overlayOpener || event.senderFrame !== overlayOpener?.mainFrame) {
			return;
		}
		const layout = normalizeGameOverlayLayout(raw);
		if (!layout) {
			return;
		}
		latestLayout = layout;
		if (applyTimer === null) {
			applyTimer = setTimeout(() => {
				applyTimer = null;
				applyGameOverlayLayout();
			}, GAME_OVERLAY_LAYOUT_COALESCE_MS);
		}
	});
}
