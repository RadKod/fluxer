// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {useEffect, useState} from 'react';

const TICK_MS = 250;

// The leader clock, re-read a few times a second for countdowns.
export function useBandNow(session: ActivitySession): number {
	const [now, setNow] = useState(() => session.clock.now());
	useEffect(() => {
		const interval = setInterval(() => setNow(session.clock.now()), TICK_MS);
		return () => clearInterval(interval);
	}, [session]);
	return now;
}

export function secondsUntil(endsAt: number, now: number): number {
	return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function formatSongLength(lengthMs: number): string {
	const totalSeconds = Math.round(lengthMs / 1000);
	return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
