// SPDX-License-Identifier: AGPL-3.0-or-later

// Default Tavla rules. Turn lengths live in
// TABLE_GAME_TURN_MS.tavla.
export const TAVLA_RULES = {
	OPENING: 'reroll', // T1 (a): the opening winner rolls two fresh dice; 'use_opening_dice' is (b)
	MARS: true, // T2: a loser with nothing borne off loses a mars
	TRIPLE_MARS: false, // T3
	DOUBLING_CUBE: false, // T4 (no code; true would be its own task)
	MATCH_POINTS: 1, // T5: one game
	AUTO_MOVE_ORDER: 'farthest_first', // T7: a timeout plays legal_moves[0]
	MAX_CONSECUTIVE_TIMEOUTS: 2, // T7: the second one in a row loses
} as const;
