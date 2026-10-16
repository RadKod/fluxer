// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import Users from '@app/features/user/state/Users';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import SoundboardPlaybackEngine, {
	type SoundboardPlaybackParams,
} from '@app/features/voice/engine/SoundboardPlaybackEngine';
import {getEffectiveAudioState} from '@app/features/voice/engine/VoiceEffectiveAudioState';
import ParticipantVolume from '@app/features/voice/state/ParticipantVolume';
import SoundboardLibrary from '@app/features/voice/state/SoundboardLibrary';
import SoundboardSettings from '@app/features/voice/state/SoundboardSettings';
import {reaction} from 'mobx';

const MAX_EVENT_AGE_MS = 5000;
const MAX_SEEN_EVENTS = 256;
const seenEvents = new Map<string, number>();
let lifecycleGeneration = 0;
let disposeRuntime: (() => void) | null = null;

export interface SoundboardPlayPayload {
	guild_id: string;
	channel_id: string;
	sound_id: string;
	actor_id: string;
	session_id: string;
	event_id: string;
	server_time: number;
	asset_version: string;
	volume: number;
	recipient_connection_id: string;
	recipient_soundboard_epoch: number;
}

export function getSoundboardSessionKey(): string | null {
	const userId = Users.getCurrentUser()?.id;
	const connectionId = MediaEngine.connectionId;
	const sessionId = GatewaySessions.foregroundConnection.sessionId;
	if (
		!MediaEngine.connected ||
		MediaEngine.reconnecting ||
		!userId ||
		!connectionId ||
		!sessionId ||
		!Users.viewAccountKey
	)
		return null;
	const state = MediaEngine.getVoiceStateByConnectionId(connectionId);
	if (!state || state.session_id !== sessionId || state.user_id !== userId) return null;
	return JSON.stringify([
		Users.viewAccountKey,
		sessionId,
		connectionId,
		state.soundboard_epoch ?? 0,
		MediaEngine.guildId,
		MediaEngine.channelId,
	]);
}

export function isSoundboardPlaybackEligible(params: SoundboardPlaybackParams): boolean {
	if (
		!getSoundboardSessionKey() ||
		SoundboardSettings.accountId !== Users.viewAccountKey ||
		SoundboardSettings.disabled ||
		SoundboardSettings.volume <= 0
	)
		return false;
	if (
		MediaEngine.guildId !== params.guildId ||
		MediaEngine.channelId !== params.channelId ||
		MediaEngine.connectionId !== params.recipientConnectionId
	)
		return false;
	const recipient = MediaEngine.getVoiceStateByConnectionId(params.recipientConnectionId);
	if (
		recipient?.channel_id !== params.channelId ||
		(recipient.soundboard_epoch ?? 0) !== params.recipientSoundboardEpoch ||
		recipient.suppress
	)
		return false;
	if (
		// sanalyer: a muted listener still hears sounds (they mix on this client); only deafened drops them.
		getEffectiveAudioState().effectiveDeaf ||
		ParticipantVolume.isLocalMuted(params.actorId)
	)
		return false;
	const actor = Object.values(MediaEngine.getAllVoiceStatesInChannel(params.guildId, params.channelId)).find(
		(state) => state.user_id === params.actorId && state.session_id === params.actorSessionId,
	);
	return (
		!!actor &&
		actor.channel_id === params.channelId &&
		!actor.mute &&
		!actor.deaf &&
		!actor.self_deaf &&
		!actor.suppress
	);
}

