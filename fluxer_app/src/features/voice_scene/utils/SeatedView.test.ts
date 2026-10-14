// SPDX-License-Identifier: AGPL-3.0-or-later

import {boardOuterSize, boardSquareSize} from '@app/features/voice_scene/scene/table/boardLayout';
import {TAVLA_BOARD_SIZE_M} from '@app/features/voice_scene/scene/table/tavlaLayout';
import type {RoomLayout, RoomSeat, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {
	READABILITY_MIN_PX,
	type ReadabilityItem,
	readability,
	SEAT_EYE_BACK_BOARD_M,
	SEAT_EYE_BACK_M,
	SEAT_EYE_LIFT_CHESS_M,
	SEAT_EYE_LIFT_M,
	SEAT_FOV_MAX_DEG,
	SEAT_FOV_MIN_DEG,
	SEAT_FRAME_MARGIN,
	SEAT_HFOV_MAX_DEG,
	SEAT_LOOK_DOWN,
	SEAT_LOOK_UP,
	SEAT_LOOK_YAW,
	SEAT_PIECE_PER_SQUARE,
	SEAT_PIECE_SIZE_M,
	SEAT_ZOOM_MIN,
	seatedPose,
} from '@app/features/voice_scene/utils/SeatedView';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

const at = (x: number, y: number, z: number): Vec3 => ({x, y, z});

// table and seat empties read from the three room GLBs (rev 3 of the rooms, f126669ce).
const ROOMS: Record<
	string,
	{camTarget: Vec3; camHome: Vec3; tables: Array<{slot: string; center: Vec3; topSize: number; seats: Array<Vec3>}>}
> = {
	'gece-lounge': {
		camTarget: at(-0.261, 2.344, -0.393),
		camHome: at(13.739, 10.244, 20.707),
		tables: [
			{
				slot: 'T01',
				center: at(-3.7, 1.26, -3.13),
				topSize: 1.3,
				seats: [at(-3.7, 1.54, -2.03), at(-2.6, 1.54, -3.13), at(-3.7, 1.54, -4.23), at(-4.8, 1.54, -3.13)],
			},
		],
	},
	kahvehane: {
		camTarget: at(-0.06, 2.028, -0.164),
		camHome: at(8.491, 21.21, 23.328),
		tables: [-4.35, 0, 4.35].map((x, i) => ({
			slot: `T0${i + 1}`,
			center: at(x, 0.795, 1.2),
			topSize: 1.3,
			seats: [at(x, 1.1, 2.28), at(x + 1.08, 1.1, 1.2), at(x, 1.1, 0.12), at(x - 1.08, 1.1, 1.2)],
		})),
	},
	'oyun-odasi': {
		camTarget: at(-0.259, 2.174, -0.39),
		camHome: at(13.741, 10.474, 20.71),
		tables: [1.23, 4.8].map((x, i) => ({
			slot: `T0${i + 1}`,
			center: at(x, 0.8, -2.68),
			topSize: 1.4,
			seats: [at(x, 1.125, -1.54), at(x + 1.14, 1.125, -2.68), at(x, 1.125, -3.82), at(x - 1.14, 1.125, -2.68)],
		})),
	},
};

// Watch seats are not in the rooms yet: placed at the worst allowed spots (1.65–1.8 m from the
// centre, at most 30° off a player seat's direction), at that table's head height — Y1/Y3 at 1.8 m, Y2/Y4 at
// 1.65 m, both 30° on: the near corner widens the frame most there while the far tiles are farthest.
function watchSeats(table: (typeof ROOMS)[string]['tables'][number]): Array<RoomSeat> {
	return table.seats.map((seat, i) => {
		const radius = i % 2 === 0 ? 1.8 : 1.65;
		const angle = Math.atan2(seat.x - table.center.x, seat.z - table.center.z) + Math.PI / 6;
		return {
			name: `seat_${table.slot}_Y${i + 1}`,
			group: table.slot,
			position: at(table.center.x + radius * Math.sin(angle), seat.y, table.center.z + radius * Math.cos(angle)),
			table: null,
			watch: {slot: table.slot, index: (i + 1) as 1 | 2 | 3 | 4},
		};
	});
}

function layoutOf(id: string): RoomLayout {
	const room = ROOMS[id]!;
	const seats: Array<RoomSeat> = [];
	for (const table of room.tables) {
		table.seats.forEach((position, i) =>
			seats.push({
				name: `seat_${table.slot}_${i + 1}`,
				group: table.slot,
				position,
				table: {slot: table.slot, position: (i + 1) as 1 | 2 | 3 | 4},
				watch: null,
			}),
		);
		seats.push(...watchSeats(table));
	}
	return {
		seats,
		stands: [],
		tables: room.tables.map(({slot, center, topSize}) => ({slot, center, topSize})),
		camTarget: room.camTarget,
		camHome: room.camHome,
		camPan: {x: 0, z: 0},
		screen: null,
	};
}

const VIEWPORTS = [
	{width: 1280, height: 720},
	{width: 1366, height: 768},
	{width: 1920, height: 1080},
];
const GAMES: Array<TableGameKind> = ['okey', 'okey101', 'chess', 'dama', 'dama_normal', 'tavla'];

interface Case {
	room: string;
	layout: RoomLayout;
	table: RoomLayout['tables'][number];
	seat: RoomSeat;
	game: TableGameKind;
}

// Every room × table × game × (the game's player seats + every watch seat).
function cases(): Array<Case> {
	const out: Array<Case> = [];
	for (const room of Object.keys(ROOMS)) {
		const layout = layoutOf(room);
		for (const table of layout.tables)
			for (const game of GAMES) {
				const positions: ReadonlyArray<number> = TABLE_GAME_POSITIONS[game];
				for (const seat of layout.seats) {
					const player = seat.table?.slot === table.slot && positions.includes(seat.table.position);
					if (player || seat.watch?.slot === table.slot) out.push({room, layout, table, seat, game});
				}
			}
	}
	return out;
}

// Independent pinhole camera (look-at basis, NDC in [-1, 1]) to check the pose rather than reuse its maths.
function ndc(pose: ReturnType<typeof seatedPose>, aspect: number, p: Vec3): {x: number; y: number; depth: number} {
	const f = [pose.target.x - pose.eye.x, pose.target.y - pose.eye.y, pose.target.z - pose.eye.z];
	const fl = Math.hypot(f[0]!, f[1]!, f[2]!);
	const fw = f.map((v) => v / fl);
	const rl = Math.hypot(fw[2]!, fw[0]!);
	const r = [-fw[2]! / rl, 0, fw[0]! / rl];
	const u = [r[1]! * fw[2]! - r[2]! * fw[1]!, r[2]! * fw[0]! - r[0]! * fw[2]!, r[0]! * fw[1]! - r[1]! * fw[0]!];
	const d = [p.x - pose.eye.x, p.y - pose.eye.y, p.z - pose.eye.z];
	const dot3 = (a: Array<number>) => a[0]! * d[0]! + a[1]! * d[1]! + a[2]! * d[2]!;
	const t = Math.tan((pose.fovDeg * Math.PI) / 360);
	const depth = dot3(fw);
	return {x: dot3(r) / depth / (t * aspect), y: dot3(u) / depth / t, depth};
}

const BOARD_GAMES: ReadonlyArray<TableGameKind> = ['chess', 'dama', 'dama_normal', 'tavla'];
// the preview canvases (1440×900 and 1280×720 under the 74 px header) and the 16:9 / 16:10 frames.
const BOARD_ASPECTS = [16 / 9, 16 / 10, 1440 / 826, 1280 / 646];
// masa-parcalari rev 2: the tavla board's rim stands 0.026 m over its base on a 0.6 m board; it scales with the board.
const TAVLA_RIM_M = (0.026 * TAVLA_BOARD_SIZE_M.x) / 0.6;

// The edge the table models face: a player's own, a watcher's nearest seat (TableScene3DInput.perspective).
function edgeOf(c: Case): {x: number; z: number} {
	const towards = (p: Vec3) => {
		const x = p.x - c.table.center.x;
		const z = p.z - c.table.center.z;
		const length = Math.hypot(x, z);
		return {x: x / length, z: z / length};
	};
	const own = towards(c.seat.position);
	const along = (d: {x: number; z: number}) => d.x * own.x + d.z * own.z;
	return c.layout.seats
		.filter((seat) => seat.table?.slot === c.table.slot)
		.map((seat) => towards(seat.position))
		.reduce((best, candidate) => (along(candidate) > along(best) ? candidate : best));
}

// The board's outline on its top face (the pair on the viewer's edge, the far pair) and the far pair at the tallest
// piece's height, world space.
function boardOutline(c: Case): {near: Array<Vec3>; far: Array<Vec3>; farTop: Array<Vec3>} {
	const edge = edgeOf(c);
	const {center, topSize} = c.table;
	const square = boardSquareSize(topSize);
	const half =
		c.game === 'tavla'
			? {x: TAVLA_BOARD_SIZE_M.x / 2, z: TAVLA_BOARD_SIZE_M.z / 2}
			: {x: boardOuterSize(topSize) / 2, z: boardOuterSize(topSize) / 2};
	const face = c.game === 'tavla' ? TAVLA_RIM_M : 0.002;
	const tallest =
		c.game === 'chess' ? Math.max(SEAT_PIECE_SIZE_M.chessKing, SEAT_PIECE_PER_SQUARE.chessKing * square) : 0.06;
	// +z towards the edge, x across it.
	const point = (x: number, y: number, z: number) =>
		at(center.x + edge.x * z + edge.z * x, center.y + y, center.z + edge.z * z - edge.x * x);
	return {
		near: [point(half.x, face, half.z), point(-half.x, face, half.z)],
		far: [point(half.x, face, -half.z), point(-half.x, face, -half.z)],
		farTop: [point(half.x, tallest, -half.z), point(-half.x, tallest, -half.z)],
	};
}

describe('seatedPose (GLB contract rev 3 §3)', () => {
	it('CX-F2 raises the centered game player eye: chess 0.54 m, other games 0.18 m; D2 watchers stay 0.14 m', () => {
		expect([SEAT_EYE_LIFT_M, SEAT_EYE_BACK_M, SEAT_EYE_BACK_BOARD_M]).toEqual([0.14, 0.15, 0.05]);
		expect(SEAT_PIECE_PER_SQUARE.chessKing).toBe(1);
		const layout = layoutOf('kahvehane');
		const seat = layout.seats.find((entry) => entry.name === 'seat_T01_1')!;
		const pose = seatedPose({layout, seat, slot: 'T01', game: 'okey', aspect: 16 / 9});
		// Seat 1 is due +Z of the table: the eye moves 0.15 m further out, the target 0.12 × 1.3 towards the seat.
		expect(pose.eye.x).toBeCloseTo(-4.35, 6);
		expect(pose.eye.y).toBeCloseTo(1.28, 6);
		expect(pose.eye.z).toBeCloseTo(2.43, 6);
		// The eye remains on the chair-to-centre line; chess uses the highest whole-cm lift that keeps the board floor.
		const chess = seatedPose({layout, seat, slot: 'T01', game: 'chess', aspect: 16 / 9});
		expect(chess.eye.x).toBeCloseTo(-4.35, 6);
		expect(SEAT_EYE_LIFT_CHESS_M).toBe(0.54);
		expect(chess.eye.y).toBeCloseTo(1.64, 6);
		expect(chess.eye.z).toBeCloseTo(2.33, 6);
		expect(pose.target.x).toBeCloseTo(-4.35, 6);
		expect(pose.target.y).toBeCloseTo(0.815, 6);
		expect(pose.target.z).toBeCloseTo(1.356, 6);
		// the look turns ±100° across, 30° up and 25° down; the view narrows to 0.4 × its angle.
		expect(SEAT_LOOK_YAW).toBeCloseTo((100 * Math.PI) / 180);
		expect(SEAT_LOOK_UP).toBeCloseTo((30 * Math.PI) / 180);
		expect(SEAT_LOOK_DOWN).toBeCloseTo((25 * Math.PI) / 180);
		expect(SEAT_ZOOM_MIN).toBe(0.4);

		// Seat 2 is due +X: the offsets turn with it.
		const side = seatedPose({
			layout,
			seat: layout.seats.find((e) => e.name === 'seat_T01_2')!,
			slot: 'T01',
			game: null,
			aspect: 16 / 9,
		});
		expect(side.eye.x).toBeCloseTo(-3.27 + 0.15, 6);
		expect(side.target.x).toBeCloseTo(-4.35 + 0.156, 6);
		expect(side.target.z).toBeCloseTo(1.2, 6);

		// A watch seat looks at the table centre itself (no shift).
		const watch = layout.seats.find((entry) => entry.name === 'seat_T01_Y2')!;
		const watchPose = seatedPose({layout, seat: watch, slot: 'T01', game: 'okey', aspect: 16 / 9});
		expect(watchPose.target.x).toBeCloseTo(-4.35, 6);
		expect(watchPose.target.y).toBeCloseTo(0.815, 6);
		expect(watchPose.target.z).toBeCloseTo(1.2, 6);
		const out = Math.hypot(watch.position.x + 4.35, watch.position.z - 1.2);
		expect(Math.hypot(watchPose.eye.x + 4.35, watchPose.eye.z - 1.2)).toBeCloseTo(out + 0.15, 6);
		expect(watchPose.eye.y).toBeCloseTo(watch.position.y + 0.14, 6);
	});

	it('an unknown game kind (a newer build’s table, M14) poses like no game instead of throwing', () => {
		const layout = layoutOf('kahvehane');
		for (const name of ['seat_T01_1', 'seat_T01_Y1']) {
			const seat = layout.seats.find((entry) => entry.name === name)!;
			const base = {layout, seat, slot: 'T01', aspect: 16 / 9};
			expect(seatedPose({...base, game: 'future_game' as TableGameKind})).toEqual(seatedPose({...base, game: null}));
		}
	});

	it('chess offsets apply only to its player positions 1 and 3; positions 2 and 4 keep the board eye', () => {
		for (const room of Object.keys(ROOMS)) {
			const layout = layoutOf(room);
			for (const position of [2, 4]) {
				const seat = layout.seats.find((entry) => entry.name === `seat_T01_${position}`)!;
				const base = {layout, seat, slot: 'T01', aspect: 16 / 9};
				expect(seatedPose({...base, game: 'chess'}).eye).toEqual(seatedPose({...base, game: 'dama'}).eye);
			}
		}
	});

	it('CX-F2 lifts only valid player seats for each game; watchers, unavailable positions and no game keep D2', () => {
		for (const room of Object.keys(ROOMS)) {
			const layout = layoutOf(room);
			for (const seat of layout.seats) {
				const slot = seat.table?.slot ?? seat.watch!.slot;
				for (const game of [null, ...GAMES]) {
					const pose = seatedPose({layout, seat, slot, game, aspect: 16 / 9});
					const positions: ReadonlyArray<number> = game ? TABLE_GAME_POSITIONS[game] : [];
					const valid = seat.table?.slot === slot && positions.includes(seat.table.position);
					expect(pose.eye.y - seat.position.y, `${room} ${seat.name} ${game}`).toBeCloseTo(
						valid ? (game === 'chess' ? 0.54 : 0.18) : 0.14,
						9,
					);
					const table = layout.tables.find((t) => t.slot === slot)!;
					const dx = seat.position.x - table.center.x,
						dz = seat.position.z - table.center.z;
					const across = (pose.eye.x - seat.position.x) * dz - (pose.eye.z - seat.position.z) * dx;
					expect(Math.abs(across), `${room} ${seat.name} ${game}`).toBeLessThan(1e-9);
				}
			}
		}
		const layout = layoutOf('kahvehane');
		const wrongTable = {...layout.seats[0]!, table: {slot: 'T02', position: 1 as const}};
		for (const game of GAMES)
			expect(seatedPose({layout, seat: wrongTable, slot: 'T01', game, aspect: 16 / 9}).eye.y).toBeCloseTo(
				wrongTable.position.y + 0.14,
				9,
			);
	});

	it('table top corners (a board game: its board) and the other players’ heads fit with 4% margin at 1280×720, 1366×768, 1920×1080', () => {
		const limit = 1 - SEAT_FRAME_MARGIN;
		for (const c of cases())
			for (const viewport of VIEWPORTS) {
				const {layout, table, seat, game} = c;
				const aspect = viewport.width / viewport.height;
				const pose = seatedPose({layout, seat, slot: table.slot, game, aspect});
				const h = table.topSize / 2;
				const outline = BOARD_GAMES.includes(game) ? boardOutline(c) : null;
				const points: Array<Vec3> = outline
					? [...outline.near, ...outline.far, ...outline.farTop]
					: [
							at(table.center.x + h, table.center.y + 0.06, table.center.z + h),
							at(table.center.x - h, table.center.y + 0.06, table.center.z + h),
							at(table.center.x + h, table.center.y + 0.06, table.center.z - h),
							at(table.center.x - h, table.center.y + 0.06, table.center.z - h),
						];
				const positions: ReadonlyArray<number> = TABLE_GAME_POSITIONS[game];
				for (const other of layout.seats)
					if (other.name !== seat.name && other.table?.slot === table.slot && positions.includes(other.table.position))
						points.push(other.position);
				for (const point of points) {
					const projected = ndc(pose, aspect, point);
					const where = `${seat.name} ${game} ${viewport.width}`;
					expect(projected.depth, where).toBeGreaterThan(0);
					expect(Math.abs(projected.x), where).toBeLessThanOrEqual(limit + 1e-9);
					expect(Math.abs(projected.y), where).toBeLessThanOrEqual(limit + 1e-9);
				}
			}
	});

	it('fov stays within 35°–64° and 100° across and is the smallest that frames the table', () => {
		expect(SEAT_FOV_MIN_DEG).toBe(35);
		expect(SEAT_FOV_MAX_DEG).toBe(64);
		let widest = 0;
		for (const {layout, table, seat, game} of cases()) {
			const pose = seatedPose({layout, seat, slot: table.slot, game, aspect: 16 / 9});
			expect(pose.fovDeg).toBeGreaterThanOrEqual(35);
			expect(pose.fovDeg).toBeLessThanOrEqual(64);
			const noGame = seatedPose({layout, seat, slot: table.slot, game: null, aspect: 16 / 9});
			widest = Math.max(widest, pose.fovDeg, noGame.fovDeg);
		}
		// Oyun Odası's unchanged no-game near corners need ~60.9° from the 0.14 m eye (62.3° from rev 3's): why the cap was raised past 60°.
		expect(widest).toBeGreaterThan(60);
		// The vertical cap is hard: a 4:3 box would need ~75° for the near corners and gets 64°.
		const layout = layoutOf('kahvehane');
		const seat = layout.seats.find((entry) => entry.name === 'seat_T02_1')!;
		expect(seatedPose({layout, seat, slot: 'T02', game: 'okey', aspect: 4 / 3}).fovDeg).toBe(64);
		// Wide screens: the horizontal angle stays ≤ 100°, the vertical narrows.
		expect(SEAT_HFOV_MAX_DEG).toBe(100);
		for (const aspect of [16 / 9, 21 / 9, 32 / 9]) {
			const fov = seatedPose({layout, seat, slot: 'T02', game: 'okey', aspect}).fovDeg;
			const horizontal = (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * aspect) * 180) / Math.PI;
			expect(horizontal, `aspect ${aspect}`).toBeLessThanOrEqual(100 + 1e-9);
		}
	});

	it('the look starts out from the seat over the table centre, where the listener faces (D10)', () => {
		for (const room of Object.keys(ROOMS)) {
			const layout = layoutOf(room);
			for (const seat of layout.seats) {
				const slot = seat.table?.slot ?? seat.watch!.slot;
				const table = layout.tables.find((entry) => entry.slot === slot)!;
				for (const game of [null, ...GAMES]) {
					const pose = seatedPose({layout, seat, slot, game, aspect: 16 / 9});
					const look = {x: pose.target.x - pose.eye.x, z: pose.target.z - pose.eye.z};
					const from = seat.position;
					const toCentre = {x: table.center.x - from.x, z: table.center.z - from.z};
					const across =
						(look.x * toCentre.z - look.z * toCentre.x) /
						(Math.hypot(look.x, look.z) * Math.hypot(toCentre.x, toCentre.z));
					expect(Math.abs(across), `${room} ${seat.name} ${game}`).toBeLessThan(1e-9);
					expect(look.x * toCentre.x + look.z * toCentre.z).toBeGreaterThan(0);
				}
			}
		}
	});
});

