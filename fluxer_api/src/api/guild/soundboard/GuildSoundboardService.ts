// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createGuildSoundID, type GuildID, type GuildSoundID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {resolveGuildSoundboardDurationMs} from '@app/api/guild/soundboard/GuildSoundboardDurationProbe';
import type {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {GuildSound} from '@app/api/models/GuildSound';
import {requirePermission} from '@app/api/utils/PermissionUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	SOUNDBOARD_MAX_DURATION_MS,
	SOUNDBOARD_MAX_SIZE_BYTES,
	SOUNDBOARD_SOUND_PATH_PREFIX,
} from '@fluxer/constants/src/SoundboardConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {isValidBase64} from '@fluxer/schema/src/primitives/FileValidators';
import {generateSnowflake} from '@fluxer/snowflake/src/Snowflake';

interface GuildActor {
	userId: UserID;
	guildId: GuildID;
}
interface UploadParams extends GuildActor {
	name: string;
	audio: string;
	volume?: number;
}
interface UpdateParams extends GuildActor {
	soundId: GuildSoundID;
	name?: string;
	volume?: number;
}

// sanalyer: Micup serialises writes per guild resource with a KV lock (guild/capacity); this fork runs one API
// process on Postgres, so the guard is a plain pass-through and the limit check below is best effort.
interface GuildResourceWriteGuardLike {
	withGuildResourceWriteGuard<T>(guildId: GuildID, kind: string, run: () => Promise<T>): Promise<T>;
}
const NO_GUARD: GuildResourceWriteGuardLike = {
	withGuildResourceWriteGuard: (_guildId, _kind, run) => run(),
};

export class GuildSoundboardService {
	constructor(
		private readonly repository: GuildSoundboardRepository,
		private readonly storage: IStorageService,
		private readonly media: IMediaService,
		private readonly limits: Pick<LimitConfigService, 'getConfigSnapshot'>,
		private readonly gateway: IGatewayService,
		private readonly guard: GuildResourceWriteGuardLike = NO_GUARD,
	) {}

	serialize(sound: GuildSound) {
		return {
			id: sound.soundId.toString(),
			guild_id: sound.guildId.toString(),
			creator_id: sound.creatorId.toString(),
			name: sound.name,
			asset_hash: sound.assetHash,
			extension: sound.extension,
			size_bytes: sound.sizeBytes,
			duration_ms: sound.durationMs,
			volume: sound.volume,
			created_at: sound.createdAt.toISOString(),
			version: sound.version,
			url: `${Config.endpoints.media}/${this.keyFor(sound)}`,
		};
	}

	async list(params: GuildActor) {
		await this.gateway.getGuildData(params);
		return (await this.repository.listSounds(params.guildId)).map((sound) => this.serialize(sound));
	}

	async upload(params: UploadParams) {
		await this.gateway.getGuildData(params);
		await this.checkCreate(params);
		const name = this.validateName(params.name);
		const volume = this.validateVolume(params.volume ?? 1);
		const {audio} = params;
		if (audio.length === 0 || audio.length > 4 * Math.ceil(SOUNDBOARD_MAX_SIZE_BYTES / 3) || !isValidBase64(audio)) {
			throw InputValidationError.create('audio', 'Invalid or oversized base64 audio');
		}
		const bytes = Buffer.from(audio, 'base64');
		if (bytes.length === 0 || bytes.length > SOUNDBOARD_MAX_SIZE_BYTES) {
			throw InputValidationError.create('audio', 'Sound must contain at most 1000000 bytes');
		}
		const metadata = await this.media.getMetadata({type: 'base64', base64: audio, version: 2, nsfw: 'allow'});
		const extension = metadata?.format === 'mp3' ? 'mp3' : metadata?.format === 'ogg' ? 'ogg' : null;
		if (!metadata || !extension) throw InputValidationError.create('audio', 'Sound must be MP3 or Ogg audio');
		const durationMs = await resolveGuildSoundboardDurationMs({
			bytes,
			extension,
			metadataDurationSeconds: typeof metadata.duration === 'number' ? metadata.duration : null,
		});
		if (
			durationMs === null ||
			!Number.isFinite(durationMs) ||
			durationMs <= 0 ||
			durationMs > SOUNDBOARD_MAX_DURATION_MS
		) {
			throw InputValidationError.create('audio', 'Sound duration must be greater than zero and at most 10 seconds');
		}
		const sound = new GuildSound({
			guild_id: params.guildId,
			sound_id: createGuildSoundID(generateSnowflake()),
			creator_id: params.userId,
			name,
			asset_hash: createHash('sha256').update(bytes).digest('hex'),
			extension,
			size_bytes: bytes.length,
			duration_ms: Math.ceil(durationMs),
			volume,
			created_at: new Date(),
			version: 1,
		});
		await this.guard.withGuildResourceWriteGuard(params.guildId, 'sound', async () => {
			const guild = await this.gateway.getGuildData(params);
			await this.checkCreate(params);
			const limit = resolveLimitSafe(
				this.limits.getConfigSnapshot(),
				createLimitMatchContext({user: null, guildFeatures: guild.features}),
				'max_guild_soundboard_sounds',
				8,
				'guild',
			);
			const sounds = await this.repository.listSounds(params.guildId, true);
			if (sounds.length >= limit) throw InputValidationError.create('audio', 'The guild soundboard is full');
			await this.storage.uploadObject({
				bucket: Config.s3.buckets.cdn,
				key: this.keyFor(sound),
				body: new Uint8Array(bytes),
				contentType: extension === 'mp3' ? 'audio/mpeg' : 'audio/ogg',
			});
			try {
				await this.repository.upsertSound(sound);
			} catch (error) {
				// A timed-out write can still commit; retain its asset instead of breaking a saved sound.
				Logger.error(
					{error, guildId: params.guildId.toString(), soundId: sound.soundId.toString()},
					'Soundboard persistence failed; asset retained for uncertain write',
				);
				throw error;
			}
		});
		await this.dispatch(sound, 'create');
		return this.serialize(sound);
	}

