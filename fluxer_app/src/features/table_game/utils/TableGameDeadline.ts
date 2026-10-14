// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DamaNormalView, DamaView, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

export function chessSideToMove(fen: string): 'white' | 'black' {
	return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

// Read from the view's turn, never derived from the board; null once the game is over.
export function damaSideToMove(view: DamaView | DamaNormalView): 'white' | 'black' | null {
	if (view.turn === null) return null;
	return view.turn === view.white ? 'white' : 'black';
}

// When the player to move runs out of time: okey, 101 and tavla send it; chess and both damas run the mover's own clock.
export function tableDeadlineAt(view: TableGameView): number | null {
	const gameView = view.game_view;
	if (!gameView || view.summary.status !== 'playing') return null;
	switch (gameView.game) {
		case 'chess':
			if (!gameView.turn_started_at) return null;
			return Date.parse(gameView.turn_started_at) + gameView.clocks_ms[chessSideToMove(gameView.fen)];
		case 'dama':
		case 'dama_normal': {
			const side = damaSideToMove(gameView);
			if (!gameView.turn_started_at || side === null) return null;
			return Date.parse(gameView.turn_started_at) + gameView.clocks_ms[side];
		}
		default:
			// Okey, 101, tavla; an unknown kind  carries no deadline_at and gets none.
			return gameView.deadline_at ? Date.parse(gameView.deadline_at) : null;
	}
}
