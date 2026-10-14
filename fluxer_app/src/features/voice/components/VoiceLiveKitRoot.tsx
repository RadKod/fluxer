// SPDX-License-Identifier: AGPL-3.0-or-later

import {VoiceRoomContext} from '@app/features/voice/components/VoiceRoomContext';
import {type AudioTrack, RoomContext, type useTracks} from '@livekit/components-react';
import {type Room, Track} from 'livekit-client';
import type React from 'react';
import {useEffect, useState} from 'react';

interface LiveKitComponentsModule {
	AudioTrack: typeof AudioTrack;
	useTracks: typeof useTracks;
}

interface VoiceLiveKitRootProps {
	room: Room | null;
	children: React.ReactNode;
	'data-flx'?: string;
}

interface RemoteAudioTracksProps {
	room: Room;
	components: LiveKitComponentsModule;
	'data-flx'?: string;
}

const REMOTE_AUDIO_SOURCES = [Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown];

let liveKitComponentsPromise: Promise<LiveKitComponentsModule> | null = null;

function loadLiveKitComponents(): Promise<LiveKitComponentsModule> {
	liveKitComponentsPromise ??= import('@livekit/components-react').then(({AudioTrack, useTracks}) => ({
		AudioTrack,
		useTracks,
	}));
	return liveKitComponentsPromise;
}

function RemoteAudioTracks({room, components}: RemoteAudioTracksProps): React.ReactElement {
	const tracks = components.useTracks(REMOTE_AUDIO_SOURCES, {updateOnlyOn: [], onlySubscribed: true, room});
	return (
		<>
			{tracks
				.filter((trackRef) => !trackRef.participant.isLocal && trackRef.publication.kind === Track.Kind.Audio)
				.map((trackRef) => (
					<components.AudioTrack
						key={trackRef.publication.trackSid}
						trackRef={trackRef}
						data-flx="voice.voice-live-kit-root.remote-audio-tracks.components-audio-track"
					/>
				))}
		</>
	);
}

export function VoiceLiveKitRoot({room, children}: VoiceLiveKitRootProps): React.ReactElement {
	const [components, setComponents] = useState<LiveKitComponentsModule | null>(null);

	useEffect(() => {
		if (!room || components) {
			return;
		}
		let canceled = false;
		void loadLiveKitComponents().then((loadedComponents) => {
			if (!canceled) {
				setComponents(loadedComponents);
			}
		});
		return () => {
			canceled = true;
		};
	}, [components, room]);

	// The tree shape stays the same with or without a room so joining or leaving a call does not remount the app.
	// Remote audio elements are direct children of a container that outlives calls: when a call ends they are
	// left without a parent, which lets LiveKit's detached-element cache stop growing.
	return (
		<VoiceRoomContext.Provider value={room ?? undefined}>
			<RoomContext.Provider value={room ?? undefined}>
				{children}
				<div style={{display: 'none'}} data-flx="app.app.app-wrapper.room-audio-renderer">
					{room && components && (
						<RemoteAudioTracks
							room={room}
							components={components}
							data-flx="voice.voice-live-kit-root.remote-audio-tracks"
						/>
					)}
				</div>
			</RoomContext.Provider>
		</VoiceRoomContext.Provider>
	);
}
