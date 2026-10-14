// SPDX-License-Identifier: AGPL-3.0-or-later

import {takeVoiceSeat} from '@app/features/voice_scene/commands/VoiceSeatCommands';
import {useEffect, useRef} from 'react';

// Times after the room opens. The join webhook seats people; it can drop, so the client asks for "any seat".
export const SEAT_FALLBACK_DELAYS_MS = [3000, 10000, 30000] as const;

// Tries only while none of my identities holds a seat and a lounge seat is free (a full room sends nothing),
// at most three times per connection (a reload's new identity also gets its seat back this way).
export function useSeatFallback({
	channelId,
	connectionId,
	seated,
	hasFreeSeat,
}: {
	channelId: string;
	connectionId: string | null;
	seated: boolean;
	hasFreeSeat: boolean;
}): void {
	const latest = useRef({seated, hasFreeSeat});
	latest.current = {seated, hasFreeSeat};
	useEffect(() => {
		if (!connectionId) return;
		const timers = SEAT_FALLBACK_DELAYS_MS.map((delay) =>
			setTimeout(() => {
				if (latest.current.seated || !latest.current.hasFreeSeat) {
					for (const timer of timers) clearTimeout(timer);
					return;
				}
				void takeVoiceSeat(channelId, null);
			}, delay),
		);
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [channelId, connectionId]);
}
