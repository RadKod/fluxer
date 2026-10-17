// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/components/ActivityPanel.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import KeybindManager from '@app/features/app/keybindings/KeybindManager';
import type {Channel} from '@app/features/channel/models/Channel';
import {Button} from '@app/features/ui/button/Button';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {Suspense, useCallback, useEffect, useState} from 'react';

const CLOSE_PANEL_DESCRIPTOR = msg({
	message: 'Close (the activity keeps running)',
	comment:
		'Voice activities: tooltip on the button that hides the activity panel. The activity and the call go on; the Activities button brings it back.',
});
const END_ACTIVITY_DESCRIPTOR = msg({
	message: 'End activity',
	comment: 'Voice activities: button in the activity panel that ends the activity for everyone in the channel.',
});

// Observable inputs only: whether the call view shows the activity instead of the grid or the 3D room.
export function isActivityPanelShown(channel: Channel): boolean {
	if (MobileLayout.isMobileLayout() || MediaEngine.channelId !== channel.id) return false;
	return voiceActivitiesEnabled(channel.guildId ?? null) && VoiceActivities.isPanelOpen(channel.id);
}

// While focus is inside the panel and the activity captures the keyboard, push-to-talk and the app's shortcuts
// wait (the keybind manager is suspended, as the keybind recorder does) and keys stop at the panel, so the window's
// own listeners (type-to-chat, room Esc) never see them.
function useKeyboardCapture(captured: boolean): {
	onFocus: () => void;
	onBlur: (event: React.FocusEvent<HTMLElement>) => void;
	onKey: (event: React.KeyboardEvent<HTMLElement>) => void;
} {
	const [focused, setFocused] = useState(false);
	const active = captured && focused;
	useEffect(() => {
		if (!active) return;
		KeybindManager.suspend();
		return () => KeybindManager.resume();
	}, [active]);
	const onFocus = useCallback(() => setFocused(true), []);
	const onBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
		const next = event.relatedTarget;
		if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
	}, []);
	const onKey = useCallback(
		(event: React.KeyboardEvent<HTMLElement>) => {
			if (active) event.stopPropagation();
		},
		[active],
	);
	return {onFocus, onBlur, onKey};
}

export const ActivityPanel = observer(function ActivityPanel({channel}: {channel: Channel}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channel.id);
	const live = VoiceActivities.getLive(channel.id);
	const keyboard = useKeyboardCapture(live?.keyboardCaptured ?? false);
	if (!session) return null;
	const definition = getActivityDefinition(session.activity_id);
	const {View, icon: Icon} = definition;
	const closeLabel = i18n._(CLOSE_PANEL_DESCRIPTOR);
	return (
		<section
			className={styles.panel}
			tabIndex={-1}
			aria-label={i18n._(definition.name)}
			onFocus={keyboard.onFocus}
			onBlur={keyboard.onBlur}
			onKeyDown={keyboard.onKey}
			onKeyUp={keyboard.onKey}
			data-flx="activities.activity-panel.panel.key"
		>
			<header className={styles.header} data-flx="activities.activity-panel.header">
				<Icon weight="fill" className={styles.icon} data-flx="activities.activity-panel.icon" />
				<h2 className={styles.title} data-flx="activities.activity-panel.title">
					{i18n._(definition.name)}
				</h2>
				<Button
					small
					variant="danger"
					submitting={VoiceActivities.request === 'end'}
					disabled={!live}
					onClick={() => void live?.end()}
					data-flx="activities.activity-panel.button"
				>
					{i18n._(END_ACTIVITY_DESCRIPTOR)}
				</Button>
				<Tooltip text={closeLabel} data-flx="activities.activity-panel.tooltip">
					<FocusRing offset={-2} data-flx="activities.activity-panel.focus-ring">
						<button
							type="button"
							className={styles.closeButton}
							onClick={VoiceActivities.closePanel}
							aria-label={closeLabel}
							data-flx="activities.activity-panel.close-button.close-panel"
						>
							<XIcon weight="bold" className={styles.closeIcon} data-flx="activities.activity-panel.close-icon" />
						</button>
					</FocusRing>
				</Tooltip>
			</header>
			<div className={styles.body} data-flx="activities.activity-panel.body">
				{live ? (
					<Suspense fallback={<Spinner data-flx="activities.activity-panel.spinner" />}>
						<View key={live.sessionId} session={live} data-flx="activities.activity-panel.view" />
					</Suspense>
				) : (
					<Spinner data-flx="activities.activity-panel.spinner--2" />
				)}
			</div>
		</section>
	);
});
