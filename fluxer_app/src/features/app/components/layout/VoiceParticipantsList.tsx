// SPDX-License-Identifier: AGPL-3.0-or-later

import {moveVoiceParticipantToChannel} from '@app/features/app/components/layout/dnd/VoiceParticipantDrop';
import {GroupedVoiceParticipant} from '@app/features/app/components/layout/GroupedVoiceParticipant';
import {type DragItem, DragItemType} from '@app/features/app/components/layout/types/DndTypes';
import {VoiceParticipantItem} from '@app/features/app/components/layout/VoiceParticipantItem';
import styles from '@app/features/app/components/layout/VoiceParticipantsList.module.css';
import type {Channel} from '@app/features/channel/models/Channel';
import type {VoiceState} from '@app/features/gateway/types/GatewayVoiceTypes';
import type {Guild} from '@app/features/guild/models/Guild';
import Users from '@app/features/user/state/Users';
import {resolveVoiceParticipantDisplayState} from '@app/features/voice/components/VoiceParticipantDisplayState';
import {
	createVoiceParticipantSortSnapshot,
	sortVoiceParticipantItemsWithSnapshot,
} from '@app/features/voice/components/VoiceParticipantSortUtils';
import MediaEngine, {useMediaEngineVersion} from '@app/features/voice/engine/MediaEngineFacade';
import LocalVoiceState from '@app/features/voice/state/LocalVoiceState';
import {isParticipantVoicePermissionMuted} from '@app/features/voice/utils/VoicePermissionUtils';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useCallback, useMemo, useRef} from 'react';
import type {ConnectableElement} from 'react-dnd';
import {useDrop} from 'react-dnd';

export const VoiceParticipantsList = observer(({guild, channel}: {guild: Guild; channel: Channel}) => {
	useMediaEngineVersion();
	const voiceStates = MediaEngine.getAllVoiceStatesInChannel(guild.id, channel.id);
	const currentUser = Users.currentUser;
	const localSelfMute = LocalVoiceState.getSelfMute();
	const localSelfStream = LocalVoiceState.getSelfStream();
	const localConnectionId = MediaEngine.connectionId;
	let missingUserCount = 0;
	for (const connectionKey in voiceStates) {
		const userId = voiceStates[connectionKey]?.user_id;
		if (userId && !Users.getUser(userId)) missingUserCount++;
	}
	const groupedSortSnapshotRef = useRef(createVoiceParticipantSortSnapshot());
	const grouped = useMemo(() => {
		const byUser = new Map<
			string,
			{
				userId: string;
				states: Array<VoiceState>;
				isCurrentUser: boolean;
			}
		>();
		for (const connectionKey in voiceStates) {
			const vs = voiceStates[connectionKey];
			if (!vs) continue;
			const userId = vs.user_id;
			let entry = byUser.get(userId);
			if (!entry) {
				entry = {userId, states: [], isCurrentUser: currentUser?.id === userId};
				byUser.set(userId, entry);
			}
			entry.states.push(vs);
		}
		return sortVoiceParticipantItemsWithSnapshot(Array.from(byUser.values()), {
			snapshot: groupedSortSnapshotRef.current,
			getParticipantKey: (entry) => entry.userId,
			getUserId: (entry) => entry.userId,
			guildId: guild.id,
			channelId: channel.id,
		});
	}, [channel.id, currentUser, guild.id, voiceStates, missingUserCount]);
	const [{isOver, canDrop}, dropRef] = useDrop(
		() => ({
			accept: DragItemType.VOICE_PARTICIPANT,
			canDrop: (item: DragItem) => item.currentChannelId !== channel.id,
			drop: (item: DragItem) => moveVoiceParticipantToChannel(item, guild.id, channel.id),
			collect: (monitor) => ({isOver: monitor.isOver(), canDrop: monitor.canDrop()}),
		}),
		[guild.id, channel.id],
	);
	const dropConnectorRef = useCallback(
		(node: ConnectableElement | null) => {
			dropRef(node);
		},
		[dropRef],
	);
	if (grouped.length === 0) return null;
	return (
		<div
			ref={dropConnectorRef}
			className={clsx(styles.container, isOver && canDrop && styles.containerOver)}
			data-flx="app.voice-participants-list.container"
		>
			{grouped.map(({userId, states, isCurrentUser}) => {
				const user = Users.getUser(userId);
				if (!user) return null;
				if (states.length === 1) {
					return (
						<VoiceParticipantItem
							key={userId}
							user={user}
							voiceState={states[0]}
							guildId={guild.id}
							isCurrentUser={isCurrentUser}
							isCurrentUserConnection={isCurrentUser && states[0].connection_id === localConnectionId}
							data-flx="app.voice-participants-list.voice-participant-item"
						/>
					);
				}
				const anySpeaking = states.some((voiceState) => {
					const connectionId = voiceState.connection_id ?? '';
					return resolveVoiceParticipantDisplayState({
						participant: MediaEngine.getParticipantByUserIdAndConnectionId(userId, connectionId),
						voiceState,
						isLocalConnection: isCurrentUser && connectionId === localConnectionId,
						localSelfMute,
						localSelfStream,
						permissionMuted: isParticipantVoicePermissionMuted({
							voiceState,
							guildId: guild.id,
							channelId: channel.id,
							isCurrentUser,
						}),
					}).speaking;
				});
				return (
					<GroupedVoiceParticipant
						key={userId}
						user={user}
						voiceStates={states}
						guildId={guild.id}
						anySpeaking={anySpeaking}
						data-flx="app.voice-participants-list.grouped-voice-participant"
					/>
				);
			})}
		</div>
	);
});
