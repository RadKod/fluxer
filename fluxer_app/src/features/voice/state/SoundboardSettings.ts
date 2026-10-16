// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {makeAutoObservable} from 'mobx';

// sanalyer: favourites and recently played sounds live next to the listening preferences, per account and device.
// Sound ids are global snowflakes, so favourites need no guild key; the recent row is kept per guild.
const MAX_FAVORITES = 256;
const MAX_RECENT_PER_GUILD = 6;
const MAX_RECENT_GUILDS = 32;
const MAX_ID_LENGTH = 32;

interface StoredSoundboardSettings {
	disabled?: unknown;
	volume?: unknown;
	favorites?: unknown;
	recent?: unknown;
}

function readIds(value: unknown, limit: number): Array<string> {
	if (!Array.isArray(value)) return [];
	const ids: Array<string> = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ID_LENGTH || ids.includes(entry))
			continue;
		ids.push(entry);
		if (ids.length >= limit) break;
	}
	return ids;
}

function readRecent(value: unknown): Record<string, Array<string>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	const recent: Record<string, Array<string>> = {};
	for (const [guildId, ids] of Object.entries(value).slice(0, MAX_RECENT_GUILDS)) {
		if (guildId.length === 0 || guildId.length > MAX_ID_LENGTH) continue;
		const list = readIds(ids, MAX_RECENT_PER_GUILD);
		if (list.length > 0) recent[guildId] = list;
	}
	return recent;
}

export class SoundboardSettings {
	accountId: string | null = null;
	disabled = false;
	volume = 1;
	favorites: Array<string> = [];
	recent: Record<string, Array<string>> = {};

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	setAccount(accountId: string | null): void {
		if (accountId === this.accountId) return;
		this.accountId = accountId;
		this.disabled = false;
		this.volume = 1;
		this.favorites = [];
		this.recent = {};
		if (!accountId) return;
		const stored = AppStorage.getJSON<StoredSoundboardSettings>(this.storageKey);
		this.disabled = stored?.disabled === true;
		if (typeof stored?.volume === 'number' && Number.isFinite(stored.volume)) {
			this.volume = Math.max(0, Math.min(1, stored.volume));
		}
		this.favorites = readIds(stored?.favorites, MAX_FAVORITES);
		this.recent = readRecent(stored?.recent);
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

	isFavorite(soundId: string): boolean {
		return this.favorites.includes(soundId);
	}

	toggleFavorite(soundId: string): void {
		if (soundId.length === 0 || soundId.length > MAX_ID_LENGTH) return;
		if (this.favorites.includes(soundId)) {
			this.favorites = this.favorites.filter((id) => id !== soundId);
		} else {
			// Newest favourite first; the oldest one falls off past the cap.
			this.favorites = [soundId, ...this.favorites].slice(0, MAX_FAVORITES);
		}
		this.persist();
	}

	recentFor(guildId: string): ReadonlyArray<string> {
		return this.recent[guildId] ?? [];
	}

	recordPlay(guildId: string, soundId: string): void {
		if (!guildId || !soundId || guildId.length > MAX_ID_LENGTH || soundId.length > MAX_ID_LENGTH) return;
		const list = [soundId, ...(this.recent[guildId] ?? []).filter((id) => id !== soundId)].slice(
			0,
			MAX_RECENT_PER_GUILD,
		);
		// Re-insert the guild last so the least recently used guild is the one dropped past the cap.
		const {[guildId]: _previous, ...others} = this.recent;
		const guilds = Object.keys(others);
		const kept = guilds.slice(Math.max(0, guilds.length - (MAX_RECENT_GUILDS - 1)));
		const next: Record<string, Array<string>> = {};
		for (const id of kept) next[id] = others[id];
		next[guildId] = list;
		this.recent = next;
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
		AppStorage.setJSON(this.storageKey, {
			disabled: this.disabled,
			volume: this.volume,
			favorites: this.favorites,
			recent: this.recent,
		});
	}
}

export default new SoundboardSettings();
