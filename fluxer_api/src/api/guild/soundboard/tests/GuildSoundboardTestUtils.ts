// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createGuildSoundID, createUserID} from '@app/api/BrandedTypes';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import {GuildSoundboardService} from '@app/api/guild/soundboard/GuildSoundboardService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {GuildSound} from '@app/api/models/GuildSound';
import {vi} from 'vitest';

export const USER_ID = createUserID(101n);
export const GUILD_ID = createGuildID(201n);
export const CHANNEL_ID = createChannelID(301n);
export const SOUND_ID = createGuildSoundID(401n);
export const actor = {userId: USER_ID, guildId: GUILD_ID};
export const upload = {...actor, name: 'Test sound', audio: Buffer.from('sound').toString('base64')};
export const play = {
	userId: USER_ID,
	channelId: CHANNEL_ID,
	soundId: SOUND_ID,
	sessionId: 'session',
	connectionId: 'connection',
};

export function savedSound(overrides: Partial<ConstructorParameters<typeof GuildSound>[0]> = {}) {
	return new GuildSound({
		guild_id: GUILD_ID,
		sound_id: SOUND_ID,
		creator_id: USER_ID,
		name: 'Test sound',
		asset_hash: 'a'.repeat(64),
		extension: 'mp3',
		size_bytes: 5,
		duration_ms: 1000,
		volume: 0.5,
		created_at: new Date(),
		version: 1,
		...overrides,
	});
}

export function fixture(repository = new GuildSoundboardRepository()) {
	const storage = {uploadObject: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined)};
	const media = {getMetadata: vi.fn(async () => ({format: 'mp3', duration: 1, content_type: 'audio/mpeg'}))};
	const gateway = {
		getGuildData: vi.fn(async () => ({features: []})),
		checkPermission: vi.fn(async (_params: {permission: bigint}) => true),
		dispatchGuild: vi.fn(async () => undefined),
		playGuildSoundboardSound: vi.fn(
			async (_params: unknown): Promise<{success: boolean; error?: string}> => ({success: true}),
		),
	};
	const service = new GuildSoundboardService(
		repository,
		storage as unknown as IStorageService,
		media as unknown as IMediaService,
		{getConfigSnapshot: () => createDefaultLimitConfig({selfHosted: false})},
		gateway as unknown as IGatewayService,
	);
	return {repository, storage, media, gateway, service};
}
