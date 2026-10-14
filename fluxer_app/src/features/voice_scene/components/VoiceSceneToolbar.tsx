// SPDX-License-Identifier: AGPL-3.0-or-later

import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {useCameraMode} from '@app/features/voice_scene/components/useCameraMode';
import styles from '@app/features/voice_scene/components/VoiceSceneToolbar.module.css';
import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowLeftIcon, HeadphonesIcon, type Icon, VideoCameraIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const SPATIAL_AUDIO_DESCRIPTOR = msg({
	message: '3D audio',
	comment:
		'Voice call 3D room: toggle label. On, each voice comes from where the person sits; off, everyone sounds centred.',
});
const TURN_OFF_SPATIAL_AUDIO_DESCRIPTOR = msg({
	message: 'Turn off 3D audio',
	comment: 'Voice call 3D room: tooltip on the 3D audio toggle while it is on.',
});
const TURN_ON_SPATIAL_AUDIO_DESCRIPTOR = msg({
	message: 'Turn on 3D audio',
	comment: 'Voice call 3D room: tooltip on the 3D audio toggle while it is off.',
});
const CAMERAS_DESCRIPTOR = msg({
	message: 'Cameras',
	comment:
		"Voice call 3D room: toggle label. On, a person's camera plays in their avatar circle in the room; off, only avatars. Remembered on this device.",
});
const HIDE_CAMERAS_DESCRIPTOR = msg({
	message: 'Hide cameras in the room',
	comment: 'Voice call 3D room: tooltip on the cameras toggle while it is on.',
});
const SHOW_CAMERAS_DESCRIPTOR = msg({
	message: 'Show cameras in the room',
	comment: 'Voice call 3D room: tooltip on the cameras toggle while it is off.',
});
const BACK_DESCRIPTOR = msg({
	message: 'Back',
	context: 'voice-scene-toolbar',
	comment: 'Voice call 3D room: button while the camera is close on the TV; returns to the whole room.',
});
const BACK_TOOLTIP_DESCRIPTOR = msg({
	message: 'Back to the room (Esc)',
	comment: 'Voice call 3D room: tooltip on the Back button while the camera is close on the TV.',
});

function ToolbarButton({
	icon: IconComponent,
	label,
	tooltip,
	pressed,
	onClick,
}: {
	icon: Icon;
	label: MessageDescriptor;
	tooltip: MessageDescriptor;
	pressed?: boolean;
	onClick: () => void;
}) {
	const {i18n} = useLingui();
	return (
		<Tooltip text={i18n._(tooltip)} position="top" data-flx="voice-scene.voice-scene-toolbar.toolbar-button.tooltip">
			<FocusRing offset={-2} data-flx="voice-scene.voice-scene-toolbar.toolbar-button.focus-ring">
				<button
					type="button"
					className={clsx(styles.toggle, pressed !== false && styles.toggleOn)}
					aria-pressed={pressed}
					onClick={onClick}
					data-flx="voice-scene.voice-scene-toolbar.toolbar-button.toggle"
				>
					<IconComponent
						weight={pressed === false ? 'regular' : 'fill'}
						className={styles.icon}
						data-flx="voice-scene.voice-scene-toolbar.toolbar-button.icon"
					/>
					<span className={styles.label} data-flx="voice-scene.voice-scene-toolbar.toolbar-button.label">
						{i18n._(label)}
					</span>
				</button>
			</FocusRing>
		</Tooltip>
	);
}

// Room-only controls; the flat/3D switch lives in the call header (VoiceSceneToggleButton). "Back" while the camera
// is close on the TV; the seat view has its own "Back to room" in the seat HUD.
export const VoiceSceneToolbar = observer(function VoiceSceneToolbar({handle}: {handle: VoiceSceneHandle | null}) {
	const mode = useCameraMode(handle);
	const spatialAudio = VoiceSceneSettings.spatialAudio;
	const showCameras = VoiceSceneSettings.showRoomCameras;
	const cameras = readVoiceRoomAssignment(ExperimentAssignments.response).cameras;
	return (
		<div className={styles.toolbar} data-flx="voice-scene.voice-scene-toolbar.toolbar">
			{handle && mode === 'focus' ? (
				<ToolbarButton
					icon={ArrowLeftIcon}
					label={BACK_DESCRIPTOR}
					tooltip={BACK_TOOLTIP_DESCRIPTOR}
					onClick={() => handle.exitToOrbit()}
					data-flx="voice-scene.voice-scene-toolbar.toolbar-button.exit-to-orbit"
				/>
			) : null}
			<ToolbarButton
				icon={HeadphonesIcon}
				label={SPATIAL_AUDIO_DESCRIPTOR}
				tooltip={spatialAudio ? TURN_OFF_SPATIAL_AUDIO_DESCRIPTOR : TURN_ON_SPATIAL_AUDIO_DESCRIPTOR}
				pressed={spatialAudio}
				onClick={() => VoiceSceneSettings.setSpatialAudio(!spatialAudio)}
				data-flx="voice-scene.voice-scene-toolbar.toolbar-button.set-spatial-audio"
			/>
			{cameras ? (
				<ToolbarButton
					icon={VideoCameraIcon}
					label={CAMERAS_DESCRIPTOR}
					tooltip={showCameras ? HIDE_CAMERAS_DESCRIPTOR : SHOW_CAMERAS_DESCRIPTOR}
					pressed={showCameras}
					onClick={() => VoiceSceneSettings.setShowRoomCameras(!showCameras)}
					data-flx="voice-scene.voice-scene-toolbar.toolbar-button.set-show-room-cameras"
				/>
			) : null}
		</div>
	);
});
