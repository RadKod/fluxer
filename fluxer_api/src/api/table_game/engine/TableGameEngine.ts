// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Rng} from '@app/api/table_game/engine/Rng';
import type {
	TableGameAction,
	TableGameKind,
	TableGameResult,
	TableGameRuleReason,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

export type {Rng} from '@app/api/table_game/engine/Rng';
export {CryptoRng} from '@app/api/table_game/engine/Rng';

export type TablePosition = 1 | 2 | 3 | 4;

// In chess turnMs is each player's whole clock.
export interface EngineClock {
	now: number;
	turnMs: number;
}

export class TableGameRuleError extends Error {
	constructor(readonly reason: TableGameRuleReason) {
		super(reason);
		this.name = 'TableGameRuleError';
	}
}

export interface TableGameEngine<S> {
	readonly kind: TableGameKind;
	readonly positions: ReadonlyArray<TablePosition>;
	start(positions: ReadonlyArray<TablePosition>, rng: Rng, clock: EngineClock): S;
	// Pure: never mutates `state`; throws TableGameRuleError on a rule violation.
	apply(state: S, actor: TablePosition, action: TableGameAction, rng: Rng, clock: EngineClock): S;
	// The caller has checked deadline(state) <= clock.now: auto move or loss on time.
	onDeadline(state: S, rng: Rng, clock: EngineClock): S;
	forfeit(state: S, loser: TablePosition, reason: 'leave' | 'disconnect'): S;
	cancel(state: S, reason: 'disabled' | 'theme_changed' | 'abandoned'): S;
	deadline(state: S): number | null;
	result(state: S): TableGameResult | null;
	// The only path from state to a client: other players' racks and the deck order never leave here.
	view(state: S, viewer: TablePosition | null): TableGameView['game_view'];
}