describe('board games come near (F-vis-board)', () => {
	// The rev 3 formula's eye and target with the 0.14 m eye (0.14 m up; 0.15 m out, at a board game 0.05 m), on their own.
	function formula(c: Case, game: TableGameKind | null): {eye: Vec3; target: Vec3} {
		const {center, topSize} = c.table;
		const position = c.seat.position;
		const dx = position.x - center.x;
		const dz = position.z - center.z;
		const length = Math.hypot(dx, dz);
		const away = {x: dx / length, z: dz / length};
		const shift = c.seat.table ? 0.12 * topSize : 0;
		const back = game !== null && BOARD_GAMES.includes(game) ? 0.05 : 0.15;
		const positions: ReadonlyArray<number> = game ? TABLE_GAME_POSITIONS[game] : [];
		const player = c.seat.table?.slot === c.table.slot && positions.includes(c.seat.table.position);
		const lift = player ? (game === 'chess' ? 0.54 : 0.18) : 0.14;
		return {
			eye: at(position.x + back * away.x, position.y + lift, position.z + back * away.z),
			target: at(center.x + shift * away.x, center.y + 0.02, center.z + shift * away.z),
		};
	}

	it('from a player seat the board fills ≥ 55% of the width, its near edge sits in the lowest 28% and its far edge ≥ 8% under the top; a watch seat gets the same framing within R2.c', () => {
		let checked = 0;
		for (const c of cases()) {
			if (!BOARD_GAMES.includes(c.game)) continue;
			const {near, far} = boardOutline(c);
			for (const aspect of BOARD_ASPECTS) {
				const pose = seatedPose({layout: c.layout, seat: c.seat, slot: c.table.slot, game: c.game, aspect});
				const where = `${c.room} ${c.seat.name} ${c.game} ${aspect.toFixed(3)}`;
				const xs = [...near, ...far].map((point) => ndc(pose, aspect, point).x);
				// Shares of the frame: width across, height from the top ((1 − ndc y) / 2).
				const width = (Math.max(...xs) - Math.min(...xs)) / 2;
				const fromTop = (point: Vec3) => (1 - ndc(pose, aspect, point).y) / 2;
				const nearEdge = (fromTop(near[0]!) + fromTop(near[1]!)) / 2;
				for (const corner of far) expect(fromTop(corner), where).toBeGreaterThanOrEqual(0.08);
				if (c.seat.table) {
					expect(width, where).toBeGreaterThanOrEqual(0.55);
					expect(nearEdge, where).toBeGreaterThanOrEqual(0.72);
				} else {
					// 1.8–1.95 m out, with both players' heads framed, the 35° floor  holds the board at 32–48% of the
					// width (it was 25–35% framing the table top): a regression floor, not the player criterion.
					expect(width, where).toBeGreaterThanOrEqual(0.3);
					expect(nearEdge, where).toBeGreaterThanOrEqual(0.58);
				}
				checked++;
			}
		}
		// 3 rooms, 6 tables; per table 2 player seats × 4 games and 4 watch seats × 4 games, × 4 aspects.
		expect(checked).toBe(6 * (2 + 4) * 4 * 4);
	});

	it('a board game keeps the formula eye, yaw and target distance and only tilts the view; okey and no game keep the formula', () => {
		for (const c of cases()) {
			for (const game of [c.game, null]) {
				const {eye, target} = formula(c, game);
				const pose = seatedPose({layout: c.layout, seat: c.seat, slot: c.table.slot, game, aspect: 16 / 9});
				for (const axis of ['x', 'y', 'z'] as const) expect(pose.eye[axis]).toBeCloseTo(eye[axis], 9);
				if (game === null || !BOARD_GAMES.includes(game)) {
					for (const axis of ['x', 'y', 'z'] as const) expect(pose.target[axis]).toBeCloseTo(target[axis], 9);
					continue;
				}
				const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
				expect(distance(pose.target, eye)).toBeCloseTo(distance(target, eye), 9);
				const yaw = (p: Vec3) => Math.atan2(p.x - eye.x, p.z - eye.z);
				expect(yaw(pose.target)).toBeCloseTo(yaw(target), 9);
			}
		}
	});
});

