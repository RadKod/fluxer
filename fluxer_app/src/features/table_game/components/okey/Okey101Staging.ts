// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// 101 moves waiting for the "Aç / İşle" button (2D and 3D share it): a tile taken from the discard, sets to open
// and tiles to add to sets on the table; sent as one meld or take_discard action. No stage is null ("İptal").
export interface OkeyStage {
	take: string | null;
	open: Array<Array<string>>;
	add: Array<{meld_id: number; tiles: Array<string>; at: 'start' | 'end'}>;
}

export type OkeyStageAction = Extract<TableGameAction, {type: 'meld' | 'take_discard'}>;

// Every tile the stage holds once (the taken tile also sits in the set it completes).
export function stagedTiles(stage: OkeyStage | null): Array<string> {
	if (!stage) return [];
	const tiles = [...(stage.take ? [stage.take] : []), ...stage.open.flat(), ...stage.add.flatMap((add) => add.tiles)];
	return [...new Set(tiles)];
}

// A taken tile must be used in the same request, so a stage holding one goes out as take_discard.
export function stageToAction(stage: OkeyStage): OkeyStageAction {
	return {
		type: stage.take ? 'take_discard' : 'meld',
		...(stage.open.length > 0 ? {open: stage.open} : {}),
		...(stage.add.length > 0 ? {add: stage.add} : {}),
	};
}