	async update(params: UpdateParams) {
		await this.getEditable(params);
		const name = params.name === undefined ? undefined : this.validateName(params.name);
		const volume = params.volume === undefined ? undefined : this.validateVolume(params.volume);
		const sound = await this.guard.withGuildResourceWriteGuard(params.guildId, 'sound', async () => {
			const existing = await this.getEditable(params);
			const updated = new GuildSound({
				...existing.toRow(),
				name: name ?? existing.name,
				volume: volume ?? existing.volume,
				version: existing.version + 1,
			});
			await this.repository.upsertSound(updated);
			return updated;
		});
		await this.dispatch(sound, 'update');
		return this.serialize(sound);
	}

	async delete(params: GuildActor & {soundId: GuildSoundID}): Promise<void> {
		await this.getEditable(params);
		const sound = await this.guard.withGuildResourceWriteGuard(params.guildId, 'sound', async () => {
			const existing = await this.getEditable(params);
			await this.repository.deleteSound(params.guildId, params.soundId);
			try {
				const remaining = await this.repository.listSounds(params.guildId, true);
				if (
					!remaining.some((entry) => entry.assetHash === existing.assetHash && entry.extension === existing.extension)
				) {
					await this.storage.deleteObject(Config.s3.buckets.cdn, this.keyFor(existing));
				}
			} catch (error) {
				Logger.error({error, guildId: params.guildId.toString()}, 'Failed to remove unused soundboard asset');
			}
			return existing;
		});
		await this.dispatch(sound, 'delete');
	}

	private async getEditable(params: GuildActor & {soundId: GuildSoundID}): Promise<GuildSound> {
		await this.gateway.getGuildData(params);
		const sound = await this.repository.getSound(params.guildId, params.soundId);
		if (!sound) throw InputValidationError.create('sound_id', 'Unknown guild sound');
		await requirePermission(this.gateway, {
			...params,
			permission: sound.creatorId === params.userId ? Permissions.CREATE_EXPRESSIONS : Permissions.MANAGE_EXPRESSIONS,
		});
		return sound;
	}
	private checkCreate(params: GuildActor): Promise<void> {
		return requirePermission(this.gateway, {...params, permission: Permissions.CREATE_EXPRESSIONS});
	}
	private keyFor(sound: GuildSound): string {
		return `${SOUNDBOARD_SOUND_PATH_PREFIX}/${sound.guildId}/${sound.assetHash}.${sound.extension}`;
	}
	private async dispatch(sound: GuildSound, operation: 'create' | 'update' | 'delete'): Promise<void> {
		try {
			await this.gateway.dispatchGuild({
				guildId: sound.guildId,
				event: 'GUILD_SOUNDBOARD_SOUNDS_UPDATE',
				data: {
					guild_id: sound.guildId.toString(),
					operation,
					sound_id: sound.soundId.toString(),
					version: sound.version + (operation === 'delete' ? 1 : 0),
					...(operation === 'delete' ? {} : {sound: this.serialize(sound)}),
				},
			});
		} catch (error) {
			Logger.error(
				{error, guildId: sound.guildId.toString(), soundId: sound.soundId.toString()},
				'Failed to invalidate guild soundboard metadata',
			);
		}
	}
	private validateName(name: string): string {
		const value = name.trim();
		if (!value || value.length > 32)
			throw InputValidationError.create('name', 'Sound name must contain 1 to 32 characters');
		return value;
	}
	private validateVolume(volume: number): number {
		if (!Number.isFinite(volume) || volume < 0 || volume > 1)
			throw InputValidationError.create('volume', 'Volume must be between zero and one');
		return volume;
	}
}
