// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRequire} from 'node:module';
import log from 'electron-log';

const requireModule = createRequire(import.meta.url);
interface WinShellState {
	cachedBinding: typeof import('@fluxer/win-shell') | null | undefined;
	warned: boolean;
	invalidatePreflightMarker?: () => void;
}

// Separate entry bundles must share capability and warning state in this process.
const stateKey = Symbol.for('fluxer.win-shell.state');
const runtime = process as typeof process & {[stateKey]?: WinShellState};
const state = (runtime[stateKey] ??= {cachedBinding: undefined, warned: false});

export function registerWinShellPreflightInvalidator(invalidate: () => void): void {
	state.invalidatePreflightMarker = invalidate;
	if (isWinShellDisabled()) invalidate();
}

export function isWinShellDisabled(): boolean {
	return state.cachedBinding === null;
}

export function disableWinShell(
	reason: 'require-failed' | 'load-error' | 'preflight-failed' | 'preflight-inconclusive',
): void {
	state.cachedBinding = null;
	state.invalidatePreflightMarker?.();
	if (state.warned) return;
	state.warned = true;
	log.warn('[WinShell] @fluxer/win-shell unavailable:', reason);
}

export function loadWinShell(): typeof import('@fluxer/win-shell') | null {
	if (process.platform !== 'win32') return null;
	if (state.cachedBinding !== undefined) return state.cachedBinding;
	try {
		const binding = requireModule('@fluxer/win-shell') as typeof import('@fluxer/win-shell');
		if (binding.loadError) {
			disableWinShell('load-error');
		} else {
			state.cachedBinding = binding;
		}
	} catch {
		disableWinShell('require-failed');
	}
	return state.cachedBinding ?? null;
}
