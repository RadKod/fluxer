// SPDX-License-Identifier: AGPL-3.0-or-later

import * as NavigationCommands from '@app/features/navigation/commands/NavigationCommands';
import '@app/features/voice/components/VoiceCallView.module.css';
import {ActivityPiPContent} from '@app/features/activities/components/ActivityPiPContent';
import Channels from '@app/features/channel/state/Channels';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import PiP, {type StreamPiPContent} from '@app/features/ui/state/PiP';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import styles from '@app/features/voice/components/PiPOverlay.module.css';
import {PiPFooter} from '@app/features/voice/components/pip_overlay/PiPFooter';
import {PiPHeader} from '@app/features/voice/components/pip_overlay/PiPHeader';
import {PiPOverlayContextMenu} from '@app/features/voice/components/pip_overlay/PiPOverlayContextMenu';
import {PiPWindow} from '@app/features/voice/components/pip_overlay/PiPWindow';
import {type PiPOverlayInnerProps, pipOverlayLogger} from '@app/features/voice/components/pip_overlay/shared';
import {useFindTrackRef} from '@app/features/voice/components/pip_overlay/useFindTrackRef';
import {getStreamKey} from '@app/features/voice/components/StreamKeys';
import {useStreamSpectators} from '@app/features/voice/components/useStreamSpectators';
import {VoiceParticipantTile} from '@app/features/voice/components/VoiceParticipantTile';
import MediaEngine, {useMediaEngineVersion} from '@app/features/voice/engine/MediaEngineFacade';
import {VOICE_DISCONNECT_DESCRIPTOR} from '@app/features/voice/utils/VoiceMessageDescriptors';
import {ME} from '@fluxer/constants/src/AppConstants';
import {useLingui} from '@lingui/react/macro';
import {isTrackReference, type TrackReferenceOrPlaceholder} from '@livekit/components-react';
import type {Room} from 'livekit-client';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useMemo} from 'react';

export const PiPOverlayInner = observer(function PiPOverlayInner({content, room}: PiPOverlayInnerProps) {
	if (content.type === 'activity') {
		return (
			<ActivityPiPContent content={content} data-flx="voice.pip-overlay.pi-p-overlay-inner.activity-pi-p-content" />
		);
	}
	if (!room) {
		return (
			<StreamPiP
				content={content}
				room={null}
				trackRef={null}
				data-flx="voice.pip-overlay.pi-p-overlay-inner.pi-p-overlay-inner-base"
			/>
		);
	}
	return (
		<StreamPiPWithLiveKitTrack
			content={content}
			room={room}
			data-flx="voice.pip-overlay.pi-p-overlay-inner.pi-p-overlay-inner-with-live-kit-track"
		/>
	);
});

const StreamPiPWithLiveKitTrack = observer(function StreamPiPWithLiveKitTrack({
	content,
	room,
}: {
	content: StreamPiPContent;
	room: Room;
}) {
	const trackRef = useFindTrackRef(content, room);
	return (
		<StreamPiP
			content={content}
			room={room}
			trackRef={trackRef}
			data-flx="voice.pip-overlay.pi-p-overlay-inner.pi-p-overlay-inner-with-live-kit-track.pi-p-overlay-inner-base"
		/>
	);
});

interface StreamPiPProps {
	content: StreamPiPContent;
	room: Room | null;
	trackRef: TrackReferenceOrPlaceholder | null;
}

const StreamPiP = observer(function StreamPiP({content, room, trackRef}: StreamPiPProps) {
	const {i18n} = useLingui();
	useMediaEngineVersion();
	const trackRefSummary = useMemo(() => {
		if (!trackRef) return null;
		const summary = {
			participantIdentity: trackRef.participant.identity,
			source: trackRef.source,
			isTrackReference: isTrackReference(trackRef),
		};
		if (!isTrackReference(trackRef)) return summary;
		const publicationRecord = trackRef.publication as unknown as Record<string, unknown>;
		return {
			...summary,
			trackSid: trackRef.publication.trackSid,
			isMuted: trackRef.publication.isMuted,
			isSubscribed: typeof publicationRecord.isSubscribed === 'boolean' ? publicationRecord.isSubscribed : null,
			hasTrack: Boolean(trackRef.publication.track),
		};
	}, [trackRef]);
	const channel = Channels.getChannel(content.channelId);
	const participantUser = Users.getUser(content.userId);
	const streamKey = useMemo(
		() => getStreamKey(content.guildId, content.channelId, content.connectionId),
		[content.guildId, content.channelId, content.connectionId],
	);
	const {viewerUsers} = useStreamSpectators(streamKey, content.userId);
	const displayName = useMemo(() => {
		if (!participantUser) return '';
		return NicknameUtils.getNickname(participantUser, content.guildId ?? null, content.channelId);
	}, [participantUser, content.guildId, content.channelId]);
	const handleDisconnect = useCallback(async (e: React.MouseEvent) => {
		e.stopPropagation();
		await MediaEngine.disconnectFromVoiceChannel('user');
		PiP.close();
	}, []);
	const returnToCall = useCallback(() => {
		NavigationCommands.selectChannel(content.guildId ?? ME, content.channelId);
	}, [content.channelId, content.guildId]);
	const handleReturnToCall = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			event.stopPropagation();
			returnToCall();
		},
		[returnToCall],
	);
	const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		ContextMenuCommands.openFromEvent(event, () => (
			<PiPOverlayContextMenu data-flx="voice.pi-p-overlay.context-menu" />
		));
	}, []);
	useEffect(() => {
		pipOverlayLogger.debug('PiP overlay media state', {
			content,
			roomLocalParticipantIdentity: room?.localParticipant.identity ?? null,
			remoteParticipantCount: room?.remoteParticipants.size ?? 0,
			trackRef: trackRefSummary,
		});
	}, [content, room, trackRefSummary]);
	return (
		<PiPWindow
			type="stream"
			onActivate={returnToCall}
			onContextMenu={handleContextMenu}
			data-flx="voice.pi-p-overlay.pi-p-overlay-inner.container"
		>
			{trackRef && (
				<VoiceParticipantTile
					trackRef={trackRef}
					guildId={content.guildId ?? undefined}
					channelId={content.channelId}
					showFocusIndicator={false}
					showParticipantMetadata={false}
					presentation="focus-main"
					data-flx="voice.pi-p-overlay.pi-p-overlay-inner.voice-participant-tile"
				/>
			)}
			<div className={styles.hoverOverlay} data-flx="voice.pi-p-overlay.pi-p-overlay-inner.hover-overlay">
				<PiPHeader
					channelName={channel?.name ?? ''}
					onReturnToCall={handleReturnToCall}
					data-flx="voice.pip-overlay.pi-p-overlay-inner.pi-p-overlay-inner-base.pi-p-header"
				/>
				<PiPFooter
					displayName={displayName}
					isScreenShare
					viewerUsers={viewerUsers}
					disconnectLabel={i18n._(VOICE_DISCONNECT_DESCRIPTOR)}
					onDisconnect={handleDisconnect}
					data-flx="voice.pip-overlay.pi-p-overlay-inner.pi-p-overlay-inner-base.pi-p-footer"
				/>
			</div>
		</PiPWindow>
	);
});
