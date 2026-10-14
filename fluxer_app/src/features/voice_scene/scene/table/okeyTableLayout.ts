// SPDX-License-Identifier: AGPL-3.0-or-later

import {type OkeyStage, stagedTiles} from '@app/features/table_game/components/okey/Okey101Staging';
import {
	layoutRack,
	okeyFaceOf,
	okeyTileLook,
	RACK_COLUMNS,
} from '@app/features/table_game/components/okey/OkeyRackModel';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {OKEY_BACK_CELL, okeyTileCell} from '@app/features/voice_scene/scene/table/OkeyTileAtlas';
import type {TableDragSource, TableDropTarget} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_READABILITY_PROBES} from '@app/features/voice_scene/utils/SeatedView';
import type {Okey101View, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Pure layout of an okey/101 table in the model root's space: origin the table-top centre, +Z my edge (the
// perspective seat), +X my right. Positions sit counter-clockwise from above (GLB contract: 1 south, then 2, 3, 4),
// so the next player is on my right and the previous one, whose discards I take, on my left.

// The tile as drawn (metres, after normalising okey_face to SEAT_PIECE_SIZE_M.okeyFace): origin at the middle of
// its base, face towards +Z; zMin/zMax are the body's back and front.
export interface OkeyTileSize {
	width: number;
	height: number;
	thickness: number;
	zMin: number;
	zMax: number;
}

export type OkeyTilePlace = 'rack' | 'back' | 'pile' | 'indicator' | 'discard' | 'meld' | 'ghost';

// Pose: translate (x, y, z) · yaw about +Y · pitch about the tile's own X (0 standing, −90° lying face up).
export interface OkeyTilePlacement {
	place: OkeyTilePlace;
	owner: 1 | 2 | 3 | 4 | null;
	cell: number;
	tint: 'none' | 'wild' | 'ghost';
	source: TableDragSource | null;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

// A unit plane (facing +Z before its pose) scaled to width × height.
export interface OkeyZonePlacement {
	target: TableDropTarget;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	width: number;
	height: number;
}

export interface OkeyRackPlacement {
	x: number;
	z: number;
	yaw: number;
}

export interface OkeyTableLayout {
	tiles: Array<OkeyTilePlacement>;
	zones: Array<OkeyZonePlacement>;
	racks: Array<OkeyRackPlacement>;
}

type Position = 1 | 2 | 3 | 4;

// Where the viewer's eye is, table-local: the seat ring sits ~0.45 m past the top's edge, the eye 0.15 m behind it
// and ~0.4 m over the top (rev 3, the three rooms). Lying tiles lean towards it (≤ 70° from flat).
// TEMPORARY: estimated, not the live camera — the seat view only turns ±20°/±8°; read the camera if that ever shows.
export const OKEY_EYE = {height: 0.4, back: 0.6} as const;
const MAX_TILT = (70 * Math.PI) / 180;
const FACE_DOWN = Math.PI / 2;
const FACE_UP = -Math.PI / 2;

// masa-parcalari rev 2 okey_rack, in tile heights: 15 slots 36 mm apart, shelves at y 12 / 39 mm, the upper one
// 27 mm further back than the 1 mm lip of the lower one (48 mm tile).
const RACK_PITCH = 0.75;
const RACK_ROWS = [
	{y: 0.8125, z: -0.5625}, // cells 0..14, the upper row
	{y: 0.25, z: 0.0208}, // cells 15..29, the lower row
] as const;

const PILE_TOWER = 8;
const PILE_Z = -0.11;
const PILE_GAP = 0.006;
// Buried discards beyond these never show (only the top is ever in play); the 2D panel lists them all.
const DISCARD_SHOWN = 5;
// A discard pile sits this much inside its corner probe, clear of its owner's rack end.
const DISCARD_PULL = 0.06;
// The two piles at my edge lie this far in from the table's side and near edges (and their drop zone this wide): my
// rack's end caps (±0.494 m, as tall as its back wall) hide anything nearer its middle from my eye; the side racks
// end 0.494 m out too.
const NEAR_DISCARD = {side: 0.045, edge: 0.06, zone: 0.09};
const MELD_GAP = 0.003;
const MELD_ROW_PITCH = 0.06;
const MELD_END_LIFT = 0.02;
// The middle's drop target (101 meld zone, classic finish zone) leans like my strip's tiles just behind them, between
// these heights over the felt. Below the felt it takes the drops aimed at the felt in front of my strip
// (zones are hit on their own; the table never blocks them) down to where my rack's cells come first; the top stays
// under the sight lines to the far player's first two rows of meld ends.
const MIDDLE_ZONE = {low: -0.065, top: 0.075, behind: 0.004};

const {
	okeyRackInset,
	okeyDiscardInset,
	okeyMeldInset,
	okeyMeldHalfWidth,
	okeyMyMeldZ,
	okeyMyMeldInner,
	okeyMyMeldHalfWidth,
	okeyMySecondRowZ,
} = SEAT_READABILITY_PROBES;

interface Ctx {
	h: number;
	tile: OkeyTileSize;
	perspective: Position;
	tiles: Array<OkeyTilePlacement>;
}

// Turns of a quarter, counter-clockwise from my edge: 0 me, 1 my right, 2 across, 3 my left.
const turnsOf = (perspective: Position, position: number): number => (position - perspective + 4) % 4;

// Owner frame (their edge +Z) → mine.
function toMine(turns: number, x: number, z: number): {x: number; z: number; yaw: number} {
	const yaw = (turns * Math.PI) / 2;
	const cos = Math.round(Math.cos(yaw));
	const sin = Math.round(Math.sin(yaw));
	return {x: x * cos + z * sin, z: -x * sin + z * cos, yaw};
}

// How far below the origin the tile reaches once pitched; lifting by it sets the tile on y = 0.
function liftFor(tile: OkeyTileSize, pitch: number): number {
	const cos = Math.cos(pitch);
	const sin = Math.sin(pitch);
	let low = 0;
	for (const y of [0, tile.height]) for (const z of [tile.zMin, tile.zMax]) low = Math.min(low, y * cos - z * sin);
	return -low;
}

// The middle of a placed tile (the digit's centre).
export function okeyTileCentre(t: OkeyTilePlacement, tile: OkeyTileSize): {x: number; y: number; z: number} {
	const half = tile.height / 2;
	const sin = Math.sin(t.pitch);
	return {
		x: t.x + sin * Math.sin(t.yaw) * half,
		y: t.y + Math.cos(t.pitch) * half,
		z: t.z + sin * Math.cos(t.yaw) * half,
	};
}

// A tile lying at a spot of my frame, its centre over the spot, leaning towards my eye; `flat` keeps it face up.
function lying(
	ctx: Ctx,
	base: Omit<OkeyTilePlacement, 'x' | 'y' | 'z' | 'yaw' | 'pitch'>,
	x: number,
	z: number,
	level: number,
	flat = false,
): OkeyTilePlacement {
	const {tile} = ctx;
	const dx = 0 - x;
	const dz = ctx.h + OKEY_EYE.back - z;
	const horizontal = Math.hypot(dx, dz);
	const tilt = flat ? 0 : Math.min(MAX_TILT, Math.PI / 2 - Math.atan2(OKEY_EYE.height - level, horizontal));
	const yaw = Math.atan2(dx, dz);
	const pitch = tilt - Math.PI / 2;
	const back = (tile.height / 2) * Math.cos(tilt);
	return {
		...base,
		x: x + (dx / horizontal) * back,
		y: level + liftFor(tile, pitch),
		z: z + (dz / horizontal) * back,
		yaw,
		pitch,
	};
}

function rackTiles(ctx: Ctx, owner: Position, cells: ReadonlyArray<RackSlot | 'back'>): void {
	const {tile, h} = ctx;
	const turns = turnsOf(ctx.perspective, owner);
	// The upper row stands on the readability probe line (z = h − inset); the lower one is nearer and lower.
	const rackZ = h - okeyRackInset - RACK_ROWS[0].z * tile.height;
	cells.forEach((token, cell) => {
		if (token === null) return;
		const row = RACK_ROWS[cell < RACK_COLUMNS ? 0 : 1];
		const spot = toMine(turns, ((cell % RACK_COLUMNS) - 7) * RACK_PITCH * tile.height, rackZ + row.z * tile.height);
		const back = token === 'back';
		ctx.tiles.push({
			place: back ? 'back' : 'rack',
			owner,
			cell: back ? OKEY_BACK_CELL : okeyTileCell(token),
			tint: 'none',
			source: back ? null : {kind: 'rack_tile', tile: token, cell},
			x: spot.x,
			y: row.y * tile.height,
			z: spot.z,
			yaw: spot.yaw,
			pitch: 0,
		});
	});
}

// n hidden tiles, centred, the lower row first.
function backCells(count: number): Array<'back' | null> {
	const cells = Array<'back' | null>(2 * RACK_COLUMNS).fill(null);
	const lower = Math.min(count, RACK_COLUMNS);
	const upper = Math.min(count - lower, RACK_COLUMNS);
	for (let i = 0; i < lower; i++) cells[RACK_COLUMNS + Math.floor((RACK_COLUMNS - lower) / 2) + i] = 'back';
	for (let i = 0; i < upper; i++) cells[Math.floor((RACK_COLUMNS - upper) / 2) + i] = 'back';
	return cells;
}

// A run of tiles laid in rows. The other owners' lie in front of them: from h − 0.2 (the probe) towards the centre,
// |x| ≤ 0.3 − w/2. The perspective edge's lie across the middle instead, where my rack does not hide them :
// half rows left then right of the indicator and the pile, read left to right, further rows going back.
function meldRows(ctx: Ctx, owner: Position) {
	const {tile, h} = ctx;
	const pitch = tile.width + MELD_GAP;
	const turns = turnsOf(ctx.perspective, owner);
	const half = okeyMeldHalfWidth - tile.width / 2;
	const inner = okeyMyMeldInner + tile.width / 2;
	const slots =
		turns === 0
			? Math.floor((okeyMyMeldHalfWidth - tile.width / 2 - inner) / pitch) + 1
			: Math.floor((2 * half) / pitch) + 1;
	let slot = 0;
	const at = (index: number) => {
		const row = Math.floor(index / slots);
		const column = index % slots;
		if (turns !== 0) return toMine(turns, -half + column * pitch, h - okeyMeldInset - row * MELD_ROW_PITCH);
		// the second row lies out at okeyMySecondRowZ, where my sight line clears the first row's tiles. TEMPORARY:
		// a third row (rare) goes 0.06 m behind it and shows its tops only; the 2D panel lists every set.
		const left = row % 2 === 0;
		const x = inner + (left ? slots - 1 - column : column) * pitch;
		const band = Math.floor(row / 2);
		const z = band === 0 ? okeyMyMeldZ : okeyMySecondRowZ - (band - 1) * MELD_ROW_PITCH;
		return toMine(turns, left ? -x : x, z);
	};
	return {
		at,
		// Reserve n slots after a one-slot gap, none at a row's start (a meld never starts in a row's last slot).
		take(n: number): number {
			if (slot % slots !== 0) slot++;
			if (slot % slots === slots - 1) slot++;
			const first = slot;
			slot += n;
			return first;
		},
	};
}

interface MeldRun {
	owner: Position;
	id: number | null;
	tiles: Array<{token: string; ghost: boolean}>;
	ends: boolean;
}

function meldRuns(game: Okey101View, me: Position | null, stage: OkeyStage | null): Array<MeldRun> {
	const runs: Array<MeldRun> = game.melds.map((meld) => {
		const adds = stage?.add.filter((add) => add.meld_id === meld.id) ?? [];
		const ghosts = (at: 'start' | 'end') =>
			adds.filter((add) => add.at === at).flatMap((add) => add.tiles.map((token) => ({token, ghost: true})));
		return {
			owner: meld.owner as Position,
			id: meld.id,
			tiles: [...ghosts('start'), ...meld.tiles.map((token) => ({token, ghost: false})), ...ghosts('end')],
			ends: true,
		};
	});
	if (me === null || !stage) return runs;
	for (const set of stage.open)
		runs.push({owner: me, id: null, tiles: set.map((token) => ({token, ghost: true})), ends: false});
	const placed = new Set([...stage.open.flat(), ...stage.add.flatMap((add) => add.tiles)]);
	if (stage.take && !placed.has(stage.take))
		runs.push({owner: me, id: null, tiles: [{token: stage.take, ghost: true}], ends: false});
	return runs;
}

const PLAIN = {place: 'ghost', owner: null, cell: 0, tint: 'none', source: null} as const;

// A drop target standing where a tile would lie at (x, z) of my frame: on its face (or just behind its back, as the
// middle's zone), the size of its slot.
function onTile(ctx: Ctx, target: TableDropTarget, x: number, z: number, behind = false): OkeyZonePlacement {
	const t = lying(ctx, PLAIN, x, z, 0);
	const c = okeyTileCentre(t, ctx.tile);
	const front = behind ? ctx.tile.zMin - MIDDLE_ZONE.behind : ctx.tile.zMax + 0.001;
	const normal = {
		x: Math.cos(t.pitch) * Math.sin(t.yaw),
		y: -Math.sin(t.pitch),
		z: Math.cos(t.pitch) * Math.cos(t.yaw),
	};
	return {
		target,
		x: c.x + normal.x * front,
		y: c.y + normal.y * front,
		z: c.z + normal.z * front,
		yaw: t.yaw,
		pitch: t.pitch,
		width: ctx.tile.width + MELD_GAP,
		height: ctx.tile.height,
	};
}

// The middle's drop target: a plane leaning like my strip's tiles (yaw 0 on the centre line), just behind their backs.
function middleZone(ctx: Ctx, target: TableDropTarget): OkeyZonePlacement {
	const t = lying(ctx, PLAIN, 0, okeyMyMeldZ, 0);
	const back = ctx.tile.zMin - MIDDLE_ZONE.behind;
	const y = t.y - Math.sin(t.pitch) * back;
	const along = ((MIDDLE_ZONE.low + MIDDLE_ZONE.top) / 2 - y) / Math.cos(t.pitch);
	return {
		target,
		x: 0,
		y: y + Math.cos(t.pitch) * along,
		z: t.z + Math.cos(t.pitch) * back + Math.sin(t.pitch) * along,
		yaw: 0,
		pitch: t.pitch,
		width: 2 * okeyMyMeldHalfWidth,
		height: (MIDDLE_ZONE.top - MIDDLE_ZONE.low) / Math.cos(t.pitch),
	};
}

const zone = (
	target: TableDropTarget,
	x: number,
	y: number,
	z: number,
	width: number,
	height: number,
	flat = true,
) => ({
	target,
	x,
	y,
	z,
	yaw: 0,
	pitch: flat ? FACE_UP : 0,
	width,
	height,
});

export function okeyTableLayout(p: {
	view: TableGameView;
	perspective: Position;
	rack: ReadonlyArray<RackSlot>;
	stage: OkeyStage | null;
	topSize: number;
	tile: OkeyTileSize;
}): OkeyTableLayout {
	const {view, perspective, tile} = p;
	const h = p.topSize / 2;
	const rackZ = h - okeyRackInset - RACK_ROWS[0].z * tile.height;
	const racks = [0, 1, 2, 3].map((turns) => {
		const spot = toMine(turns, 0, rackZ);
		return {x: spot.x, z: spot.z, yaw: spot.yaw};
	});
	const game = view.game_view;
	if (game?.game !== 'okey' && game?.game !== 'okey101') return {tiles: [], zones: [], racks};

	const ctx: Ctx = {h, tile, perspective, tiles: []};
	// I am the player at this edge only with my own rack (a watcher or spectator has none).
	const me: Position | null = view.viewer_position === perspective && game.rack !== null ? perspective : null;
	const stage = me !== null && game.game === 'okey101' ? p.stage : null;
	const staged = new Set(stagedTiles(stage));
	const okey = okeyFaceOf(game.indicator);
	const wild = (token: string) => okeyTileLook(token, okey)?.okey === 'wild';

	for (const position of [1, 2, 3, 4] as const) {
		if (position === me) {
			const held = new Set(game.rack);
			const cells = layoutRack(p.rack).map((token) =>
				token !== null && held.has(token) && !staged.has(token) ? token : null,
			);
			rackTiles(ctx, position, cells);
		} else rackTiles(ctx, position, backCells(game.rack_counts[position - 1] ?? 0));
	}
	for (const placement of ctx.tiles) {
		if (placement.source?.kind === 'rack_tile' && wild(placement.source.tile)) placement.tint = 'wild';
	}

	// The pile, face down in towers behind the indicator; its top is the one tile I may draw.
	const towers = Math.ceil(game.pile_count / PILE_TOWER);
	for (let index = 0; index < game.pile_count; index++) {
		const tower = Math.floor(index / PILE_TOWER);
		const level = index % PILE_TOWER;
		const last = index === game.pile_count - 1;
		ctx.tiles.push({
			place: 'pile',
			owner: null,
			cell: OKEY_BACK_CELL,
			tint: 'none',
			source: last && me !== null ? {kind: 'pile'} : null,
			x: (tower - (towers - 1) / 2) * (tile.width + PILE_GAP),
			y: level * tile.thickness + liftFor(tile, FACE_DOWN),
			z: PILE_Z - tile.height / 2,
			yaw: 0,
			pitch: FACE_DOWN,
		});
	}
	ctx.tiles.push(
		lying(
			ctx,
			{place: 'indicator', owner: null, cell: okeyTileCell(game.indicator), tint: 'none', source: null},
			0,
			0,
			0,
		),
	);

	// Each position's discards at its right corner: a short flat stack, the newest leaning up on top. The far two stay
	// on the readability probe; the two at my edge (mine, and my left neighbour's that I take from) lie past my rack's
	// ends, mirrored.
	const corner = h - okeyDiscardInset;
	const near = {x: h - NEAR_DISCARD.side, z: h - NEAR_DISCARD.edge};
	for (const position of [1, 2, 3, 4] as const) {
		const pile = (game.discards[position - 1] ?? []).filter((token) => !staged.has(token)).slice(-DISCARD_SHOWN);
		const turns = turnsOf(perspective, position);
		const spot =
			turns === 0 || turns === 3
				? {x: turns === 0 ? near.x : -near.x, z: near.z}
				: toMine(turns, corner, corner - DISCARD_PULL);
		pile.forEach((token, index) => {
			const top = index === pile.length - 1;
			const base = {
				place: 'discard' as const,
				owner: position,
				cell: okeyTileCell(token),
				tint: wild(token) ? ('wild' as const) : ('none' as const),
				source: top && me !== null ? {kind: 'discard_top' as const, position} : null,
			};
			ctx.tiles.push(lying(ctx, base, spot.x, spot.z, index * tile.thickness, !top));
		});
	}

	const zones: Array<OkeyZonePlacement> = [];
	if (game.game === 'okey101') {
		const rows = new Map<Position, ReturnType<typeof meldRows>>();
		const rowsOf = (owner: Position) => rows.get(owner) ?? rows.set(owner, meldRows(ctx, owner)).get(owner)!;
		for (const run of meldRuns(game, me, stage)) {
			const owner = rowsOf(run.owner);
			const first = owner.take(run.tiles.length);
			run.tiles.forEach(({token, ghost}, index) => {
				const spot = owner.at(first + index);
				const base = {
					place: ghost ? ('ghost' as const) : ('meld' as const),
					owner: run.owner,
					cell: okeyTileCell(token),
					tint: ghost ? ('ghost' as const) : wild(token) ? ('wild' as const) : ('none' as const),
					source: null,
				};
				ctx.tiles.push(lying(ctx, base, spot.x, spot.z, 0));
				// CAM3 2: my rows past the first lie beyond the middle's zone (its top stays under the sight lines to the far
				// player's meld ends), so a tile of mine there carries the meld zone just behind its back.
				if (run.owner === perspective && spot.z < okeyMyMeldZ)
					zones.push(onTile(ctx, {kind: 'meld_zone'}, spot.x, spot.z, true));
			});
			if (me === null || !run.ends || run.id === null) continue;
			for (const [at, index] of [
				['start', first - 1],
				['end', first + run.tiles.length],
			] as const) {
				const target: TableDropTarget = {kind: 'meld_end', meldId: run.id, at};
				if (run.owner === perspective) {
					// My strip faces me: each end stands one slot past the set's own end tile, where the added tile would go.
					const spot = owner.at(at === 'start' ? first : first + run.tiles.length - 1);
					const pitch = tile.width + MELD_GAP;
					const x = spot.x + (at === 'start' ? -pitch : pitch);
					// past the strip's inner slot it would lie over the indicator and the 101 pile: no end that way
					// (the 2D panel still adds there).
					if (Math.abs(x) < okeyMyMeldInner) continue;
					zones.push(onTile(ctx, target, x, spot.z));
					continue;
				}
				const spot = owner.at(Math.max(0, index));
				zones.push({...zone(target, spot.x, MELD_END_LIFT, spot.z, tile.width, MELD_ROW_PITCH), yaw: spot.yaw});
			}
		}
	}

	if (me === null) return {tiles: ctx.tiles, zones: [], racks};
	const mine: Array<OkeyZonePlacement> = [];
	// My rack cells stand where their tiles stand, facing me.
	for (let cell = 0; cell < 2 * RACK_COLUMNS; cell++) {
		const row = RACK_ROWS[cell < RACK_COLUMNS ? 0 : 1];
		const x = ((cell % RACK_COLUMNS) - 7) * RACK_PITCH * tile.height;
		const y = (row.y + 0.5) * tile.height;
		mine.push(
			zone(
				{kind: 'rack_cell', cell},
				x,
				y,
				rackZ + row.z * tile.height + tile.zMax,
				RACK_PITCH * tile.height,
				tile.height,
				false,
			),
		);
	}
	mine.push(zone({kind: 'discard_zone'}, near.x, 0.002, near.z, NEAR_DISCARD.zone, NEAR_DISCARD.zone));
	// Classic okey finishes and 101 lays a new set on the middle, which my rack's cells never cover from my seat
	// (the meld zone in front of me lay wholly behind them), over my strip.
	mine.push(middleZone(ctx, {kind: game.game === 'okey' ? 'finish_zone' : 'meld_zone'}));
	return {tiles: ctx.tiles, zones: [...mine, ...zones], racks};
}
