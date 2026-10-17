// SPDX-License-Identifier: AGPL-3.0-or-later

import {endVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {RoomActivitySession} from '@app/features/activities/session/RoomActivitySession';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {parseRoomActivitySession} from '@app/features/activities/utils/VoiceActivityMetadata';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {RoomEvent} from 'livekit-client';
import {compareShallow, reaction} from 'mobx';

const ROOM_METADATA_EVENTS = [RoomEvent.RoomMetadataChanged, RoomEvent.Connected, RoomEvent.Reconnected] as const;

// Room metadata into the store, and one live session object while a session runs in my room. Mounted once at the
// app root, so the session keeps answering (clock, state) while the call view is closed.
export function startVoiceActivityBinding(): () => void {
	let detachRoom: (() => void) | null = null;
	let live: RoomActivitySession | null = null;
	const disposeRoom = reaction(
		() => [MediaEngine.room, MediaEngine.channelId] as const,
		([room, channelId]) => {
			detachRoom?.();
			detachRoom = null;
			if (!room || !channelId) {
				VoiceActivities.handleSession(null, null);
				return;
			}
			// The join answer's metadata is not announced as a change, so a connect is read as well.
			const read = () => VoiceActivities.handleSession(channelId, parseRoomActivitySession(room.metadata));
			for (const event of ROOM_METADATA_EVENTS) room.on(event, read);
			detachRoom = () => {
				for (const event of ROOM_METADATA_EVENTS) room.off(event, read);
			};
			read();
		},
		{fireImmediately: true, equals: compareShallow},
	);
	const disposeLive = reaction(
		() => [MediaEngine.room, VoiceActivities.channelId, VoiceActivities.session] as const,
		([room, channelId, session]) => {
			live?.dispose();
			live = null;
			if (room && channelId && session) {
				const sessionId = session.session_id;
				live = new RoomActivitySession({room, channelId, session, end: () => endVoiceActivity(channelId, sessionId)});
			}
			VoiceActivities.setLive(live);
		},
		{fireImmediately: true, equals: compareShallow},
	);
	return () => {
		disposeRoom();
		disposeLive();
		detachRoom?.();
		live?.dispose();
		VoiceActivities.reset();
	};
}
