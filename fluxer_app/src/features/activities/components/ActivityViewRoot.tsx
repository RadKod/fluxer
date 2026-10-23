// SPDX-License-Identifier: AGPL-3.0-or-later

import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import styles from '@app/features/activities/components/ActivityViewRoot.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {mountedActivitySession} from '@app/features/activities/utils/JoinedActivitySession';
import KeybindManager from '@app/features/app/keybindings/KeybindManager';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRingScope from '@app/features/ui/focus_ring/FocusRingScope';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

// While focus is inside the View and the activity captures the keyboard, push-to-talk and the app's shortcuts wait
// (the keybind manager is suspended, as the keybind recorder does) and keys stop at the View, so the window's own
// listeners (type-to-chat, room Esc) never see them. Clicking the message box moves focus out and gives keys back.
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
		ActivityViewDock.setKeysCaptured(true);
		return () => {
			KeybindManager.resume();
			ActivityViewDock.setKeysCaptured(false);
		};
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

// The View with keyboard capture and its own focus ring. The band harness mounts it into the dock as well.
export const ActivityViewFrame = observer(function ActivityViewFrame({session}: {readonly session: ActivitySession}) {
	const {i18n} = useLingui();
	const keyboard = useKeyboardCapture(session.keyboardCaptured);
	const frameRef = useRef<HTMLElement>(null);
	const {View, name} = getActivityDefinition(session.activityId);
	return (
		<section
			ref={frameRef}
			className={styles.frame}
			tabIndex={-1}
			aria-label={i18n._(name)}
			onFocus={keyboard.onFocus}
			onBlur={keyboard.onBlur}
			onKeyDown={keyboard.onKey}
			onKeyUp={keyboard.onKey}
			data-flx="activities.activity-view-root.frame"
		>
			{/* The app's focus ring is drawn inside its own container; the View lives outside it, so it brings its own. */}
			<FocusRingScope containerRef={frameRef} data-flx="activities.activity-view-root.focus-ring-scope">
				<Suspense fallback={<Spinner data-flx="activities.activity-view-root.spinner" />}>
					<View key={session.sessionId} session={session} data-flx="activities.activity-view-root.view" />
				</Suspense>
			</FocusRingScope>
		</section>
	);
});

// Mounted once at the app root. The View renders here for as long as I take part, whether its place is the call's
// tile, the expanded stage, the mini window or none (parked, still playing); the dock moves it between them.
export const ActivityViewRoot = observer(function ActivityViewRoot() {
	const mountedRef = useRef<ActivitySession | null>(null);
	const session = mountedActivitySession(mountedRef.current);
	mountedRef.current = session;
	if (!session) return null;
	return createPortal(
		<ActivityViewFrame key={session.sessionId} session={session} data-flx="activities.activity-view-root.view-frame" />,
		ActivityViewDock.host,
	);
});
