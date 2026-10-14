// SPDX-License-Identifier: AGPL-3.0-or-later

// 101 Okey, one hand, singles.
// MIX_SETS_AND_PAIRS_ON_OPEN and TAKE_OKEY_FROM_TABLE record decisions the engine hard-wires: no action
// exists for the other side. ACE_AFTER_KING_POINTS covers the 1 of a 12-13-1 run;
// 1 matches the Classic Okey run value.
export const OKEY101_RULES = {
	DEAL_SIZE: 21, // the starter gets 22
	OPEN_MIN_POINTS: 101, // opening with runs/groups
	OPEN_MIN_PAIRS: 5, // opening with pairs
	MIX_SETS_AND_PAIRS_ON_OPEN: false,
	ADD_ON_OPEN_TURN: false, // adding to melds starts on the turn after the opening
	PAIR_OPENER_MAY_ADD: true, // a pair opener may add to the melds on the table
	TAKE_DISCARD_REQUIRES_USE: true, // a taken discard must be opened or added in the same action
	DISCARD_OKEY_PENALTY: 101, // unless it is the finishing tile
	DISCARD_PLAYABLE_PENALTY: 101, // throwing a tile that a meld on the table could take
	WINNER_SCORE: -101,
	UNOPENED_SCORE: 202,
	OKEY_IN_HAND_VALUE: 101,
	PAIR_OPENER_MULTIPLIER: 2,
	OKEY_FINISH_MULTIPLIER: 2,
	HAND_FINISH_MULTIPLIER: 2, // opening and finishing in the same turn without an earlier opening ("elden")
	TAKE_OKEY_FROM_TABLE: false, // no swapping a real tile for an okey lying in a meld
	ACE_AFTER_KING_POINTS: 1, // what the 1 closing 12-13-1 is worth in an opening
} as const;
