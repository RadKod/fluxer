// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TableGameOutcome} from '@app/features/table_game/commands/TableGameCommands';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import TableGames from '@app/features/table_game/state/TableGames';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {i18n} from '@lingui/core';
import {useEffect} from 'react';

// a network or server failure is tried once more after this long; a refusal stands and is told at once.
export const SPECTATE_RETRY_MS = 2000;

// a watch seat is the existing spectator watch, chosen by sitting there. While I sit beside a table
// that is set up and I do not play at it, I spectate it (≤ 50 live, polling past that; my rack is null like any
// spectator's); joining it as a player, its end or standing up lets the watch go, once. A watch I started by hand
// is not mine to stop. A watch that cannot start is told; letting it go is local first and cannot fail here
// (TableGameCommands.unspectate). Call from an observer: the table summary is read while rendering.
export function useWatchSeatSpectate({
	channelId,
	watchSlot,
	userId,
}: {
	channelId: string;
	watchSlot: string | null;
	userId: string | null;
}): void {
	const summary = watchSlot ? TableGames.getSummary(channelId, watchSlot) : null;
	const watching =
		summary !== null && summary.status !== 'ended' && !summary.players.some((player) => player.user_id === userId);
	const slot = watching ? watchSlot : null;
	useEffect(() => {
		if (!slot || TableGames.getWatchMode(channelId, slot) !== null) return;
		let left = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const tell = (outcome: TableGameOutcome): void => {
			const descriptor = tableGameOutcomeDescriptor(outcome);
			if (!left && descriptor) ToastCommands.createToast({type: 'error', children: i18n._(descriptor)});
		};
		// A watch that lands after I stood up is let go at once: the cleanup's unspectate went out before it.
		void TableGameCommands.spectate(channelId, slot).then((outcome) => {
			if (left && outcome.ok) void TableGameCommands.unspectate(channelId, slot);
			if (left || outcome.ok) return;
			if (outcome.error !== 'failed') {
				tell(outcome);
				return;
			}
			retry = setTimeout(
				() =>
					void TableGameCommands.spectate(channelId, slot).then((retried) => {
						if (left && retried.ok) void TableGameCommands.unspectate(channelId, slot);
						tell(retried);
					}),
				SPECTATE_RETRY_MS,
			);
		});
		return () => {
			left = true;
			clearTimeout(retry);
			void TableGameCommands.unspectate(channelId, slot);
		};
	}, [channelId, slot]);
}