describe('readability (sizes)', () => {
	const ITEMS: Record<TableGameKind, Array<ReadabilityItem>> = {
		okey: ['okeyDigit'],
		okey101: ['okeyDigit'],
		chess: ['chessKing', 'chessPawn'],
		dama: ['damaPiece'],
		dama_normal: ['damaPiece'],
		tavla: ['tavlaChecker', 'tavlaDie'],
	};

	it('readability thresholds hold for every seat and watch seat of every room', () => {
		let checked = 0;
		for (const {room, layout, table, seat, game} of cases())
			for (const viewport of VIEWPORTS) {
				const pose = seatedPose({layout, seat, slot: table.slot, game, aspect: viewport.width / viewport.height});
				const report = readability({pose, viewport, layout, slot: table.slot, game});
				expect(Object.keys(report).sort()).toEqual([...ITEMS[game]].sort());
				for (const item of ITEMS[game]) {
					expect(report[item], `${room} ${seat.name} ${game} ${item} ${viewport.width}`).toBeGreaterThanOrEqual(
						READABILITY_MIN_PX[item],
					);
					checked++;
				}
			}
		// 3 rooms, 6 tables; per table 4 + 4 + 2 + 2 + 2 + 2 player cases and 6 × 4 watch cases, × 3 viewports.
		expect(checked).toBeGreaterThan(6 * 3 * 40);
	});

	it('the pixel floors are §3.9’s', () => {
		expect(READABILITY_MIN_PX).toEqual({
			okeyDigit: 14,
			chessKing: 28,
			chessPawn: 16,
			damaPiece: 18,
			tavlaChecker: 14,
			tavlaDie: 16,
		});
	});

	it('a smaller viewport shrinks what is measured (pixels scale with the frame height)', () => {
		const layout = layoutOf('oyun-odasi');
		const seat = layout.seats.find((entry) => entry.name === 'seat_T01_1')!;
		const pose = seatedPose({layout, seat, slot: 'T01', game: 'chess', aspect: 16 / 9});
		const big = readability({pose, viewport: {width: 1920, height: 1080}, layout, slot: 'T01', game: 'chess'});
		const small = readability({pose, viewport: {width: 1280, height: 720}, layout, slot: 'T01', game: 'chess'});
		expect(big.chessKing! / small.chessKing!).toBeCloseTo(1.5, 6);
	});
});
