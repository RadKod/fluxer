// SPDX-License-Identifier: AGPL-3.0-or-later

import {SoundType} from '@app/features/notification/utils/SoundUtils';
import TableGames from '@app/features/table_game/state/TableGames';
import {chessSideToMove, tableDeadlineAt} from '@app/features/table_game/utils/TableGameDeadline';
import * as SoundCommands from '@app/features/ui/commands/SoundCommands';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	TableGameAction,
	TableGameKind,
	TableGameResult,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {reaction} from 'mobx';

export {TABLE_GAME_SOUND_TYPES} from '@app/features/table_game/sound/TableGameSoundFiles';

type Position = 1 | 2 | 3 | 4;
type GameView = NonNullable<TableGameView['game_view']>;

const TIME_LOW_MS = 5_000;

function chessTurn(view: ChessView): Position {
	if (chessSideToMove(view.fen) === 'white') return view.white;
	return view.white === 1 ? 3 : 1;
}

// The position to move; null when no one is (or the kind is unknown to this build).
function turnOf(view: GameView): number | null {
	switch (view.game) {
		case 'chess':
			return chessTurn(view);
		case 'okey':
		case 'okey101':
		case 'dama':
		case 'dama_normal':
		case 'tavla':
			return view.turn;
		default:
			return null;
	}
}

function viewerOf(view: TableGameView): Position | null {
	const position = view.viewer_position;
	return position === 1 || position === 2 || position === 3 || position === 4 ? position : null;
}

function isWin(result: TableGameResult | null, game: TableGameKind, me: Position): boolean {
	if (result?.kind === 'win') return result.winners.includes(me);
	// In a two-player game the other player's forfeit is my win; at a four-player table nobody wins it.
	return result?.kind === 'forfeit' && result.loser !== me && TABLE_GAME_POSITIONS[game]?.length === 2;
}

function startSound(view: GameView, me: Position | null): SoundType | null {
	if (view.game === 'okey' || view.game === 'okey101') return SoundType.TableGameShuffle;
	if (view.game === 'tavla') return SoundType.TableGameTavlaDice;
	return me !== null && turnOf(view) === me ? SoundType.TableGameYourTurn : null;
}

function pieceCount(fen: string): number {
	return (fen.split(' ')[0] ?? '').replace(/[^a-zA-Z]/g, '').length;
}

function sameMoves(a: TavlaView['last_moves'], b: TavlaView['last_moves']): boolean {
	return a.length === b.length && a.every((move, i) => move.from === b[i]?.from && move.to === b[i]?.to);
}

function tavlaSound(before: TavlaView, after: TavlaView, me: Position | null): SoundType | null {
	if (after.bar.white > before.bar.white || after.bar.black > before.bar.black) return SoundType.TableGameTavlaHit;
	if (after.off.white > before.off.white || after.off.black > before.off.black) return SoundType.TableGameTavlaBearOff;
	const moved = after.last_moves.length > 0 && !sameMoves(before.last_moves, after.last_moves);
	// A roll is new when the turn or the moves changed, not the faces: equal dice twice in a row still roll.
	const rolled = after.dice !== null && (after.turn !== before.turn || !sameMoves(before.last_moves, after.last_moves));
	// One update carries the mover's checkers and the next player's roll: that player hears the dice, others the checkers.
	if (rolled && (after.turn === me || !moved)) return SoundType.TableGameTavlaDice;
	return moved ? SoundType.TableGameTavlaChecker : null;
}

function meldTiles(view: GameView): number {
	return view.game === 'okey101' ? view.melds.reduce((sum, meld) => sum + meld.tiles.length, 0) : 0;
}

function discardCount(view: {discards: ReadonlyArray<ReadonlyArray<string>>}): number {
	return view.discards.reduce((sum, pile) => sum + pile.length, 0);
}

// Everything above "your turn" but below the end, in the order of
// check > capture/hit/bear-off > meld > move/discard/draw.
function moveSound(before: GameView, after: GameView, me: Position | null): SoundType | null {
	switch (after.game) {
		case 'chess':
			if (before.game !== 'chess' || after.fen === before.fen) return null;
			if (after.in_check) return SoundType.TableGameChessCheck;
			return pieceCount(after.fen) < pieceCount(before.fen)
				? SoundType.TableGameChessCapture
				: SoundType.TableGameChessMove;
		case 'dama':
		case 'dama_normal':
			if ((before.game !== 'dama' && before.game !== 'dama_normal') || after.board === before.board) return null;
			return after.last_captured.length > 0 ? SoundType.TableGameDamaCapture : SoundType.TableGameDamaMove;
		case 'tavla':
			return before.game === 'tavla' ? tavlaSound(before, after, me) : null;
		case 'okey':
		case 'okey101':
			if (before.game !== 'okey' && before.game !== 'okey101') return null;
			if (meldTiles(after) > meldTiles(before)) return SoundType.TableGameMeldOpen;
			if (discardCount(after) > discardCount(before)) return SoundType.TableGameTileDiscard;
			if (after.pile_count < before.pile_count) return SoundType.TableGameTileDraw;
			if (after.discards.some((pile, i) => pile.length < (before.discards[i]?.length ?? 0)))
				return SoundType.TableGameTilePick;
			return null;
		default:
			return null;
	}
}

