// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TableGameOutcome} from '@app/features/table_game/commands/TableGameCommands';
import type {
	TableGameKind,
	TableGameRuleReason,
	TableGameSpeed,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const TABLE_GAME_NAME_DESCRIPTORS: Record<TableGameKind, MessageDescriptor> = {
	okey: msg({message: 'Okey', comment: 'Table games: name of the classic Okey tile game.'}),
	okey101: msg({message: '101 Okey', comment: 'Table games: name of the 101 Okey tile game.'}),
	chess: msg({message: 'Chess', comment: 'Table games: name of chess.'}),
	dama: msg({
		message: 'Turkish Draughts',
		comment: 'Table games: name of Turkish draughts (Türk daması): men move straight, kings fly along lines.',
	}),
	dama_normal: msg({
		message: 'Draughts',
		comment: 'Table games: name of diagonal 8×8 draughts with Brazilian rules (Normal dama).',
	}),
	tavla: msg({message: 'Backgammon', comment: 'Table games: name of backgammon (Tavla).'}),
};

export const TABLE_GAME_SPEED_DESCRIPTORS: Record<TableGameSpeed, MessageDescriptor> = {
	fast: msg({message: 'Fast', comment: 'Table games: the quickest move time a table can use.'}),
	normal: msg({message: 'Normal', comment: 'Table games: the standard move time.'}),
	slow: msg({message: 'Slow', comment: 'Table games: the longest move time.'}),
};

export const SECONDS_PER_TURN_DESCRIPTOR = msg({
	message: '{seconds} s per turn',
	comment: 'Table games: time each player has for one turn in Okey or Backgammon. {seconds} is a number of seconds.',
});
export const MINUTES_PER_PLAYER_DESCRIPTOR = msg({
	message: '{minutes} min per player',
	comment: 'Table games: total chess or draughts clock of each player. {minutes} is a number of minutes.',
});

export const UPDATE_APP_DESCRIPTOR = msg({
	message: 'Update the app to play this game.',
	comment: 'Table games: a newer version of the app set up this table with a game this version does not know.',
});

export const TABLE_SLOT_DESCRIPTOR = msg({
	message: 'Table {number}',
	comment: 'Table games: name of a table in the 3D room. {number} is 1, 2, 3...',
});

const RULE_DESCRIPTORS: Record<TableGameRuleReason, MessageDescriptor> = {
	not_your_turn: msg({message: 'It is not your turn.', comment: 'Table games: move refused.'}),
	wrong_phase: msg({message: 'You cannot do that now.', comment: 'Table games: move refused, wrong step of the turn.'}),
	tile_not_in_rack: msg({message: 'That tile is not in your rack.', comment: 'Table games: Okey move refused.'}),
	invalid_meld: msg({message: 'Those tiles do not make a valid set.', comment: 'Table games: Okey move refused.'}),
	open_too_low: msg({
		message: 'Your sets must add up to at least 101 to open.',
		comment: 'Table games: 101 Okey opening refused.',
	}),
	pairs_too_few: msg({
		message: 'You need at least 5 pairs to open.',
		comment: 'Table games: 101 Okey opening refused.',
	}),
	take_unused: msg({
		message: 'Use the tile you took from the side in a set.',
		comment: 'Table games: 101 Okey, a tile taken from the discard must be used at once.',
	}),
	not_opened: msg({message: 'Open first, then add to sets.', comment: 'Table games: 101 Okey move refused.'}),
	cannot_add: msg({message: 'That tile does not fit that set.', comment: 'Table games: 101 Okey move refused.'}),
	illegal_move: msg({message: 'That move is not allowed.', comment: 'Table games: chess move refused.'}),
	game_over: msg({message: 'The game is over.', comment: 'Table games: move refused after the end.'}),
	unsupported_action: msg({message: 'This game has no such move.', comment: 'Table games: move refused.'}),
	must_finish_with_discard: msg({
		message: 'Finish by discarding your last tile.',
		comment: 'Table games: Okey, finishing needs a discard.',
	}),
};

const CONFLICT_DESCRIPTOR = msg({
	message: 'The table changed in the meantime. Look again and retry.',
	comment: 'Table games: request refused because the table moved on (stale version, seat taken, already at a table).',
});
export const NOT_IN_VOICE_DESCRIPTOR = msg({
	message: 'Join the voice channel to play.',
	comment: 'Table games: only people in this voice channel can play or watch.',
});
const DISABLED_DESCRIPTOR = msg({
	message: 'Table games are turned off right now.',
	comment: 'Table games: the feature switch is off.',
});
const UNKNOWN_TABLE_DESCRIPTOR = msg({
	message: 'This table is gone.',
	comment: 'Table games: the table no longer exists.',
});
const FAILED_DESCRIPTOR = msg({
	message: 'Could not reach the table. Try again.',
	comment: 'Table games: network or server failure.',
});

export function tableGameOutcomeDescriptor(outcome: TableGameOutcome): MessageDescriptor | null {
	if (outcome.ok) return null;
	switch (outcome.error) {
		case 'rule':
			return outcome.reason ? RULE_DESCRIPTORS[outcome.reason] : RULE_DESCRIPTORS.unsupported_action;
		case 'conflict':
			return CONFLICT_DESCRIPTOR;
		case 'not_in_voice':
			return NOT_IN_VOICE_DESCRIPTOR;
		case 'disabled':
			return DISABLED_DESCRIPTOR;
		case 'unknown_table':
			return UNKNOWN_TABLE_DESCRIPTOR;
		case 'failed':
			return FAILED_DESCRIPTOR;
	}
}
