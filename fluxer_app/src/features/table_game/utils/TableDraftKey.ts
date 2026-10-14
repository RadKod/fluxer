// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// What a local draft (101 staging, a taken side tile, tavla steps, a dama path choice, a chess promotion, a selection)
// was made on: the game's move identity, not the table version. The version also moves on writes that change no game
// state, such as the server's minute presence check. A move, a new turn (its clock) or the end changes the key;
// the same position at a newer version does not.
export function tableDraftKey(view: TableGameView): string {
	const status = view.summary.status;
	const game = view.game_view;
	switch (game?.game) {
		case 'okey':
		case 'okey101':
			return JSON.stringify([status, game.turn, game.deadline_at, game.rack, game.discards, game.pile_count]);
		case 'tavla':
			return JSON.stringify([
				status,
				game.turn,
				game.deadline_at,
				game.dice,
				game.points,
				game.bar,
				game.off,
				game.last_moves,
			]);
		case 'dama':
		case 'dama_normal':
			return JSON.stringify([status, game.turn, game.turn_started_at, game.board]);
		case 'chess':
			return JSON.stringify([status, game.turn_started_at, game.fen]);
		default:
			// The lobby, or a kind this build does not know: no drafts here.
			return JSON.stringify([status, view.summary.version]);
	}
}
