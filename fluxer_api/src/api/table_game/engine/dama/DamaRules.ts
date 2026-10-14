// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DamaRuleSet} from '@app/api/table_game/engine/dama/DamaCore';

// Default Dama rules.
// Changing a rule is changing a constant here plus its test; the move generator reads only these flags.
export const DAMA_RULES: DamaRuleSet = {
	orthogonal: true,
	menCaptureBackward: false,
	flyingKings: true,
	majorityCapture: true,
	removeCaptured: 'immediately',
	promoteMidCapture: 'continue_as_man', // TD1 (a)
	loneKingsDraw: true, // TD4
	threefoldDraw: true, // TD5
	quietMoveLimit: 25, // TD6, full moves
	whiteStarts: true, // TD7
};

// CD1: Brazilian draughts, the international rules on an 8×8 board.
export const DAMA_NORMAL_RULES: DamaRuleSet = {
	orthogonal: false,
	menCaptureBackward: true,
	flyingKings: true,
	majorityCapture: true,
	removeCaptured: 'after_move',
	promoteMidCapture: 'continue_as_man',
	loneKingsDraw: false,
	threefoldDraw: true, // CD3
	quietMoveLimit: 25, // CD4, full moves
	whiteStarts: true,
};
