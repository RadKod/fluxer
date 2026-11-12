// SPDX-License-Identifier: AGPL-3.0-or-later

import {useElectronScreenSharePicker} from '@app/features/voice/hooks/useElectronScreenSharePicker';
import {startScreenSharePiPController} from '@app/features/voice/state/ScreenSharePiPController';
import {type AudioTrack, RoomContext, type useTracks} from '@livekit/components-react';
import {type Room, Track} from 'livekit-client';
import type React from 'react';
import {useEffect, useState} from 'react';

export {default as MediaEngine} from '@app/features/voice/engine/MediaEngineFacade';

interface LiveKitComponentsModule {
	AudioTrack: typeof AudioTrack;
	useTracks: typeof useTracks;
}

// sanalyer: remote audio only (Micup), so the local microphone never plays back and screen-share audio is included.
const REMOTE_AUDIO_SOURCES = [Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown];

let liveKitComponentsPromise: Promise<LiveKitComponentsModule> | null = null;

function loadLiveKitComponents(): Promise<LiveKitComponentsModule> {
	liveKitComponentsPromise ??= import('@livekit/components-react').then(({AudioTrack, useTracks}) => ({
		AudioTrack,
		useTracks,
	}));
	return liveKitComponentsPromise;
}

function RemoteAudioTracks({room, components}: {room: Room; components: LiveKitComponentsModule}): React.ReactElement {
	const tracks = components.useTracks(REMOTE_AUDIO_SOURCES, {updateOnlyOn: [], onlySubscribed: true, room});
	return (
		<>
			{tracks
				.filter((trackRef) => !trackRef.participant.isLocal && trackRef.publication.kind === Track.Kind.Audio)
				.map((trackRef) => (
					<components.AudioTrack
						key={trackRef.publication.trackSid}
						trackRef={trackRef}
						data-flx="voice.voice-runtime-module.remote-audio-tracks.components-audio-track"
					/>
				))}
		</>
	);
}

export function VoiceRoomProviders({room, children}: {room: Room; children: React.ReactNode}): React.ReactElement {
	const [components, setComponents] = useState<LiveKitComponentsModule | null>(null);
	useEffect(() => {
		if (components) return;
		let canceled = false;
		void loadLiveKitComponents().then((loaded) => {
			if (!canceled) setComponents(loaded);
		});
		return () => {
			canceled = true;
		};
	}, [components]);
	return (
		<RoomContext.Provider value={room}>
			{children}
			<div style={{display: 'none'}} data-flx="app.app.app-wrapper.room-audio-renderer">
				{components && <RemoteAudioTracks room={room} components={components} />}
			</div>
		</RoomContext.Provider>
	);
}

export function VoiceRuntimeEffects(): null {
	useElectronScreenSharePicker();
	useEffect(() => startScreenSharePiPController(), []);
	return null;
}
