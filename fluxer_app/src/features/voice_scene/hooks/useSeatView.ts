// SPDX-License-Identifier: AGPL-3.0-or-later

import TableGames from '@app/features/table_game/state/TableGames';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import type {SeatViewTarget, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSeatView from '@app/features/voice_scene/state/VoiceSceneSeatView';
import {isKnownTableGameKind} from '@fluxer/constants/src/TableGameConstants';
import {useEffect, useMemo, useRef} from 'react';

// A window resize is followed once it stops: the seat pose is worked out again for the new aspect (short tween).
const RESIZE_SETTLE_MS = 150;

// Spec 1: sitting at a table (player seat) or beside one (watch seat) in the room turns the camera to that seat;
// "Back to room" (any way out of the seat mode) keeps the seat and shows the room, "Back to table" turns back,
// leaving the seat returns to the room. `available` is false where the room cannot show a seat view.
// Returns the seat view on screen, or null. Call from an observer: the table's game is read while rendering.
export function useSeatView({
	handle,
	channelId,
	seatName,
	available,
	container,
}: {
	handle: VoiceSceneHandle;
	channelId: string;
	seatName: string | null;
	available: boolean;
	container: HTMLElement | null;
}): SeatViewTarget | null {
	const seat = available && seatName ? handle.layout.seats.find((entry) => entry.name === seatName) : undefined;
	const slot = seat?.table?.slot ?? seat?.watch?.slot ?? null;
	const game = slot ? (TableGames.getSummary(channelId, slot)?.game ?? null) : null;
	// a kind a newer build set up has no seats or pose here; the room view stays as it is.
	const known = game === null || isKnownTableGameKind(game);
	const target = useMemo<SeatViewTarget | null>(
		() => (seat && slot && known ? {seat, slot, game, role: seat.table ? 'player' : 'watch'} : null),
		[seat, slot, game, known],
	);

	useEffect(() => {
		VoiceSceneSeatView.setSeat(target ? {channelId, slot: target.slot, seat: target.seat.name} : null);
	}, [channelId, target]);
	useEffect(() => () => VoiceSceneSeatView.setSeat(null), []);

	const active =
		target && VoiceSceneSeatView.viewing && VoiceSceneSeatView.seat?.seat === target.seat.name ? target : null;

	const wasActive = useRef(false);
	useEffect(() => {
		// Spec 3: the flat panel steps aside when the seat view starts (its "Table panel" button brings it back).
		// The key is TableGamesEntry's scene popout key for this table.
		if (active && !wasActive.current) PopoutCommands.close(`table-game-${channelId}-${active.slot}`);
		wasActive.current = active !== null;
		if (active) handle.enterSeatView(active);
		else if (handle.getCameraMode() === 'seat') handle.exitToOrbit();
	}, [handle, channelId, active]);

	useEffect(
		() =>
			handle.onCameraModeChange((mode) => {
				if (mode !== 'seat' && VoiceSceneSeatView.viewing) VoiceSceneSeatView.dismiss();
			}),
		[handle],
	);

	useEffect(() => {
		if (!active || !container) return;
		let aspect = container.clientHeight > 0 ? container.clientWidth / container.clientHeight : 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (!box || box.height <= 0) return;
			const next = box.width / box.height;
			if (Math.abs(next - aspect) < 1e-3) return;
			aspect = next;
			clearTimeout(timer);
			timer = setTimeout(() => handle.enterSeatView(active), RESIZE_SETTLE_MS);
		});
		observer.observe(container);
		return () => {
			observer.disconnect();
			clearTimeout(timer);
		};
	}, [handle, active, container]);

	return active;
}
