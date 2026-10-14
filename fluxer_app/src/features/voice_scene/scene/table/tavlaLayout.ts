// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TableDragSource, TableDropTarget, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_SIZE_M, SEAT_READABILITY_PROBES} from '@app/features/voice_scene/utils/SeatedView';
import {TAVLA_CHECKERS} from '@fluxer/constants/src/TableGameConstants';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Board-local frame of the GLB's tavla_board (contract rev 3): white's edge +Z, white's home 1–6 at its +X end,
// 1→12 along +Z towards −X, 13→24 along −Z towards +X. Point numbers are absolute everywhere.
// the board fills at most SeatedView's board outline (0.80 × 0.587 m) and its far checkers
// stay inside its probe box.
export const TAVLA_BOARD_SIZE_M = SEAT_READABILITY_PROBES.tavlaBoard;
export const TAVLA_STACK_VISIBLE = 5;
export const TAVLA_BAR_VISIBLE = 3;
// Opponent's turn replayed step by step; with a fresh roll alongside, both stay within the 400 ms animation limit.
export const TAVLA_REPLAY_MS = 360;
const CENTRE_CLEARANCE_M = 0.002;
const LAYER_LIFT_M = 0.0004; // overlapping checkers of one stack step up, never z-fight
const OFF_GAP_M = 0.0005;
const BADGE_LIFT_M = 0.014;
const ZONE_LIFT_M = 0.001;
const DICE_GAP_M = 0.015;
const REPLAY_HOP_M = 0.03;

// Spots: 0..23 are points 1..24, then each side's bar and borne-off tray.
export const BAR_WHITE = 24;
export const BAR_BLACK = 25;
export const OFF_WHITE = 26;
export const OFF_BLACK = 27;
const SPOT_COUNT = 28;

export interface TavlaChecker {
	white: boolean;
	ghost: boolean;
}
export type TavlaStacks = ReadonlyArray<ReadonlyArray<TavlaChecker>>;

// Raw numbers read from the parts file: board mesh bounds, tp_* empties, checker size (metres, board-local).
export interface TavlaBoardSource {
	boardMin: Vec3;
	boardMax: Vec3;
	points: ReadonlyArray<Vec3>;
	bar: {white: Vec3; black: Vec3};
	off: {white: Vec3; black: Vec3};
	checker: {diameter: number; height: number};
}

export interface TavlaBoardGeometry {
	// Board mesh: scale, and the raw base centre that lands on the table-top centre.
	scale: number;
	origin: Vec3;
	points: ReadonlyArray<Vec3>;
	bar: {white: Vec3; black: Vec3};
	off: {white: Vec3; black: Vec3};
	checker: {diameter: number; height: number};
	pointWidth: number;
	stackStep: number;
}

export interface TavlaRect {
	center: Vec3;
	width: number; // along X
	depth: number; // along Z
}

export interface TavlaLayout {
	// `top`: the topmost checker shown on its spot (the one a drag picks up).
	checkers: Array<{position: Vec3; white: boolean; ghost: boolean; standing: boolean; spot: number; top: boolean}>;
	badges: Array<{position: Vec3; count: number}>;
	// The top checker of each point (and of my bar); `area` is where a press picks it up.
	pickables: Array<{spot: number; source: TableDragSource; position: Vec3; white: boolean; area: TavlaRect}>;
	zones: Array<{target: TableDropTarget} & TavlaRect>;
}

