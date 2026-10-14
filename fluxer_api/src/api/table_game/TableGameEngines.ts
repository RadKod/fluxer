// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChessGame} from '@app/api/table_game/engine/chess/ChessGame';
import {Dama} from '@app/api/table_game/engine/dama/Dama';
import {DamaNormal} from '@app/api/table_game/engine/dama/DamaNormal';
import {ClassicOkey} from '@app/api/table_game/engine/okey/ClassicOkey';
import {Okey101} from '@app/api/table_game/engine/okey/Okey101';
import type {TableGameEngine} from '@app/api/table_game/engine/TableGameEngine';
import {Tavla} from '@app/api/table_game/engine/tavla/Tavla';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Engine states are plain JSON (they live in the table's KV envelope); the service only hands them back to their engine.
export type TableGameEngineRegistry = Readonly<Record<TableGameKind, TableGameEngine<unknown>>>;

export const TABLE_GAME_ENGINES: TableGameEngineRegistry = {
	okey: ClassicOkey as TableGameEngine<unknown>,
	okey101: Okey101 as TableGameEngine<unknown>,
	chess: ChessGame as TableGameEngine<unknown>,
	dama: Dama as TableGameEngine<unknown>,
	dama_normal: DamaNormal as TableGameEngine<unknown>,
	tavla: Tavla as TableGameEngine<unknown>,
};
