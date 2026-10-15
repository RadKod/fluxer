// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {makeAutoObservable} from 'mobx';

export class SoundboardSettings {
	accountId: string | null = null;
	disabled = false;
	volume = 1;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	setAccount(accountId: string | null): void {
		if (accountId === this.accountId) return;
		this.accountId = accountId;
		this.disabled = false;
		this.volume = 1;
		if (!accountId) return;
		const stored = AppStorage.getJSON<{disabled?: unknown; volume?: unknown}>(this.storageKey);
		this.disabled = stored?.disabled === true;
		if (typeof stored?.volume === 'number' && Number.isFinite(stored.volume)) {
			this.volume = Math.max(0, Math.min(1, stored.volume));
		}
	}

	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
		this.persist();
	}

	setVolume(volume: number): void {
		if (!Number.isFinite(volume)) return;
		this.volume = Math.max(0, Math.min(1, volume));
	}

	commitVolume(volume: number): void {
		if (!Number.isFinite(volume)) return;
		this.setVolume(volume);
		this.persist();
	}

	reset(): void {
		this.setAccount(null);
	}

	dispose(): void {
		this.reset();
	}

	private get storageKey(): string {
		return `SoundboardSettings:${this.accountId}`;
	}

	private persist(): void {
		if (!this.accountId) return;
		AppStorage.setJSON(this.storageKey, {disabled: this.disabled, volume: this.volume});
	}
}

export default new SoundboardSettings();