export async function handleSoundboardPlay(data: SoundboardPlayPayload, context: GatewayHandlerContext): Promise<void> {
	if (
		context.isReplay ||
		!context.socket ||
		context.accountKey !== Users.viewAccountKey ||
		context.expectedUserId !== Users.getCurrentUser()?.id ||
		context.socket.getSessionId() !== GatewaySessions.foregroundConnection.sessionId
	)
		return;
	const now = performance.now();
	if (
		!data.event_id ||
		data.event_id.length > 128 ||
		!Number.isFinite(data.server_time) ||
		!Number.isSafeInteger(data.recipient_soundboard_epoch) ||
		data.recipient_soundboard_epoch < 0 ||
		!/^[a-f0-9]{64}$/.test(data.asset_version) ||
		!Number.isFinite(data.volume) ||
		data.volume < 0 ||
		data.volume > 1
	)
		return;
	const params: SoundboardPlaybackParams = {
		eventId: data.event_id,
		guildId: data.guild_id,
		channelId: data.channel_id,
		actorId: data.actor_id,
		actorSessionId: data.session_id,
		recipientConnectionId: data.recipient_connection_id,
		recipientSoundboardEpoch: data.recipient_soundboard_epoch,
		serverTime: data.server_time,
		assetVersion: data.asset_version,
		volume: data.volume * SoundboardSettings.volume,
		url: '',
		sizeBytes: 0,
		durationMs: 0,
	};
	if (!isSoundboardPlaybackEligible(params)) return;
	for (const [id, timestamp] of seenEvents) if (now - timestamp > MAX_EVENT_AGE_MS) seenEvents.delete(id);
	if (seenEvents.has(data.event_id)) return;
	seenEvents.set(data.event_id, now);
	if (seenEvents.size > MAX_SEEN_EVENTS) seenEvents.delete(seenEvents.keys().next().value!);
	const generation = lifecycleGeneration;
	const sessionKey = getSoundboardSessionKey();
	await SoundboardLibrary.load(data.guild_id);
	if (
		generation !== lifecycleGeneration ||
		getSoundboardSessionKey() !== sessionKey ||
		!isSoundboardPlaybackEligible(params) ||
		performance.now() - now > MAX_EVENT_AGE_MS
	)
		return;
	const sound = SoundboardLibrary.getSound(data.sound_id);
	if (!sound || sound.guild_id !== data.guild_id || sound.asset_hash !== data.asset_version) return;
	await SoundboardPlaybackEngine.play({
		...params,
		volume: data.volume * SoundboardSettings.volume,
		url: sound.url,
		sizeBytes: sound.size_bytes,
		durationMs: sound.duration_ms,
	});
}

export function resetSoundboardPlay(): void {
	lifecycleGeneration++;
	seenEvents.clear();
}

export function initSoundboardRuntime(): () => void {
	disposeRuntime?.();
	const disposeAccount = reaction(
		() => Users.viewAccountKey,
		(accountKey) => {
			SoundboardSettings.setAccount(accountKey);
			SoundboardLibrary.reset();
			resetSoundboardPlay();
		},
		{fireImmediately: true},
	);
	const disposeSession = reaction(getSoundboardSessionKey, () => {
		SoundboardLibrary.reset();
		resetSoundboardPlay();
	});
	SoundboardPlaybackEngine.configure({
		isEligible: isSoundboardPlaybackEligible,
		getSessionKey: getSoundboardSessionKey,
		subscribe: (listener) => {
			const stopReaction = reaction(() => {
				const audio = getEffectiveAudioState();
				const actors =
					MediaEngine.guildId && MediaEngine.channelId
						? MediaEngine.getAllVoiceStatesInChannel(MediaEngine.guildId, MediaEngine.channelId)
						: {};
				return [
					getSoundboardSessionKey(),
					audio.effectiveMute,
					audio.effectiveDeaf,
					SoundboardSettings.disabled,
					SoundboardSettings.volume,
					actors,
				];
			}, listener);
			const stopParticipant = ParticipantVolume.subscribe(listener);
			return () => {
				stopReaction();
				stopParticipant();
			};
		},
	});
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		disposeAccount();
		disposeSession();
		SoundboardPlaybackEngine.dispose();
		SoundboardLibrary.dispose();
		SoundboardSettings.dispose();
		resetSoundboardPlay();
		if (disposeRuntime === dispose) disposeRuntime = null;
	};
	disposeRuntime = dispose;
	return dispose;
}
