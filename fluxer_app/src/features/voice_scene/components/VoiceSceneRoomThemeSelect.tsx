// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ChannelCommands from '@app/features/channel/commands/ChannelCommands';
import {showChannelErrorModal} from '@app/features/channel/components/alerts/ChannelErrorModalUtils';
import type {Channel} from '@app/features/channel/models/Channel';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import Permission from '@app/features/permissions/state/Permission';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import styles from '@app/features/voice_scene/components/VoiceSceneView.module.css';
import {ROOM_THEME_LABEL_DESCRIPTOR, roomThemeOptions} from '@app/features/voice_scene/utils/RoomThemeOptions';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const ROOM_THEME_UPDATE_FAILED_DESCRIPTOR = msg({
	message: 'Room theme could not be updated',
	comment: 'Error dialog title after a shared voice channel room theme update fails.',
});
const ROOM_THEME_TRY_AGAIN_DESCRIPTOR = msg({
	message: 'Try again to change the room theme.',
	comment: 'Error dialog instruction after a shared voice channel room theme update fails.',
});

export const VoiceSceneRoomThemeSelect = observer(function VoiceSceneRoomThemeSelect({channel}: {channel: Channel}) {
	const {i18n} = useLingui();
	const [isUpdating, setIsUpdating] = useState(false);
	const assignment = readVoiceRoomAssignment(ExperimentAssignments.response);
	const canManageChannel =
		channel.guildId !== null &&
		Permission.can(Permissions.MANAGE_CHANNELS, {
			guildId: channel.guildId,
			channelId: channel.id,
		});
	if (!assignment.rooms || !canManageChannel) return null;
	const updateTheme = async (theme: string | null) => {
		if (isUpdating || theme === channel.roomTheme) return;
		setIsUpdating(true);
		try {
			await ChannelCommands.update(channel.id, {room_theme: theme});
		} catch {
			showChannelErrorModal({
				title: i18n._(ROOM_THEME_UPDATE_FAILED_DESCRIPTOR),
				message: i18n._(ROOM_THEME_TRY_AGAIN_DESCRIPTOR),
				dataFlx: 'voice-scene.room-theme.update-failed',
			});
		} finally {
			setIsUpdating(false);
		}
	};
	return (
		<div className={styles.themeSelector} data-flx="voice-scene.room-theme">
			<Combobox<string | null>
				label={i18n._(ROOM_THEME_LABEL_DESCRIPTOR)}
				aria-label={i18n._(ROOM_THEME_LABEL_DESCRIPTOR)}
				value={channel.roomTheme ?? null}
				options={roomThemeOptions(i18n, assignment.default_room_theme)}
				onChange={updateTheme}
				disabled={isUpdating}
				isSearchable={false}
				isClearable={false}
				menuPlacement="top"
				density="compact"
				data-flx="voice-scene.room-theme.select"
			/>
		</div>
	);
});