// Pure: the one sound a table update plays for `me`, or null.
// Order: won/ended > check > capture/hit/bear-off > meld > move/discard/draw > your turn.
// `own`: the update is the echo of my accepted action, which sounds by itself (holdOwnActionEcho).
export function tableGameSoundFor(
	prev: TableGameView | null,
	next: TableGameView,
	me: Position | null,
	own = false,
): SoundType | null {
	if (!prev || prev.summary.game !== next.summary.game || next.summary.version <= prev.summary.version) return null;
	if (next.summary.status === 'ended') {
		if (prev.summary.status === 'ended') return null;
		return me !== null && isWin(next.summary.result, next.summary.game, me)
			? SoundType.TableGameWon
			: SoundType.TableGameEnded;
	}
	const before = prev.game_view;
	const after = next.game_view;
	if (!after) return null;
	if (!before) return startSound(after, me);
	// My echo adds only a roll that came straight back to me (the opponent had no play).
	if (own) return after.game === 'tavla' && me !== null && after.turn === me ? SoundType.TableGameTavlaDice : null;
	return moveSound(before, after, me) ?? (me !== null && turnOf(after) === me ? SoundType.TableGameYourTurn : null);
}

// The sound of my own action once the server takes it.
export function actionSound(_game: TableGameKind, action: TableGameAction): SoundType | null {
	switch (action.type) {
		case 'draw':
			return action.from === 'pile' ? SoundType.TableGameTileDraw : SoundType.TableGameTilePick;
		case 'discard':
			return SoundType.TableGameTileDiscard;
		case 'finish':
			return SoundType.TableGameOkeyFinish;
		case 'meld':
			return SoundType.TableGameMeldOpen;
		case 'take_discard':
			return action.open?.length || action.add?.length ? SoundType.TableGameMeldOpen : SoundType.TableGameTilePick;
		case 'move':
			return SoundType.TableGameChessMove;
		case 'dama_move':
			return SoundType.TableGameDamaMove;
		case 'tavla_move':
			return action.moves.some((move) => move.to === 'off')
				? SoundType.TableGameTavlaBearOff
				: SoundType.TableGameTavlaChecker;
		default:
			return null;
	}
}

// Local rack arranging and dragging.
export function playTableUiSound(type: SoundType): void {
	SoundCommands.playSound(type);
}

interface OwnAction {
	readonly from: number;
	echo: SoundType | null;
	other: SoundType | null;
}

// My action on its way, per table: the version it left from, and what the update leaving that version plays, held
// until the server answers. Only my own action is held; any other change on my turn plays as it comes.
const ownActions = new Map<string, OwnAction>();

// act(): returns the step to call with the answer. Accepted: my action's sound, then what its echo adds. Refused:
// nothing of mine, only a held update, which was someone else's change (a timeout move that beat mine).
export function holdOwnActionEcho(
	channelId: string,
	slot: string,
	from: number,
	sound: SoundType,
): (accepted: boolean) => void {
	const key = `${channelId}:${slot}`;
	const own: OwnAction = {from, echo: null, other: null};
	ownActions.set(key, own);
	return (accepted) => {
		if (ownActions.get(key) === own) ownActions.delete(key);
		for (const type of accepted ? [sound, own.echo] : [own.other]) if (type) SoundCommands.playSound(type);
	};
}

function isMyTurn(view: TableGameView): boolean {
	const me = viewerOf(view);
	return me !== null && view.game_view !== null && turnOf(view.game_view) === me;
}

// The deadline each table already warned about: one "time running out" a turn.
const warnedDeadlines = new Map<string, number>();

// Plays a focused table's update sounds and, on my turn, "time running out" 5 s before the deadline (the
// table deadline and one timer; it lives here so every focus holder — panel, seat view — gets it).
function watchTable(channelId: string, slot: string): () => void {
	const key = `${channelId}:${slot}`;
	let previous = TableGames.getView(channelId, slot);
	const stopSounds = reaction(
		() => TableGames.getView(channelId, slot),
		(next) => {
			const prev = previous;
			previous = next;
			if (!next) return;
			const me = viewerOf(next);
			const own = ownActions.get(key);
			if (own && prev?.summary.version === own.from && next.summary.version > own.from) {
				own.echo = tableGameSoundFor(prev, next, me, true);
				own.other = tableGameSoundFor(prev, next, me);
				return;
			}
			const sound = tableGameSoundFor(prev, next, me);
			if (sound) SoundCommands.playSound(sound);
		},
	);
	let timer: ReturnType<typeof setTimeout> | null = null;
	const stopTimer = reaction(
		() => {
			const view = TableGames.getView(channelId, slot);
			return view && isMyTurn(view) ? tableDeadlineAt(view) : null;
		},
		(deadline) => {
			if (timer) clearTimeout(timer);
			timer = null;
			if (deadline === null || deadline <= Date.now() || warnedDeadlines.get(key) === deadline) return;
			timer = setTimeout(
				() => {
					timer = null;
					warnedDeadlines.set(key, deadline);
					SoundCommands.playSound(SoundType.TableGameTimeLow);
				},
				Math.max(0, deadline - TIME_LOW_MS - Date.now()),
			);
		},
		{fireImmediately: true},
	);
	return () => {
		stopSounds();
		stopTimer();
		if (timer) clearTimeout(timer);
	};
}

// Focus holders per table (the panel and the seat view may hold it at once) and the table's watcher while any does.
const focusCounts = new Map<string, number>();
const watchers = new Map<string, () => void>();

// A table is focused while its panel is open or I sit at it in the seat view; only a focused table plays.
export function setTableSoundFocus(channelId: string, slot: string, focused: boolean): void {
	const key = `${channelId}:${slot}`;
	const count = Math.max(0, (focusCounts.get(key) ?? 0) + (focused ? 1 : -1));
	if (count > 0) {
		focusCounts.set(key, count);
		if (!watchers.has(key)) watchers.set(key, watchTable(channelId, slot));
		return;
	}
	focusCounts.delete(key);
	watchers.get(key)?.();
	watchers.delete(key);
}
