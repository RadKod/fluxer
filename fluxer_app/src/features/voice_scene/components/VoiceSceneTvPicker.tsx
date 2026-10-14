// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {ContextMenuCloseProvider, MenuGroup} from '@app/features/ui/action_menu/ContextMenu';
import {MenuItemRadio} from '@app/features/ui/action_menu/MenuItemRadio';
import {Button} from '@app/features/ui/button/Button';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import VoiceSceneTvRequest from '@app/features/voice_scene/state/VoiceSceneTvRequest';
import type {TvSource} from '@app/features/voice_scene/video/TvSource';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {MonitorIcon, VideoCameraIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const TV_SOURCE_DESCRIPTOR = msg({
	message: 'TV source',
	comment: '3D voice room TV: button under the TV that opens the list of what this viewer can put on it.',
});
const SCREEN_SOURCE_DESCRIPTOR = msg({
	message: "{displayName}'s screen",
	comment: "3D voice room TV source list: someone's screen share. {displayName} is that person's name.",
});
const CAMERA_SOURCE_DESCRIPTOR = msg({
	message: "{displayName}'s camera",
	comment: "3D voice room TV source list: someone's camera. {displayName} is that person's name.",
});

// what plays on the TV is this viewer's own choice; nobody else's view or the streamer's viewer list changes.
export const VoiceSceneTvPicker = observer(function VoiceSceneTvPicker({
	channel,
	entries,
	sources,
	current,
}: {
	channel: Channel;
	entries: ReadonlyArray<VoiceParticipantAvatarEntry>;
	sources: ReadonlyArray<TvSource>;
	current: TvSource | null;
}) {
	const {i18n} = useLingui();
	const guildId = channel.guildId ?? null;
	const label = (source: TvSource): string => {
		const entry = entries.find(
			(item) => buildVoiceParticipantIdentity(item.userId, item.connectionId) === source.identity,
		);
		const displayName = entry ? NicknameUtils.getNickname(entry.user, guildId, channel.id) : '';
		return i18n._(source.kind === 'screen' ? SCREEN_SOURCE_DESCRIPTOR : CAMERA_SOURCE_DESCRIPTOR, {displayName});
	};
	const handleOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
		ContextMenuCommands.openFromElementBottomRight(event, ({onClose}) => (
			<ContextMenuCloseProvider
				value={onClose}
				data-flx="voice-scene.voice-scene-tv-picker.context-menu-close-provider"
			>
				<MenuGroup data-flx="voice-scene.voice-scene-tv-picker.menu-group">
					{sources.map((source) => (
						<MenuItemRadio
							key={`${source.kind}:${source.identity}`}
							selected={source.kind === current?.kind && source.identity === current.identity}
							closeOnSelect
							onSelect={() => VoiceSceneTvRequest.select(channel.id, source)}
							icon={
								source.kind === 'screen' ? (
									<MonitorIcon weight="bold" data-flx="voice-scene.voice-scene-tv-picker.monitor-icon" />
								) : (
									<VideoCameraIcon weight="bold" data-flx="voice-scene.voice-scene-tv-picker.video-camera-icon" />
								)
							}
							data-flx="voice-scene.voice-scene-tv-picker.menu-item-radio.select"
						>
							{label(source)}
						</MenuItemRadio>
					))}
				</MenuGroup>
			</ContextMenuCloseProvider>
		));
	};
	return (
		<Button small compact variant="inverted" onClick={handleOpen} data-flx="voice-scene.voice-scene-tv-picker.button">
			{i18n._(TV_SOURCE_DESCRIPTOR)}
		</Button>
	);
});
