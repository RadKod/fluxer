// SPDX-License-Identifier: AGPL-3.0-or-later

import type {OkeyStage} from '@app/features/table_game/components/okey/Okey101Staging';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {testOkeyGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import {OKEY_BACK_CELL, okeyTileCell} from '@app/features/voice_scene/scene/table/OkeyTileAtlas';
import {
	OKEY_EYE,
	type OkeyTilePlacement,
	type OkeyTileSize,
	okeyTableLayout,
	okeyTileCentre,
} from '@app/features/voice_scene/scene/table/okeyTableLayout';
import type {TableDropTarget} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_SIZE_M, SEAT_READABILITY_PROBES} from '@app/features/voice_scene/utils/SeatedView';
import type {Okey101View, OkeyView, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Euler, Matrix4, Quaternion, Vector3} from 'three';
import {describe, expect, it} from 'vitest';

// masa-parcalari rev 2: the tile is 34 × 48 × 10 mm, normalised to a 0.082 m face.
const S = SEAT_PIECE_SIZE_M.okeyFace / 0.048;
const TILE: OkeyTileSize = {width: 0.034 * S, height: 0.082, thickness: 0.01 * S, zMin: -0.005 * S, zMax: 0.005 * S};
const TOP = 1.3;
const H = TOP / 2;
const DEG = Math.PI / 180;
const EPS = 1e-9;

const MY_RACK = ['t0', 't1', 't2', null, 't20', 't21', 't22', 't23', null, 't40', 't41', 't42', 't60', 't61'] as const;
const rackTiles = (rack: ReadonlyArray<RackSlot>) => rack.filter((tile): tile is string => tile !== null);

function okeyView(options: {me?: number | null; game?: Partial<Okey101View>; okey101?: boolean} = {}): TableGameView {
	const me = options.me === undefined ? 1 : options.me;
	const base = testOkeyGameView({rack: me === null ? null : rackTiles(MY_RACK)});
	const gameView = options.okey101
		? ({
				...base,
				game: 'okey101',
				phase: 'play',
				melds: [],
				opened: ['none', 'none', 'none', 'none'],
				penalties: [0, 0, 0, 0],
				scores: null,
				...options.game,
			} as Okey101View)
		: ({...base, ...options.game} as OkeyView);
	return testView({game: options.okey101 ? 'okey101' : 'okey', viewerPosition: me, gameView});
}

function layout(
	view: TableGameView,
	extra: {perspective?: 1 | 2 | 3 | 4; rack?: ReadonlyArray<RackSlot>; stage?: OkeyStage | null} = {},
) {
	return okeyTableLayout({
		view,
		perspective: extra.perspective ?? 1,
		rack: extra.rack ?? MY_RACK,
		stage: extra.stage ?? null,
		topSize: TOP,
		tile: TILE,
	});
}

const of = (tiles: ReadonlyArray<OkeyTilePlacement>, place: OkeyTilePlacement['place']) =>
	tiles.filter((tile) => tile.place === place);
// Tilt from lying flat face up (0) to standing (90°).
const tiltOf = (tile: OkeyTilePlacement) => tile.pitch + Math.PI / 2;
const kinds = (zones: ReadonlyArray<{target: TableDropTarget}>) => zones.map((zone) => zone.target.kind);

// A placed tile's box on the table (x/z extents of its eight corners).
function footprint(t: OkeyTilePlacement) {
	const pose = new Matrix4().compose(
		new Vector3(t.x, t.y, t.z),
		new Quaternion().setFromEuler(new Euler(t.pitch, t.yaw, 0, 'YXZ')),
		new Vector3(1, 1, 1),
	);
	const xs: Array<number> = [];
	const zs: Array<number> = [];
	for (const x of [-TILE.width / 2, TILE.width / 2])
		for (const y of [0, TILE.height])
			for (const z of [TILE.zMin, TILE.zMax]) {
				const corner = new Vector3(x, y, z).applyMatrix4(pose);
				xs.push(corner.x);
				zs.push(corner.z);
			}
	return {x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs)};
}
const overlaps = (a: ReturnType<typeof footprint>, b: ReturnType<typeof footprint>) =>
	a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

