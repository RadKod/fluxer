// SPDX-License-Identifier: AGPL-3.0-or-later

import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import TableGames from '@app/features/table_game/state/TableGames';
import {TABLE_GAME_TICK_DELAY_MS, TABLE_GAME_TICK_JITTER_MS} from '@app/features/table_game/state/TableGameTiming';
import {tableDeadlineAt} from '@app/features/table_game/utils/TableGameDeadline';
import {reaction} from 'mobx';
import {useEffect} from 'react';

// Table key -> the version already nudged, shared by every mounted copy of the hook so a table is nudged once.
const tickedVersions = new Map<string, number>();

// A player's client tells the server a turn deadline has passed, once per table version. Spectators never do;
// the server's cron settles abandoned tables.
export function useTableDeadlineTick(channelId: string, slot: string): void {
	useEffect(() => {
		const key = `${channelId}:${slot}`;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const dispose = reaction(
			() => {
				const view = TableGames.getView(channelId, slot);
				if (!view || view.viewer_position === null) return null;
				const deadline = tableDeadlineAt(view);
				return deadline === null ? null : `${view.summary.version}|${deadline}`;
			},
			(due) => {
				if (timer) clearTimeout(timer);
				timer = null;
				if (!due) return;
				const [version, deadline] = due.split('|').map(Number) as [number, number];
				if (tickedVersions.get(key) === version) return;
				const wait = deadline + TABLE_GAME_TICK_DELAY_MS + Math.random() * TABLE_GAME_TICK_JITTER_MS - Date.now();
				timer = setTimeout(
					() => {
						timer = null;
						if (tickedVersions.get(key) === version) return;
						tickedVersions.set(key, version);
						void TableGameCommands.tick(channelId, slot);
					},
					Math.max(0, wait),
				);
			},
			{fireImmediately: true},
		);
		return () => {
			dispose();
			if (timer) clearTimeout(timer);
		};
	}, [channelId, slot]);
}

export function resetTableDeadlineTicksForTests(): void {
	tickedVersions.clear();
}
