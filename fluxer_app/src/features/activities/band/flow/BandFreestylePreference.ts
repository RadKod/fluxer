// SPDX-License-Identifier: AGPL-3.0-or-later

// Whether I play solo sections freestyle, remembered per user on this device and offered again on every song.

export type BandPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const FREESTYLE_STORAGE_PREFIX = 'sanalyer:band-freestyle-solo:';

export const browserFreestyleStorage = (): BandPreferenceStorage => localStorage;

// Storage can be missing or refuse (private mode, full quota); the choice then lasts until the panel closes.
export function readFreestyleSolo(storage: () => BandPreferenceStorage, userId: string): boolean {
	try {
		return storage().getItem(FREESTYLE_STORAGE_PREFIX + userId) === 'on';
	} catch {
		return false;
	}
}

export function writeFreestyleSolo(storage: () => BandPreferenceStorage, userId: string, enabled: boolean): void {
	try {
		storage().setItem(FREESTYLE_STORAGE_PREFIX + userId, enabled ? 'on' : 'off');
	} catch {}
}