describe('okeyTableLayout', () => {
	it('my rack 2×15 cells in front of my edge', () => {
		const {tiles} = layout(okeyView());
		const mine = of(tiles, 'rack');
		expect(mine.map((tile) => tile.source)).toEqual(
			MY_RACK.flatMap((tile, cell) => (tile === null ? [] : [{kind: 'rack_tile', tile, cell}])),
		);
		expect(mine.map((tile) => tile.cell)).toEqual(rackTiles(MY_RACK).map((token) => okeyTileCell(token)));
		// Upright, facing me, inside the readability probe: |x| ≤ 0.45, the upper row at z = h − 0.1.
		const {okeyRackHalfLength, okeyRackInset} = SEAT_READABILITY_PROBES;
		for (const tile of mine) {
			expect([tile.yaw, tile.pitch]).toEqual([0, 0]);
			expect(Math.abs(tile.x)).toBeLessThanOrEqual(okeyRackHalfLength);
		}
		const cellX = (cell: number) =>
			mine.find((tile) => tile.source?.kind === 'rack_tile' && tile.source.cell === cell)!.x;
		expect(cellX(0)).toBeLessThan(cellX(1));
		expect(cellX(0)).toBeCloseTo(-7 * 0.75 * TILE.height, 9);

		// Cells 15..29 are the lower, nearer row; the upper row stands exactly on the probe line.
		const lower = layout(okeyView(), {rack: [...Array<RackSlot>(15).fill(null), ...MY_RACK]}).tiles;
		const upperZ = mine[0]!.z;
		expect(upperZ).toBeCloseTo(H - okeyRackInset, 9);
		for (const tile of of(lower, 'rack')) {
			expect(tile.z).toBeGreaterThan(upperZ);
			expect(tile.y).toBeLessThan(mine[0]!.y);
		}
		// A stale local order cannot draw a tile the server says I do not hold.
		expect(
			of(layout(okeyView(), {rack: ['t99', ...MY_RACK]}).tiles, 'rack').some(
				(tile) => tile.cell === okeyTileCell('t99'),
			),
		).toBe(false);
	});

	it("opponents' racks render from rack_counts only", () => {
		const view = okeyView({game: {rack_counts: [14, 13, 12, 15]}});
		const {tiles} = layout(view);
		const backs = of(tiles, 'back');
		expect(backs.every((tile) => tile.cell === OKEY_BACK_CELL && tile.source === null && tile.tint === 'none')).toBe(
			true,
		);
		const count = (owner: number) => backs.filter((tile) => tile.owner === owner).length;
		expect([count(1), count(2), count(3), count(4)]).toEqual([0, 13, 12, 15]);
		// Position 2 sits on my right (+X), 3 across (−Z), 4 on my left (−X): turns go counter-clockwise.
		const centre = (owner: number) => {
			const own = backs.filter((tile) => tile.owner === owner);
			return {
				x: own.reduce((sum, tile) => sum + tile.x, 0) / own.length,
				z: own.reduce((sum, tile) => sum + tile.z, 0) / own.length,
			};
		};
		expect(centre(2).x).toBeGreaterThan(0.5);
		expect(centre(3).z).toBeLessThan(-0.5);
		expect(centre(4).x).toBeLessThan(-0.5);

		// A watcher (no rack) sees four racks of backs, the edge they sit behind included; nothing is pickable.
		const watcher = layout(okeyView({me: null, game: {rack_counts: [14, 13, 12, 15]}}), {rack: []});
		expect(of(watcher.tiles, 'rack')).toEqual([]);
		expect(of(watcher.tiles, 'back').filter((tile) => tile.owner === 1)).toHaveLength(14);
		expect(watcher.tiles.filter((tile) => tile.source !== null)).toEqual([]);
		expect(watcher.zones).toEqual([]);
	});

	it('pile in the centre with count, indicator face up', () => {
		const {tiles} = layout(okeyView({game: {pile_count: 37, indicator: 't5'}}));
		const pile = of(tiles, 'pile');
		expect(pile).toHaveLength(37);
		for (const tile of pile) {
			expect(tile.cell).toBe(OKEY_BACK_CELL);
			expect(tile.pitch).toBeCloseTo(Math.PI / 2, 9); // face down
			expect(Math.hypot(tile.x, tile.z)).toBeLessThan(0.3);
		}
		// Only the top of the pile is a source.
		expect(pile.map((tile) => tile.source)).toEqual([...Array(36).fill(null), {kind: 'pile'}]);
		// It tops the tower being drawn from.
		const top = pile.at(-1)!;
		expect(top.y).toBe(Math.max(...pile.filter((tile) => tile.x === top.x).map((tile) => tile.y)));

		const [indicator] = of(tiles, 'indicator');
		expect(indicator?.cell).toBe(okeyTileCell('t5'));
		const centre = okeyTileCentre(indicator!, TILE);
		expect([centre.x, centre.z].map((value) => Math.abs(value) < EPS)).toEqual([true, true]);
		expect(tiltOf(indicator!)).toBeGreaterThan(0);
		expect(of(layout(okeyView({game: {pile_count: 0}})).tiles, 'pile')).toEqual([]);
	});

	it("each position's discard pile to its right, newest on top", () => {
		const discards = [['t1', 't2', 't3'], ['t14'], ['t27', 't28'], ['t40', 't41', 't42', 't43', 't44', 't45', 't46']];
		const {tiles} = layout(okeyView({game: {discards}}));
		const pile = (owner: number) => of(tiles, 'discard').filter((tile) => tile.owner === owner);
		const spot = (owner: number) => {
			const top = pile(owner).at(-1)!;
			return okeyTileCentre(top, TILE);
		};
		// Mine to my right; the right player's to my far right; across: far left; the left player's: my near left.
		expect(Math.sign(spot(1).x) + Math.sign(spot(1).z) * 10).toBe(11);
		expect(Math.sign(spot(2).x) + Math.sign(spot(2).z) * 10).toBe(-9);
		expect(Math.sign(spot(3).x) + Math.sign(spot(3).z) * 10).toBe(-11);
		expect(Math.sign(spot(4).x) + Math.sign(spot(4).z) * 10).toBe(9);
		for (const owner of [1, 2, 3, 4]) {
			const own = pile(owner);
			const top = own.at(-1)!;
			expect(top.cell).toBe(okeyTileCell(discards[owner - 1]!.at(-1)!));
			expect(top.y).toBe(Math.max(...own.map((tile) => tile.y)));
			expect(tiltOf(top)).toBeGreaterThan(0);
			// The tiles under it lie flat; at most four of the buried ones are drawn.
			for (const under of own.slice(0, -1)) expect(tiltOf(under)).toBeCloseTo(0, 9);
			expect(own.length).toBe(Math.min(5, discards[owner - 1]!.length));
			expect(own.filter((tile) => tile.source !== null).map((tile) => tile.source)).toEqual([
				{kind: 'discard_top', position: owner},
			]);
		}
	});

	it('101 melds in rows in front of their owner', () => {
		const melds = [
			{
				id: 0,
				owner: 3,
				kind: 'run' as const,
				tiles: ['t30', 't31', 't32', 't33', 't34', 't35', 't36', 't37', 't38', 't39', 't40'],
			},
			{id: 1, owner: 3, kind: 'group' as const, tiles: ['t4', 't17', 't30']},
			{id: 2, owner: 2, kind: 'run' as const, tiles: ['t7', 't8', 't9']},
			{id: 3, owner: 1, kind: 'run' as const, tiles: ['t50', 't51', 't52']},
		];
		const {tiles} = layout(okeyView({okey101: true, game: {melds, opened: ['sets', 'sets', 'sets', 'none']}}));
		const meld = of(tiles, 'meld');
		expect(meld.map((tile) => tile.cell)).toEqual(melds.flatMap((entry) => entry.tiles.map((t) => okeyTileCell(t))));
		const centres = (owner: number) =>
			meld.filter((tile) => tile.owner === owner).map((tile) => okeyTileCentre(tile, TILE));
		const {okeyMeldInset, okeyMeldHalfWidth} = SEAT_READABILITY_PROBES;
		// The far owner's: z ≥ −(h − 0.2) and |x| ≤ 0.3 (readability probes); 14 tiles take two rows.
		const far = centres(3);
		for (const c of far) {
			expect(c.z).toBeGreaterThanOrEqual(-(H - okeyMeldInset) - EPS);
			expect(c.z).toBeLessThan(0);
			expect(Math.abs(c.x)).toBeLessThanOrEqual(okeyMeldHalfWidth);
		}
		expect(new Set(far.map((c) => c.z.toFixed(4))).size).toBe(2);
		for (const c of centres(2)) {
			expect(c.x).toBeGreaterThan(0);
			expect(Math.abs(c.z)).toBeLessThanOrEqual(okeyMeldHalfWidth);
		}
		// Mine are not in front of me: my rack would hide them (next test).
		for (const c of centres(1)) expect(c.z).toBeLessThan(0);
	});

	it('my own 101 sets lie across the middle, beside the indicator and the pile, past what my rack hides (UX-okey2)', () => {
		const {okeyMyMeldZ, okeyMyMeldInner, okeyMyMeldHalfWidth, okeyMySecondRowZ} = SEAT_READABILITY_PROBES;
		const melds = [
			{id: 0, owner: 1, kind: 'run' as const, tiles: ['t30', 't31', 't32', 't33']},
			{id: 1, owner: 1, kind: 'group' as const, tiles: ['t4', 't17', 't43']},
			{id: 2, owner: 1, kind: 'run' as const, tiles: ['t46', 't47', 't48']},
			{id: 3, owner: 3, kind: 'run' as const, tiles: ['t7', 't8', 't9']},
		];
		const view = okeyView({okey101: true, game: {melds, opened: ['sets', 'none', 'sets', 'none'], pile_count: 20}});
		const {tiles} = layout(view);
		const mine = of(tiles, 'meld')
			.filter((tile) => tile.owner === 1)
			.map((tile) => okeyTileCentre(tile, TILE));
		expect(mine).toHaveLength(10);
		const pitch = TILE.width + 0.003;
		// The first row: the run left of the indicator column, the group right of it, read left to right.
		for (const c of mine.slice(0, 7)) {
			expect(c.z).toBeCloseTo(okeyMyMeldZ, 9);
			expect(Math.abs(c.x) - TILE.width / 2).toBeGreaterThanOrEqual(okeyMyMeldInner - EPS);
			expect(Math.abs(c.x) + TILE.width / 2).toBeLessThanOrEqual(okeyMyMeldHalfWidth + EPS);
		}
		expect(mine.slice(0, 4).every((c) => c.x < 0)).toBe(true);
		expect(mine.slice(4, 7).every((c) => c.x > 0)).toBe(true);
		// The column already parts them: the second set starts at the first slot past it, no gap slot.
		expect(mine[4]!.x).toBeCloseTo(okeyMyMeldInner + TILE.width / 2, 9);
		for (let index = 1; index < 7; index++) expect(mine[index]!.x).toBeGreaterThan(mine[index - 1]!.x);
		expect(mine[1]!.x - mine[0]!.x).toBeCloseTo(pitch, 9);
		// The third set waits in the second row, out where my sight line clears the first row (item 5).
		for (const c of mine.slice(7)) expect(c.z).toBeCloseTo(okeyMySecondRowZ, 9);
		// The 101 pile (20 at most: three towers) stays inside the column my strip leaves open.
		for (const tile of of(tiles, 'pile'))
			expect(Math.abs(tile.x) + TILE.width / 2).toBeLessThanOrEqual(okeyMyMeldInner);

		// A watcher sees the edge they sit behind laid out the same way (the rule follows the perspective, not me).
		const watcher = layout(
			okeyView({me: null, okey101: true, game: {melds, opened: ['sets', 'none', 'sets', 'none']}}),
			{
				rack: [],
			},
		);
		expect(
			of(watcher.tiles, 'meld')
				.filter((tile) => tile.owner === 1)
				.map((tile) => okeyTileCentre(tile, TILE).z.toFixed(6)),
		).toEqual(mine.map((c) => c.z.toFixed(6)));
	});

	it('my 101 strip, three rows deep, clears the pile, the indicator, every discard pile and the other strips (two rows each)', () => {
		const run = (id: number, owner: number, from: number, length: number) => ({
			id,
			owner,
			kind: 'run' as const,
			tiles: Array.from({length}, (_, index) => `t${from + index}`),
		});
		// Mine take four half rows and spill into a third row (0.06 m behind okeyMySecondRowZ); the far owner's fill both
		// their rows edge to edge, the side owners' take two rows. This pins the second row's depth from the far side: from
		// −0.28 out my third row lands on the far owner's second row (SeatedView okeyMySecondRowZ).
		const melds = [
			run(0, 1, 26, 4),
			run(1, 1, 30, 3),
			run(2, 1, 34, 3),
			run(9, 1, 38, 3),
			run(10, 1, 84, 3),
			run(3, 2, 44, 6),
			run(4, 2, 4, 6),
			run(5, 3, 13, 9),
			run(6, 3, 52, 9),
			run(7, 4, 65, 6),
			run(8, 4, 78, 6),
		];
		const discards = [
			['t91', 't92'],
			['t93', 't94'],
			['t95', 't96'],
			['t97', 't98'],
		];
		const view = okeyView({
			okey101: true,
			game: {melds, discards, pile_count: 20, opened: ['sets', 'sets', 'sets', 'sets']},
		});
		const {tiles} = layout(view);
		const mine = tiles.filter((tile) => tile.place === 'meld' && tile.owner === 1);
		const others = tiles.filter((tile) => tile.place !== 'rack' && !mine.includes(tile));
		expect(mine).toHaveLength(16);
		expect(new Set(mine.map((tile) => okeyTileCentre(tile, TILE).z.toFixed(4))).size).toBe(3);
		expect(others.filter((tile) => tile.place === 'meld')).toHaveLength(42);
		const clashes = mine.flatMap((tile) =>
			others
				.filter((other) => overlaps(footprint(tile), footprint(other)))
				.map((other) => `${other.place} ${other.owner} @ ${other.x.toFixed(3)},${other.z.toFixed(3)}`),
		);
		expect(clashes).toEqual([]);
	});

	it('far tiles tilt towards my eye (≤ 70°)', () => {
		const melds = [{id: 0, owner: 3, kind: 'run' as const, tiles: ['t30', 't31', 't32']}];
		const {tiles} = layout(
			okeyView({
				okey101: true,
				game: {melds, discards: [['t1'], ['t2'], ['t3'], ['t4']], opened: ['none', 'none', 'sets', 'none']},
			}),
		);
		const eye = {x: 0, y: OKEY_EYE.height, z: H + OKEY_EYE.back};
		const lying = tiles.filter(
			(tile) => tile.place === 'indicator' || tile.place === 'meld' || (tile.place === 'discard' && tiltOf(tile) > 0),
		);
		expect(lying.length).toBeGreaterThanOrEqual(8);
		for (const tile of lying) {
			const tilt = tiltOf(tile);
			expect(tilt).toBeGreaterThan(45 * DEG);
			expect(tilt).toBeLessThanOrEqual(70 * DEG + EPS);
			const c = okeyTileCentre(tile, TILE);
			const toEye = Math.atan2(eye.x - c.x, eye.z - c.z);
			expect(Math.abs(Math.atan2(Math.sin(tile.yaw - toEye), Math.cos(tile.yaw - toEye)))).toBeLessThan(1e-6);
		}
		// The far discard spots stay inside the corner probe: |x|, |z| ≤ h − 0.15. The two at my edge lie in the
		// corner square past my rack's end (±0.289 / 0.048 tile heights), nearer my eye than any probe spot.
		const rackEnd = (0.289 / 0.048) * TILE.height;
		for (const tile of of(tiles, 'discard')) {
			const c = okeyTileCentre(tile, TILE);
			if (c.z < 0)
				expect(Math.max(Math.abs(c.x), Math.abs(c.z))).toBeLessThanOrEqual(
					H - SEAT_READABILITY_PROBES.okeyDiscardInset + EPS,
				);
			else {
				expect(Math.min(Math.abs(c.x), c.z) - TILE.width / 2).toBeGreaterThan(rackEnd);
				expect(Math.max(Math.abs(c.x), c.z) + TILE.width / 2).toBeLessThan(H);
			}
		}
	});

	it('drop zones: rack cells, discard (mine), finish (centre), meld zone, meld ends', () => {
		const classic = layout(okeyView()).zones;
		expect(kinds(classic).filter((kind) => kind === 'rack_cell')).toHaveLength(30);
		expect(kinds(classic).filter((kind) => kind !== 'rack_cell')).toEqual(['discard_zone', 'finish_zone']);
		const zone = (zones: typeof classic, kind: TableDropTarget['kind']) =>
			zones.find((entry) => entry.target.kind === kind)!;
		const discard = zone(classic, 'discard_zone');
		expect(discard.x).toBeGreaterThan(0.3);
		expect(discard.z).toBeGreaterThan(0.3);
		const finish = zone(classic, 'finish_zone');
		expect(Math.hypot(finish.x, finish.z)).toBeLessThan(0.1);
		// Rack cells stand facing me; table zones lie flat.
		const cell0 = classic.find((entry) => entry.target.kind === 'rack_cell' && entry.target.cell === 0)!;
		expect([cell0.pitch, cell0.yaw]).toEqual([0, 0]);
		expect(discard.pitch).toBeCloseTo(-Math.PI / 2, 9);

		const melds = [{id: 7, owner: 2, kind: 'run' as const, tiles: ['t7', 't8', 't9']}];
		const zones101 = layout(okeyView({okey101: true, game: {melds, opened: ['sets', 'sets', 'none', 'none']}})).zones;
		expect(kinds(zones101).filter((kind) => kind !== 'rack_cell')).toEqual([
			'discard_zone',
			'meld_zone',
			'meld_end',
			'meld_end',
		]);
		expect(zones101.filter((entry) => entry.target.kind === 'meld_end').map((entry) => entry.target)).toEqual([
			{kind: 'meld_end', meldId: 7, at: 'start'},
			{kind: 'meld_end', meldId: 7, at: 'end'},
		]);
		// A new set goes on the middle, where classic okey finishes (in front of me my rack hid it).
		const meld = zone(zones101, 'meld_zone');
		expect([meld.x, meld.z, meld.width, meld.height]).toEqual([finish.x, finish.z, finish.width, finish.height]);
	});

	it('my strip never puts a set end over the indicator or the 101 pile (CR9)', () => {
		const {okeyMyMeldInner} = SEAT_READABILITY_PROBES;
		// Four tiles fill a left half row up to its inner slot; the next set starts in the right half row's first slot.
		const melds = [
			{id: 0, owner: 1, kind: 'run' as const, tiles: ['t30', 't31', 't32', 't33']},
			{id: 1, owner: 1, kind: 'run' as const, tiles: ['t40', 't41', 't42', 't43']},
		];
		const view = okeyView({okey101: true, game: {melds, opened: ['sets', 'none', 'none', 'none'], pile_count: 20}});
		const {tiles, zones} = layout(view);
		const mine = of(tiles, 'meld').map((tile) => okeyTileCentre(tile, TILE));
		expect(Math.max(...mine.slice(0, 4).map((c) => c.x))).toBeCloseTo(-(okeyMyMeldInner + TILE.width / 2), 9);
		expect(Math.min(...mine.slice(4).map((c) => c.x))).toBeCloseTo(okeyMyMeldInner + TILE.width / 2, 9);
		const ends = zones.filter((entry) => entry.target.kind === 'meld_end');
		for (const end of ends) expect(Math.abs(end.x), JSON.stringify(end.target)).toBeGreaterThanOrEqual(okeyMyMeldInner);
		// The outer ends stay; towards the middle there is no end (the 2D panel still adds there).
		expect(ends.map((entry) => entry.target)).toEqual([
			{kind: 'meld_end', meldId: 0, at: 'start'},
			{kind: 'meld_end', meldId: 1, at: 'end'},
		]);
	});

	it('staged 101 tiles leave the rack and wait as ghosts in my meld rows', () => {
		const melds = [{id: 4, owner: 2, kind: 'run' as const, tiles: ['t7', 't8', 't9']}];
		const view = okeyView({
			okey101: true,
			game: {melds, opened: ['sets', 'sets', 'none', 'none'], discards: [[], [], [], ['t10']]},
		});
		const stage: OkeyStage = {
			take: 't10',
			open: [['t0', 't1', 't2']],
			add: [{meld_id: 4, tiles: ['t20'], at: 'start'}],
		};
		const {tiles} = layout(view, {stage});
		const ghosts = of(tiles, 'ghost');
		expect(ghosts.map((tile) => tile.cell).sort((a, b) => a - b)).toEqual(
			['t0', 't1', 't2', 't10', 't20'].map((token) => okeyTileCell(token)).sort((a, b) => a - b),
		);
		expect(ghosts.every((tile) => tile.tint === 'ghost' && tile.source === null)).toBe(true);
		const rackTokens = of(tiles, 'rack').map((tile) => (tile.source?.kind === 'rack_tile' ? tile.source.tile : ''));
		for (const token of ['t0', 't1', 't2', 't20']) expect(rackTokens).not.toContain(token);
		// The taken tile left the left player's discard pile.
		expect(of(tiles, 'discard').filter((tile) => tile.owner === 4)).toEqual([]);
		// The opened set and the taken tile wait on my strip across the middle; the addition at the start of
		// the right player's run.
		const ghostOf = (token: string) => okeyTileCentre(ghosts.find((tile) => tile.cell === okeyTileCell(token))!, TILE);
		for (const token of ['t0', 't1', 't2', 't10'])
			expect(ghostOf(token).z).toBeCloseTo(SEAT_READABILITY_PROBES.okeyMyMeldZ, 9);
		const run = of(tiles, 'meld').map((tile) => okeyTileCentre(tile, TILE));
		expect(ghostOf('t20').x).toBeGreaterThan(0);
		expect(ghostOf('t20').z).toBeGreaterThan(Math.max(...run.map((c) => c.z)));
	});
});