export function tavlaBoardGeometry(source: TavlaBoardSource): TavlaBoardGeometry {
	const {boardMin, boardMax, checker} = source;
	const origin = {x: (boardMin.x + boardMax.x) / 2, y: boardMin.y, z: (boardMin.z + boardMax.z) / 2};
	const far = SEAT_READABILITY_PROBES.tavlaFarPoint;
	const reachX = Math.max(...source.points.map((p) => Math.abs(p.x - origin.x)));
	const reachZ = Math.max(...source.points.map((p) => Math.abs(p.z - origin.z)));
	const scale = Math.min(
		TAVLA_BOARD_SIZE_M.x / (boardMax.x - boardMin.x),
		TAVLA_BOARD_SIZE_M.z / (boardMax.z - boardMin.z),
		far.x / reachX,
		// The first checker sits a radius (at least the part's own, scaled) in from the point's base.
		Math.abs(far.z) / (reachZ - checker.diameter / 2),
	);
	// checkers grow with the board; SEAT_PIECE_SIZE_M stays their floor.
	const diameter = Math.max(SEAT_PIECE_SIZE_M.tavlaChecker, checker.diameter * scale);
	const at = (p: Vec3): Vec3 => ({
		x: (p.x - origin.x) * scale,
		y: (p.y - origin.y) * scale,
		z: (p.z - origin.z) * scale,
	});
	const points = source.points.map(at);
	const innerZ = Math.min(...points.map((p) => Math.abs(p.z)));
	return {
		scale,
		origin,
		points,
		bar: {white: at(source.bar.white), black: at(source.bar.black)},
		off: {white: at(source.off.white), black: at(source.off.black)},
		checker: {diameter, height: checker.height * (diameter / checker.diameter)},
		pointWidth: Math.abs(points[1]!.x - points[0]!.x),
		// Five checkers from the base to just short of the centre line; they overlap a little on a short board.
		stackStep: Math.min(diameter, (innerZ - diameter - CENTRE_CLEARANCE_M) / (TAVLA_STACK_VISIBLE - 1)),
	};
}

// White's edge faces white's seat; a watcher at the side keeps the long side across (SeatedView's probes).
export function tavlaBoardYaw(white: 1 | 3 | null, perspective: 1 | 2 | 3 | 4): number {
	return white !== null && (white - perspective + 4) % 4 === 2 ? Math.PI : 0;
}

const spotFrom = (from: number | 'bar', white: boolean) =>
	from === 'bar' ? (white ? BAR_WHITE : BAR_BLACK) : from - 1;
const spotTo = (to: number | 'off', white: boolean) => (to === 'off' ? (white ? OFF_WHITE : OFF_BLACK) : to - 1);
const visibleOn = (spot: number) =>
	spot < BAR_WHITE ? TAVLA_STACK_VISIBLE : spot < OFF_WHITE ? TAVLA_BAR_VISIBLE : TAVLA_CHECKERS;
// The slot the top checker is drawn in (an overfull stack shows its top in the last slot, under the badge).
const topSlot = (stacks: TavlaStacks, spot: number) => Math.min(stacks[spot]!.length, visibleOn(spot)) - 1;

// One step for `white`; a lone opponent checker on the landing point goes to its bar. null: no such checker to move.
function applyMove(stacks: Array<Array<TavlaChecker>>, white: boolean, move: TavlaStep, ghost: boolean) {
	const from = spotFrom(move.from, white);
	const to = spotTo(move.to, white);
	const top = stacks[from]!.at(-1);
	if (!top || top.white !== white) return null;
	stacks[from]!.pop();
	const landing = stacks[to]!;
	if (to < BAR_WHITE && landing.length === 1 && landing[0]!.white !== white) {
		const blot = landing.pop()!;
		stacks[white ? BAR_BLACK : BAR_WHITE]!.push({white: !white, ghost: ghost || blot.ghost});
	}
	landing.push({white, ghost: ghost || top.ghost});
	return {from, to};
}

// The server's board; my steps not sent yet move their checkers as ghosts (the view itself is never changed).
export function tavlaStacks(view: TavlaView | null, pending: ReadonlyArray<TavlaStep>): Array<Array<TavlaChecker>> {
	const stacks = Array.from({length: SPOT_COUNT}, () => [] as Array<TavlaChecker>);
	if (!view) return stacks;
	const fill = (spot: number, count: number, white: boolean) => {
		for (let i = 0; i < count; i++) stacks[spot]!.push({white, ghost: false});
	};
	view.points.forEach((count, index) => fill(index, Math.abs(count), count > 0));
	fill(BAR_WHITE, view.bar.white, true);
	fill(BAR_BLACK, view.bar.black, false);
	fill(OFF_WHITE, view.off.white, true);
	fill(OFF_BLACK, view.off.black, false);
	if (view.turn !== null) {
		const white = view.turn === view.white;
		for (const step of pending) applyMove(stacks, white, step, true);
	}
	return stacks;
}

