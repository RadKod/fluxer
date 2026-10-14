// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import type {Channel} from '@app/features/channel/models/Channel';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {Logger} from '@app/features/platform/utils/AppLogger';
import TableGames from '@app/features/table_game/state/TableGames';
import {drawTableTop} from '@app/features/table_game/utils/drawTableTop';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {VoiceSceneOverlay} from '@app/features/voice_scene/components/VoiceSceneOverlay';
import {VoiceSceneRoomThemeSelect} from '@app/features/voice_scene/components/VoiceSceneRoomThemeSelect';
import {VoiceSceneToolbar} from '@app/features/voice_scene/components/VoiceSceneToolbar';
import styles from '@app/features/voice_scene/components/VoiceSceneView.module.css';
import type {VoiceSceneRenderer} from '@app/features/voice_scene/scene/VoiceSceneRenderer';
import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import {effectiveRoomTheme} from '@app/features/voice_scene/utils/EffectiveRoomTheme';
import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';
import {themeTableSlots, type VoiceRoomTheme} from '@fluxer/constants/src/VoiceRoomThemes';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';

const logger = new Logger('VoiceSceneView');

const CONTEXT_LOST_DESCRIPTOR = msg({
	message: '3D view stopped. Showing the flat view.',
	comment:
		'Voice call 3D room: toast when the graphics card dropped the 3D view (driver reset, sleep). The call keeps going in the flat view.',
});

// the room file is only ever the hashed name from the generated manifest, under the static CDN.
function roomFileUrl(theme: VoiceRoomTheme): string {
	return `${RuntimeConfig.staticCdnEndpoint}/rooms/${VOICE_ROOM_THEME_MANIFEST[theme].file}`;
}

// Public table faces on the 3D tables; a state change redraws that one texture and asks for a single frame.
function useTableTops(channelId: string, theme: VoiceRoomTheme | null, handle: VoiceSceneHandle | null): void {
	useEffect(() => {
		if (!theme || !handle) return;
		const disposers = themeTableSlots(theme).map((slot) => {
			const canvas = document.createElement('canvas');
			return reaction(
				() => TableGames.getView(channelId, slot),
				(view) => {
					if (!view) {
						handle.setTableTop(slot, null);
						return;
					}
					drawTableTop(canvas, view);
					handle.setTableTop(slot, canvas);
				},
				{fireImmediately: true},
			);
		});
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, [channelId, theme, handle]);
}

export const VoiceSceneView = observer(function VoiceSceneView({channel}: {channel: Channel}) {
	const {i18n} = useLingui();
	const stageRef = useRef<HTMLDivElement>(null);
	const [handle, setHandle] = useState<VoiceSceneHandle | null>(null);
	const theme = effectiveRoomTheme(
		channel.roomTheme,
		readVoiceRoomAssignment(ExperimentAssignments.response).default_room_theme,
		channel.type,
	);
	const contextLostText = i18n._(CONTEXT_LOST_DESCRIPTOR);

	useEffect(() => {
		const container = stageRef.current;
		if (!theme || !container) return;
		const abort = new AbortController();
		let renderer: VoiceSceneRenderer | null = null;
		// The only path to three: a lazy chunk fetched when a room actually opens.
		import('@app/features/voice_scene/scene/VoiceSceneRenderer')
			.then(({createVoiceSceneRenderer}) => {
				performance.mark('oda-3b:chunk');
				return createVoiceSceneRenderer({
					container,
					url: roomFileUrl(theme),
					signal: abort.signal,
					onContextLost: () => {
						ToastCommands.createToast({type: 'info', children: contextLostText});
						VoiceSceneSettings.reportFailure('context_lost');
					},
				});
			})
			.then((created) => {
				if (abort.signal.aborted) {
					created.dispose();
					return;
				}
				renderer = created;
				setHandle(created.handle);
			})
			.catch((error: unknown) => {
				if (abort.signal.aborted) return;
				logger.warn('3D room failed to load, showing the flat view', error);
				VoiceSceneSettings.reportFailure('load_failed');
			});
		return () => {
			abort.abort();
			renderer?.dispose();
			setHandle(null);
		};
	}, [theme]);

	useTableTops(channel.id, theme, handle);

	return (
		<div className={styles.scene} data-flx="voice-scene.voice-scene-view.scene">
			<div
				ref={stageRef}
				className={clsx(styles.stage, handle && styles.stageReady)}
				data-flx="voice-scene.voice-scene-view.stage"
			/>
			{handle ? (
				<VoiceSceneOverlay
					handle={handle}
					channel={channel}
					data-flx="voice-scene.voice-scene-view.voice-scene-overlay"
				/>
			) : (
				<div className={styles.loading} data-flx="voice-scene.voice-scene-view.loading">
					<Spinner data-flx="voice-scene.voice-scene-view.spinner" />
				</div>
			)}
			<VoiceSceneToolbar handle={handle} data-flx="voice-scene.voice-scene-view.voice-scene-toolbar" />
			<VoiceSceneRoomThemeSelect channel={channel} data-flx="voice-scene.voice-scene-view.room-theme-select" />
		</div>
	);
});
