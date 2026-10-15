// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

// Keep one guild's metadata, including legacy overflow, without retaining every guild visited.
const MAX_METADATA = 256;
const MAX_VERSIONS = 512;
const LOAD_RETRY_DELAY_MS = 30000;

export interface SoundboardLibraryUpdatePayload {
	guild_id: string;
	operation: 'create' | 'update' | 'delete';
	sound_id: string;
	version: number;
	sound?: GuildSoundboardSoundResponse;
}

type FetchSounds = (guildId: string, signal: AbortSignal) => Promise<Array<GuildSoundboardSoundResponse>>;

async function fetchSounds(guildId: string, signal: AbortSignal): Promise<Array<GuildSoundboardSoundResponse>> {
	const response = await http.get<{sounds: Array<GuildSoundboardSoundResponse>}>(
		Endpoints.SOUNDBOARD_GUILD_LIST(guildId),
		{
			signal,
		},
	);
	return response.body.sounds;
}

export class SoundboardLibrary {
	guildId: string | null = null;
	sounds: Array<GuildSoundboardSoundResponse> = [];
	loading = false;
	loaded = false;
	error: Error | null = null;
	private generation = 0;
	private controller: AbortController | null = null;
	private loadPromise: Promise<void> | null = null;
	private versions = new Map<string, number>();
	private retryAfter = 0;

	constructor(private readonly fetch: FetchSounds = fetchSounds) {
		makeAutoObservable<this, 'fetch' | 'controller' | 'loadPromise' | 'versions' | 'generation' | 'retryAfter'>(
			this,
			{
				fetch: false,
				controller: false,
				loadPromise: false,
				versions: false,
				generation: false,
				retryAfter: false,
			},
			{autoBind: true},
		);
	}

	load(guildId: string, force = false): Promise<void> {
		if (this.guildId !== guildId) {
			this.reset();
			this.guildId = guildId;
		}
		if (this.loadPromise) return this.loadPromise;
		if (this.loaded && !force) return Promise.resolve();
		if (!force && performance.now() < this.retryAfter) return Promise.resolve();
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		this.loading = true;
		this.error = null;
		const initialVersions = new Map(this.versions);
		const request = this.fetch(guildId, controller.signal)
			.then((sounds) => {
				if (generation !== this.generation) return;
				runInAction(() => {
					const listed = new Set(sounds.slice(0, MAX_METADATA).map((sound) => sound.id));
					this.sounds = this.sounds.filter(
						(sound) => listed.has(sound.id) || sound.version > (initialVersions.get(sound.id) ?? 0),
					);
					for (const sound of sounds) this.acceptSound(sound);
					this.loaded = true;
					this.retryAfter = 0;
				});
			})
			.catch((error: unknown) => {
				if (generation !== this.generation || controller.signal.aborted) return;
				runInAction(() => {
					this.error = error instanceof Error ? error : new Error('Failed to load soundboard');
					this.retryAfter = performance.now() + LOAD_RETRY_DELAY_MS;
				});
			})
			.finally(() => {
				if (generation !== this.generation) return;
				runInAction(() => {
					this.loading = false;
					this.controller = null;
					this.loadPromise = null;
				});
			});
		this.loadPromise = request;
		return request;
	}

	applyUpdate(data: SoundboardLibraryUpdatePayload): void {
		if (data.guild_id !== this.guildId || (!this.loaded && !this.loading)) return;
		if (!Number.isSafeInteger(data.version) || data.version < 1) return;
		if (data.version <= (this.versions.get(data.sound_id) ?? 0)) return;
		if (!this.versions.has(data.sound_id) && this.versions.size >= MAX_VERSIONS) {
			this.reset();
			return;
		}
		if (data.operation === 'delete') {
			this.versions.set(data.sound_id, data.version);
			this.sounds = this.sounds.filter((sound) => sound.id !== data.sound_id);
		} else if (data.sound?.id === data.sound_id && data.sound.version === data.version) {
			this.acceptSound(data.sound);
		}
	}

	getSound(soundId: string): GuildSoundboardSoundResponse | null {
		return this.sounds.find((sound) => sound.id === soundId) ?? null;
	}

	get generationToken(): number {
		return this.generation;
	}

	reset(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = null;
		this.loadPromise = null;
		this.guildId = null;
		this.sounds = [];
		this.versions.clear();
		this.loading = false;
		this.loaded = false;
		this.error = null;
		this.retryAfter = 0;
	}

	dispose(): void {
		this.reset();
	}

	private acceptSound(sound: GuildSoundboardSoundResponse): void {
		if (sound.guild_id !== this.guildId || !Number.isSafeInteger(sound.version) || sound.version < 1) return;
		if (sound.version <= (this.versions.get(sound.id) ?? 0)) return;
		const index = this.sounds.findIndex((entry) => entry.id === sound.id);
		if (index === -1 && (this.sounds.length >= MAX_METADATA || this.versions.size >= MAX_VERSIONS)) return;
		this.versions.set(sound.id, sound.version);
		if (index === -1) this.sounds.push(sound);
		else this.sounds[index] = sound;
	}
}

export default new SoundboardLibrary();