// Base centre of the checker in `slot` of `spot`; borne-off checkers stand on edge in a row along their tray.
export function spotPosition(g: TavlaBoardGeometry, spot: number, slot: number): {position: Vec3; standing: boolean} {
	const radius = g.checker.diameter / 2;
	if (spot < OFF_WHITE) {
		const bar = spot >= BAR_WHITE;
		const base = bar ? (spot === BAR_WHITE ? g.bar.white : g.bar.black) : g.points[spot]!;
		// Points stack towards the centre line, a bar outwards towards its own side's edge.
		const direction = bar ? Math.sign(base.z) : -Math.sign(base.z);
		const step = bar ? g.checker.diameter : g.stackStep;
		const i = Math.min(slot, visibleOn(spot) - 1);
		return {
			position: {x: base.x, y: base.y + i * LAYER_LIFT_M, z: base.z + direction * (radius + i * step)},
			standing: false,
		};
	}
	const base = spot === OFF_WHITE ? g.off.white : g.off.black;
	const pitch = g.checker.height + OFF_GAP_M;
	return {
		position: {
			x: base.x,
			y: base.y + radius,
			z: base.z + Math.sign(base.z) * (slot - (TAVLA_CHECKERS - 1) / 2) * pitch,
		},
		standing: true,
	};
}

function pointRect(g: TavlaBoardGeometry, point: number): TavlaRect {
	const base = g.points[point - 1]!;
	return {center: {x: base.x, y: base.y + ZONE_LIFT_M, z: base.z / 2}, width: g.pointWidth, depth: Math.abs(base.z)};
}

export function tavlaLayout(
	g: TavlaBoardGeometry,
	stacks: TavlaStacks,
	viewerWhite: boolean,
	// A checker in flight: drawn here instead of its slot on top of `spot`.
	moving?: {spot: number; position: Vec3},
): TavlaLayout {
	const layout: TavlaLayout = {checkers: [], badges: [], pickables: [], zones: []};
	stacks.forEach((stack, spot) => {
		if (stack.length === 0) return;
		const visible = visibleOn(spot);
		const shown = stack.length > visible ? [...stack.slice(0, visible - 1), stack.at(-1)!] : stack;
		let top: Vec3 = {x: 0, y: 0, z: 0};
		shown.forEach((checker, slot) => {
			const at = spotPosition(g, spot, slot);
			const isTop = slot === shown.length - 1;
			const flying = isTop && moving?.spot === spot;
			top = at.position;
			layout.checkers.push({
				position: flying ? moving.position : at.position,
				white: checker.white,
				ghost: checker.ghost,
				standing: at.standing && !flying,
				spot,
				top: isTop,
			});
		});
		if (stack.length > visible)
			layout.badges.push({
				position: {x: top.x, y: top.y + g.checker.height + BADGE_LIFT_M, z: top.z},
				count: stack.length,
			});
		const mine = spot === (viewerWhite ? BAR_WHITE : BAR_BLACK);
		if (spot < BAR_WHITE || mine) {
			const base = spot < BAR_WHITE ? null : spot === BAR_WHITE ? g.bar.white : g.bar.black;
			const length = TAVLA_BAR_VISIBLE * g.checker.diameter;
			layout.pickables.push({
				spot,
				source: {kind: 'tavla_point', point: base ? 'bar' : spot + 1},
				position: top,
				white: stack.at(-1)!.white,
				area: base
					? {
							center: {x: base.x, y: base.y + ZONE_LIFT_M, z: base.z + (Math.sign(base.z) * length) / 2},
							width: g.checker.diameter,
							depth: length,
						}
					: pointRect(g, spot + 1),
			});
		}
	});
	for (let point = 1; point <= 24; point++)
		layout.zones.push({target: {kind: 'tavla_point', point}, ...pointRect(g, point)});
	const off = viewerWhite ? g.off.white : g.off.black;
	layout.zones.push({
		target: {kind: 'tavla_off'},
		center: {x: off.x, y: off.y + ZONE_LIFT_M, z: off.z},
		width: g.pointWidth,
		depth: TAVLA_CHECKERS * (g.checker.height + OFF_GAP_M) + g.checker.diameter,
	});
	return layout;
}

