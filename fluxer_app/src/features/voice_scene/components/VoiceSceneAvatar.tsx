// SPDX-License-Identifier: AGPL-3.0-or-later

import {PreloadableUserPopout} from '@app/features/channel/components/PreloadableUserPopout';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {VoiceParticipantContextMenu} from '@app/features/ui/action_menu/VoiceParticipantContextMenu';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import cameraStyles from '@app/features/voice_scene/components/VoiceSceneAvatar.module.css';
import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import RoomCameraStore from '@app/features/voice_scene/video/RoomCameraStore';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {VideoTrack} from '@livekit/components-react';
import {Track} from 'livekit-client';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback} from 'react';

const VIEW_PROFILE_DESCRIPTOR = msg({
	message: 'View profile for {displayName}',
	comment: "3D voice room: aria label on a person's avatar. {displayName} is the person's display name.",
});
const UNKNOWN_USER_DESCRIPTOR = msg({
	message: 'Unknown user',
	comment: '3D voice room: fallback name when the user record has no usable name.',
});

// Rendered at this size and scaled with the camera by the anchor; the image is fetched for the closest zoom.
const AVATAR_MEDIA_SIZE = 128;

export function hasShownCamera(entry: VoiceParticipantAvatarEntry, channelId: string): boolean {
	const room = MediaEngine.channelId === channelId ? MediaEngine.room : null;
	if (
		!entry.hasCamera ||
		!room ||
		!readVoiceRoomAssignment(ExperimentAssignments.response).cameras ||
		!VoiceSceneSettings.showRoomCameras
	)
		return false;
	const identity = buildVoiceParticipantIdentity(entry.userId, entry.connectionId);
	const shown = entry.isLocal ? VoiceSettings.getShowMyOwnCamera() : RoomCameraStore.qualityOf(identity) !== null;
	const participant = entry.isLocal ? room.localParticipant : room.getParticipantByIdentity(identity);
	return shown && !!participant?.getTrackPublication(Track.Source.Camera);
}

// Over the disc, under the speaking ring: a remote camera only while the room plans it (the room owns that subscription),
// my own camera as a local preview that subscribes to nothing.
const AvatarCamera = observer(function AvatarCamera({
	entry,
	channelId,
}: {
	entry: VoiceParticipantAvatarEntry;
	channelId: string;
}) {
	const room = MediaEngine.channelId === channelId ? MediaEngine.room : null;
	if (!hasShownCamera(entry, channelId) || !room) return null;
	const identity = buildVoiceParticipantIdentity(entry.userId, entry.connectionId);
	const participant = entry.isLocal ? room.localParticipant : room.getParticipantByIdentity(identity);
	const publication = participant?.getTrackPublication(Track.Source.Camera);
	if (!participant || !publication) return null;
	return (
		<VideoTrack
			className={cameraStyles.camera}
			trackRef={{participant, publication, source: Track.Source.Camera}}
			manageSubscription={false}
			data-embed-media=""
			data-flx="voice-scene.voice-scene-avatar.avatar-camera.camera"
		/>
	);
});

// A person in the room: avatar with decoration and ultra decoration, a ring while speaking (CSS, no scene redraw),
// the name on hover, the profile on click and the voice participant menu on right click.
export const VoiceSceneAvatar = observer(function VoiceSceneAvatar({
	entry,
	guildId,
	channelId,
	size,
	cameraCard,
}: {
	entry: VoiceParticipantAvatarEntry;
	guildId: string | null;
	channelId: string;
	size: number;
	cameraCard?: 'room' | 'seat';
}) {
	const {i18n} = useLingui();
	const displayName = NicknameUtils.getNickname(entry.user, guildId, channelId) || i18n._(UNKNOWN_USER_DESCRIPTOR);
	const card = cameraCard && hasShownCamera(entry, channelId) ? cameraCard : undefined;
	const handleContextMenu = useCallback(
		(event: React.MouseEvent<HTMLElement>) => {
			event.preventDefault();
			event.stopPropagation();
			ContextMenuCommands.openFromEvent(event, ({onClose}) => (
				<VoiceParticipantContextMenu
					user={entry.user}
					participantName={displayName}
					onClose={onClose}
					guildId={guildId ?? undefined}
					connectionId={entry.connectionId}
					surface="call-avatar"
					source={{kind: 'participant'}}
					data-flx="voice-scene.voice-scene-avatar.handle-context-menu.voice-participant-context-menu"
				/>
			));
		},
		[displayName, entry.connectionId, entry.user, guildId],
	);
	return (
		<PreloadableUserPopout
			user={entry.user}
			isWebhook={false}
			guildId={guildId ?? undefined}
			channelId={channelId}
			tooltip={displayName}
			disableContextMenu
			data-flx="voice-scene.voice-scene-avatar.preloadable-user-popout"
		>
			<button
				type="button"
				className={styles.avatar}
				data-camera-card={card}
				data-speaking={entry.speaking}
				aria-label={i18n._(VIEW_PROFILE_DESCRIPTOR, {displayName})}
				onContextMenu={handleContextMenu}
				data-flx="voice-scene.voice-scene-avatar.avatar"
			>
				<Avatar
					user={entry.user}
					size={size}
					decorationSurface="voice"
					mediaSize={AVATAR_MEDIA_SIZE}
					guildId={guildId}
					data-flx="voice-scene.voice-scene-avatar.avatar.avatar"
				/>
				<AvatarCamera entry={entry} channelId={channelId} data-flx="voice-scene.voice-scene-avatar.avatar-camera" />
			</button>
		</PreloadableUserPopout>
	);
});
