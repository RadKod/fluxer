// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import type {Channel} from '@app/features/channel/models/Channel';
import VoiceCallFullscreen from '@app/features/voice/state/VoiceCallFullscreen';
import {roomViewFor} from '@app/features/voice_scene/state/RoomView';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowClockwiseIcon, CubeIcon, SquaresFourIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const SHOW_FLAT_VIEW_DESCRIPTOR = msg({
	message: 'Show flat view',
	comment: 'Voice call header button in a 3D room: switch back to the usual flat call view. Remembered on this device.',
});
const SHOW_ROOM_DESCRIPTOR = msg({
	message: 'Show 3D room',
	comment: 'Voice call header button in the flat view of a channel with a room theme: open the 3D room.',
});
const RETRY_ROOM_DESCRIPTOR = msg({
	message: '3D view stopped. Try again',
	comment: 'Voice call header button after the 3D room stopped or failed to load; the call kept going. Click retries.',
});

// Shown only where the 3D room could appear on this device; hidden for missing flag, theme, WebGL or mobile layout.
export const VoiceSceneToggleButton = observer(function VoiceSceneToggleButton({
	channel,
	className,
}: {
	channel: Channel;
	className?: string;
}) {
	const {i18n} = useLingui();
	const scopeKey = `${channel.guildId ? 'guild-voice' : 'dm-call'}:${channel.id}`;
	const callViewRequested = VoiceCallFullscreen.isCallViewRequested(scopeKey);
	const {reason} = roomViewFor(channel);
	if (reason === 'room')
		return (
			<ChannelHeaderIcon
				icon={SquaresFourIcon}
				label={i18n._(SHOW_FLAT_VIEW_DESCRIPTOR)}
				className={className}
				onClick={() => VoiceSceneSettings.setPreferRoom(false)}
				data-flx="voice-scene.voice-scene-toggle-button.channel-header-icon.set-prefer-room"
			/>
		);
	if (reason === 'user_flat')
		return (
			<ChannelHeaderIcon
				icon={CubeIcon}
				label={i18n._(SHOW_ROOM_DESCRIPTOR)}
				className={className}
				onClick={() => {
					VoiceSceneSettings.setPreferRoom(true);
					if (callViewRequested) VoiceCallFullscreen.open(scopeKey);
				}}
				data-flx="voice-scene.voice-scene-toggle-button.channel-header-icon.set-prefer-room--2"
			/>
		);
	if (reason === 'context_lost' || reason === 'load_failed')
		return (
			<ChannelHeaderIcon
				icon={ArrowClockwiseIcon}
				label={i18n._(RETRY_ROOM_DESCRIPTOR)}
				className={className}
				onClick={() => {
					VoiceSceneSettings.retry();
					if (callViewRequested) VoiceCallFullscreen.open(scopeKey);
				}}
				data-flx="voice-scene.voice-scene-toggle-button.channel-header-icon.retry"
			/>
		);
	return null;
});