// Where the two dice settle: the mover's right half, on the centre line, inside SeatedView's die probe.
export function tavlaDiceRest(g: TavlaBoardGeometry, moverWhite: boolean): [Vec3, Vec3] {
	const {x, z} = SEAT_READABILITY_PROBES.tavlaDie;
	const edge = SEAT_PIECE_SIZE_M.tavlaDie;
	const side = moverWhite ? 1 : -1; // white sits at +Z facing −Z: its right is +X
	const y = g.points[0]!.y + edge / 2;
	return [
		{x: side * x, y, z},
		{x: side * (x - edge - DICE_GAP_M), y, z},
	];
}

export interface TavlaReplay {
	// The board after each step, and the checker that step moves.
	boards: ReadonlyArray<TavlaStacks>;
	flights: ReadonlyArray<{spot: number; start: Vec3; end: Vec3}>;
}

// The last turn replayed from the previous board; null unless it lands exactly on the server's new board.
export function planTavlaReplay(g: TavlaBoardGeometry, prev: TavlaView, next: TavlaView): TavlaReplay | null {
	if (prev.turn === null || next.last_moves.length === 0) return null;
	const white = prev.turn === prev.white; // whoever was on turn made these moves
	const stacks = tavlaStacks(prev, []);
	const boards: Array<TavlaStacks> = [];
	const flights: Array<{spot: number; start: Vec3; end: Vec3}> = [];
	for (const move of next.last_moves) {
		const from = spotFrom(move.from, white);
		if (stacks[from]!.length === 0) return null;
		const start = spotPosition(g, from, topSlot(stacks, from)).position;
		const moved = applyMove(stacks, white, move, false);
		if (!moved) return null;
		flights.push({spot: moved.to, start, end: spotPosition(g, moved.to, topSlot(stacks, moved.to)).position});
		boards.push(stacks.map((stack) => [...stack]));
	}
	const target = tavlaStacks(next, []);
	const same = stacks.every(
		(stack, spot) =>
			stack.length === target[spot]!.length && stack.every((checker, i) => checker.white === target[spot]![i]!.white),
	);
	return same ? {boards, flights} : null;
}

// The replay at `elapsedMs`; null once it is over (the server's board is drawn as is).
export function sampleTavlaReplay(
	replay: TavlaReplay,
	elapsedMs: number,
): {stacks: TavlaStacks; moving: {spot: number; position: Vec3}} | null {
	if (elapsedMs >= TAVLA_REPLAY_MS) return null;
	const stepMs = TAVLA_REPLAY_MS / replay.flights.length;
	const step = Math.min(replay.flights.length - 1, Math.floor(Math.max(0, elapsedMs) / stepMs));
	const u = Math.min(1, Math.max(0, elapsedMs / stepMs - step));
	const eased = u * u * (3 - 2 * u);
	const {spot, start, end} = replay.flights[step]!;
	return {
		stacks: replay.boards[step]!,
		moving: {
			spot,
			position: {
				x: start.x + (end.x - start.x) * eased,
				y: start.y + (end.y - start.y) * eased + REPLAY_HOP_M * Math.sin(Math.PI * u),
				z: start.z + (end.z - start.z) * eased,
			},
		},
	};
}
