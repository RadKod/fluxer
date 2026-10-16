// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import {http} from '@app/features/platform/transport/RestTransport';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import SoundboardLibrary from '@app/features/voice/state/SoundboardLibrary';
import type {
	GuildSoundboardSoundResponse,
	GuildSoundboardUpdateRequest,
	GuildSoundboardUploadRequest,
} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';

export async function listSounds(guildId: string): Promise<Array<GuildSoundboardSoundResponse>> {
	const response = await http.get<{sounds: Array<GuildSoundboardSoundResponse>}>(
		Endpoints.SOUNDBOARD_GUILD_LIST(guildId),
	);
	return response.body.sounds;
}

export async function uploadSound(
	guildId: string,
	body: GuildSoundboardUploadRequest,
): Promise<GuildSoundboardSoundResponse> {
	const generation = SoundboardLibrary.generationToken;
	const response = await http.post<GuildSoundboardSoundResponse>(Endpoints.SOUNDBOARD_GUILD_LIST(guildId), {body});
	const sound = response.body;
	if (generation === SoundboardLibrary.generationToken) {
		SoundboardLibrary.applyUpdate({
			guild_id: guildId,
			operation: 'create',
			sound_id: sound.id,
			version: sound.version,
			sound,
		});
	}
	return sound;
}

export async function updateSound(
	guildId: string,
	soundId: string,
	body: GuildSoundboardUpdateRequest,
): Promise<GuildSoundboardSoundResponse> {
	const generation = SoundboardLibrary.generationToken;
	const response = await http.patch<GuildSoundboardSoundResponse>(Endpoints.SOUNDBOARD_GUILD_SOUND(guildId, soundId), {
		body,
	});
	const sound = response.body;
	if (generation === SoundboardLibrary.generationToken) {
		SoundboardLibrary.applyUpdate({
			guild_id: guildId,
			operation: 'update',
			sound_id: sound.id,
			version: sound.version,
			sound,
		});
	}
	return sound;
}

export async function deleteSound(guildId: string, soundId: string): Promise<void> {
	const generation = SoundboardLibrary.generationToken;
	await http.delete(Endpoints.SOUNDBOARD_GUILD_SOUND(guildId, soundId));
	if (generation === SoundboardLibrary.generationToken) {
		SoundboardLibrary.applyUpdate({
			guild_id: guildId,
			operation: 'delete',
			sound_id: soundId,
			version: (SoundboardLibrary.getSound(soundId)?.version ?? 0) + 1,
		});
	}
}

// Resolves false when the request was not sent because the voice session is not ready.
export async function playSound(channelId: string, soundId: string): Promise<boolean> {
	const sessionId = GatewaySessions.foregroundConnection.sessionId;
	const connectionId = MediaEngine.connectionId;
	if (
		!MediaEngine.connected ||
		MediaEngine.reconnecting ||
		MediaEngine.channelId !== channelId ||
		!sessionId ||
		!connectionId
	)
		return false;
	await http.post(Endpoints.SOUNDBOARD_CHANNEL_PLAY(channelId, soundId), {
		body: {session_id: sessionId, connection_id: connectionId},
	});
	return true;
}
