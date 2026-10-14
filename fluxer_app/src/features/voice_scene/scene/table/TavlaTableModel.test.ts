// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {DICE_ROLL_MS} from '@app/features/voice_scene/scene/table/DiceAnimation';
import type {TableGame3DModel, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {createTavlaTableModel, TAVLA_CHECKER_COLORS} from '@app/features/voice_scene/scene/table/TavlaTableModel';
import {
	spotPosition,
	TAVLA_REPLAY_MS,
	tavlaBoardGeometry,
	tavlaLayout,
	tavlaStacks,
} from '@app/features/voice_scene/scene/table/tavlaLayout';
import type {TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameView, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	BoxGeometry,
	Color,
	CylinderGeometry,
	Group,
	InstancedMesh,
	type Light,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	Object3D,
	Quaternion,
	Vector3,
} from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';

// The parts file as GLTFLoader gives it (masa-parcalari.glb rev 2 sizes): tavla_board with its tp_* empties, the
// checker, and the die as body + pips. Meshes stand on y = 0 like the file's.
function basic(name: string): MeshBasicMaterial {
	const material = new MeshBasicMaterial();
	material.name = name;
	return material;
}
const TP: Record<string, [number, number, number]> = {
	tp_bar_w: [0, 0.012, 0.07],
	tp_bar_b: [0, 0.012, -0.07],
	tp_off_w: [0.28, 0.018, 0.115],
	tp_off_b: [-0.28, 0.018, -0.115],
};
for (let point = 1; point <= 24; point++) {
	const nearEdge = point <= 12;
	const k = nearEdge ? point : 25 - point;
	const x = k <= 6 ? 0.246 - 0.04 * (k - 1) : -0.046 - 0.04 * (k - 7);
	TP[`tp_${String(point).padStart(2, '0')}`] = [x, 0.012, nearEdge ? 0.188 : -0.188];
}

function fakeParts() {
	const board = new Mesh(new BoxGeometry(0.6, 0.026, 0.44).translate(0, 0.013, 0), basic('board'));
	board.name = 'tavla_board';
	for (const [name, [x, y, z]] of Object.entries(TP)) {
		const empty = new Object3D();
		empty.name = name;
		empty.position.set(x, y, z);
		board.add(empty);
	}
	const checker = new Mesh(new CylinderGeometry(0.0175, 0.0175, 0.0075, 12).translate(0, 0.00375, 0), basic('checker'));
	checker.name = 'tavla_checker';
	const die = new Group();
	die.name = 'tavla_die';
	die.add(
		new Mesh(new BoxGeometry(0.016, 0.016, 0.016).translate(0, 0.008, 0), basic('die')),
		new Mesh(new BoxGeometry(0.0161, 0.0161, 0.0161).translate(0, 0.008, 0), basic('pip')),
	);
	const nodes = new Map<string, Object3D>();
	for (const root of [board, checker, die]) root.traverse((object) => object.name && nodes.set(object.name, object));
	const shared = [board, checker, ...die.children].map((object) => object as Mesh);
	const parts: TableParts = {
		geometry: () => {
			throw new Error('the tavla model reads its parts by node');
		},
		material: () => {
			throw new Error('the tavla model reads its parts by node');
		},
		node: (name) => nodes.get(name) ?? null,
	};
	return {parts, shared};
}

function startPoints(): Array<number> {
	const points = new Array<number>(24).fill(0);
	for (const [point, count] of [
		[24, 2],
		[13, 5],
		[8, 3],
		[6, 5],
	] as const) {
		points[point - 1] = count;
		points[24 - point] = -count;
	}
	return points;
}

function view(game: Partial<TavlaView> | null, version: number, viewer: number | null = 1): TableGameView {
	return {
		summary: {
			slot: 'T01',
			game: 'tavla',
			speed: 'normal',
			status: game ? 'playing' : 'lobby',
			players: [],
			spectator_count: 0,
			version,
			result: null,
		},
		game_view: game
			? {
					game: 'tavla',
					white: 1,
					points: startPoints(),
					bar: {white: 0, black: 0},
					off: {white: 0, black: 0},
					turn: 1,
					dice: [6, 5],
					opening: null,
					deadline_at: null,
					last_moves: [],
					legal_moves: null,
					...game,
				}
			: null,
		viewer_position: viewer,
		spectating: viewer === null,
	};
}

function input(tableView: TableGameView, over: Partial<TableScene3DInput> = {}): TableScene3DInput {
	return {
		view: tableView,
		perspective: 1,
		rack: [],
		stage: null,
		pendingTavla: [],
		selection: null,
		targets: [],
		interactive: true,
		...over,
	};
}

let now = 1000;
vi.spyOn(performance, 'now').mockImplementation(() => now);

function mount() {
	const {parts, shared} = fakeParts();
	const model = createTavlaTableModel({
		parts,
		table: {center: {x: 2, y: 0.8, z: -1}, topSize: 1.3},
		game: 'tavla',
		requestRender: vi.fn(),
	});
	const instanced = () => {
		const found: Array<InstancedMesh> = [];
		model.root.traverse((object) => object instanceof InstancedMesh && found.push(object));
		return found;
	};
	return {model, parts, shared, instanced};
}

// Base centre of every drawn instance of `mesh` (the fake checker's base centre is its local origin).
function instancePositions(mesh: InstancedMesh): Array<Vector3> {
	const matrix = new Matrix4();
	return Array.from({length: mesh.count}, (_, index) => {
		mesh.getMatrixAt(index, matrix);
		return new Vector3().applyMatrix4(matrix);
	});
}
const checkerMeshes = (model: TableGame3DModel) => {
	const found: Array<InstancedMesh> = [];
	model.root.traverse(
		(object) => object instanceof InstancedMesh && object.userData.kind === 'checkers' && found.push(object),
	);
	return found;
};
const solid = (model: TableGame3DModel) => checkerMeshes(model).find((mesh) => !mesh.userData.ghost)!;

afterEach(() => {
	now = 1000;
});

const GEOMETRY = tavlaBoardGeometry({
	boardMin: {x: -0.3, y: 0, z: -0.22},
	boardMax: {x: 0.3, y: 0.026, z: 0.22},
	points: Array.from({length: 24}, (_, index) => {
		const [x, y, z] = TP[`tp_${String(index + 1).padStart(2, '0')}`]!;
		return {x, y, z};
	}),
	bar: {white: {x: 0, y: 0.012, z: 0.07}, black: {x: 0, y: 0.012, z: -0.07}},
	off: {white: {x: 0.28, y: 0.018, z: 0.115}, black: {x: -0.28, y: 0.018, z: -0.115}},
	checker: {diameter: 0.035, height: 0.0075},
});

describe('TavlaTableModel', () => {
	it("opponent's last_moves replay in order", () => {
		const {model} = mount();
		// I am white at position 1; black (3) is on turn and plays 6-5 with one checker: 1/7 7/12.
		const before = view({turn: 3, dice: [6, 5]}, 5);
		model.update(input(before));
		expect(model.animating()).toBe(false);
		const points = startPoints();
		points[0] = -1;
		points[11] = -6;
		const after = view(
			{
				turn: 1,
				dice: [3, 1],
				points,
				last_moves: [
					{from: 1, to: 7, hit: false},
					{from: 7, to: 12, hit: false},
				],
			},
			6,
		);
		model.update(input(after));
		const stepMs = TAVLA_REPLAY_MS / 2;
		const flight = (from: number, fromIndex: number, to: number, toIndex: number) => {
			const a = spotPosition(GEOMETRY, from, fromIndex).position;
			const b = spotPosition(GEOMETRY, to, toIndex).position;
			return {x: (a.x + b.x) / 2, z: (a.z + b.z) / 2};
		};
		const has = (point: {x: number; z: number}) =>
			instancePositions(solid(model)).some((p) => Math.abs(p.x - point.x) < 1e-6 && Math.abs(p.z - point.z) < 1e-6);
		// Halfway through the first step: the checker flies from 1 (top of two) to 7 (empty).
		now = 1000 + stepMs / 2;
		expect(model.animating()).toBe(true);
		expect(has(flight(0, 1, 6, 0))).toBe(true);
		// Halfway through the second: from 7 on to 12 (on top of five → the shown fifth slot, with a badge).
		now = 1000 + stepMs * 1.5;
		expect(model.animating()).toBe(true);
		expect(has(flight(6, 0, 11, 4))).toBe(true);
		expect(has(flight(0, 1, 6, 0))).toBe(false);
		// Done: the server's board exactly, one more frame to draw it, then none.
		now = 1000 + Math.max(TAVLA_REPLAY_MS, DICE_ROLL_MS);
		expect(model.animating()).toBe(true);
		now += 40;
		expect(model.animating()).toBe(false);
		const final = tavlaLayout(GEOMETRY, tavlaStacks(after.game_view as TavlaView, []), true).checkers;
		const drawn = instancePositions(solid(model));
		expect(drawn).toHaveLength(final.length);
		for (const checker of final)
			expect(
				drawn.some((p) => p.distanceTo(new Vector3(checker.position.x, checker.position.y, checker.position.z)) < 1e-6),
			).toBe(true);

		// My own move coming back from the server is not replayed (my ghosts already showed it).
		const mineBoard = [...points];
		mineBoard[23] = 1;
		mineBoard[17] = 1; // 24/18, a replay would land exactly here
		const mine = view({turn: 3, dice: [2, 2], points: mineBoard, last_moves: [{from: 24, to: 18, hit: false}]}, 7);
		model.update(input(mine));
		now += 40;
		expect(model.animating()).toBe(true); // black's dice roll in
		const settled = tavlaLayout(GEOMETRY, tavlaStacks(mine.game_view as TavlaView, []), true).checkers;
		const drawnNow = instancePositions(solid(model));
		expect(drawnNow).toHaveLength(settled.length);
		for (const checker of settled) // every checker already on its spot, none in flight
			expect(
				drawnNow.some(
					(p) => p.distanceTo(new Vector3(checker.position.x, checker.position.y, checker.position.z)) < 1e-6,
				),
			).toBe(true);
	});

	it('instances updated, not recreated', () => {
		const {model, instanced} = mount();
		model.update(input(view({}, 1)));
		const meshes = instanced();
		const children = model.root.children.length;
		expect(solid(model).count).toBe(30);
		const points = startPoints();
		points[23] = 1;
		points[17] = 1; // 24/18
		model.update(input(view({points, turn: 3, last_moves: [{from: 24, to: 18, hit: false}]}, 2)));
		model.update(input(view({points, turn: 3}, 2), {pendingTavla: [], targets: [{kind: 'tavla_point', point: 7}]}));
		expect(instanced()).toHaveLength(meshes.length);
		expect(instanced().every((mesh, index) => mesh === meshes[index])).toBe(true);
		expect(model.root.children.length).toBe(children);
		expect(solid(model).count).toBe(30);
		// A pending step moves a ghost; the solid instances stay the server's.
		model.update(input(view({}, 3), {pendingTavla: [{from: 24, to: 18}]}));
		const ghost = checkerMeshes(model).find((mesh) => mesh.userData.ghost)!;
		expect(ghost.count).toBe(1);
		expect(solid(model).count).toBe(29);
	});

	it('a roll keeps animating() true for ≤ 400 ms, then false (0 frames); dice settle on the server faces', () => {
		const {model} = mount();
		model.update(input(view({turn: 3, dice: [1, 1]}, 8)));
		expect(model.animating()).toBe(false);
		model.update(input(view({turn: 1, dice: [2, 5]}, 9)));
		now = 1100;
		expect(model.animating()).toBe(true);
		now = 1000 + DICE_ROLL_MS;
		expect(model.animating()).toBe(true); // the frame that draws the settled dice
		now += 40;
		expect(model.animating()).toBe(false);
		expect(model.animating()).toBe(false);
		const dice = (() => {
			const found: Array<InstancedMesh> = [];
			model.root.traverse(
				(object) => object instanceof InstancedMesh && object.userData.kind === 'dice' && found.push(object),
			);
			return found;
		})();
		expect(dice).toHaveLength(2); // body + pips: two draw calls for both dice
		const up = new Vector3(0, 1, 0);
		const faceOf = (index: number) => {
			const matrix = new Matrix4();
			dice[0]!.getMatrixAt(index, matrix);
			const q = new Quaternion();
			matrix.decompose(new Vector3(), q, new Vector3());
			// +Y=1, −Y=6, +X=3, −X=4, +Z=2, −Z=5 (GLB rev 3)
			const faces: Array<[number, Vector3]> = [
				[1, new Vector3(0, 1, 0)],
				[6, new Vector3(0, -1, 0)],
				[3, new Vector3(1, 0, 0)],
				[4, new Vector3(-1, 0, 0)],
				[2, new Vector3(0, 0, 1)],
				[5, new Vector3(0, 0, -1)],
			];
			return faces.find(([, normal]) => normal.applyQuaternion(q).dot(up) > 0.999)?.[0];
		};
		expect([faceOf(0), faceOf(1)]).toEqual([2, 5]);
		expect(dice.every((mesh) => mesh.count === 2)).toBe(true);
	});

	it('lobby: an empty board, no checkers, no dice (R2.j 4)', () => {
		const {model} = mount();
		model.update(input(view(null, 0)));
		expect(solid(model).count).toBe(0);
		const drawn: Array<Object3D> = [];
		model.root.traverse((object) => object instanceof Mesh && object.visible && drawn.push(object));
		expect(drawn.some((object) => object.userData.kind === 'board')).toBe(true);
		expect(drawn.some((object) => object.userData.kind === 'dice')).toBe(false);
		expect(model.pickables()).toEqual([]);
		expect(model.dropZones()).toHaveLength(25);
		expect(model.animating()).toBe(false);
	});

	it('the host owns the root transform; my side of the board faces +Z (R2.j 1)', () => {
		const {model} = mount();
		model.update(input(view({white: 3}, 1, 1)));
		expect(model.root.position.equals(new Vector3())).toBe(true);
		expect(model.root.rotation.y).toBe(0);
		const board = model.root.getObjectByProperty('name', 'tavla-board-yaw')!;
		expect(board.rotation.y).toBe(Math.PI); // white sits opposite me
		model.update(input(view({white: 1}, 2, 1)));
		expect(board.rotation.y).toBe(0);
		expect(model.root.rotation.y).toBe(0);
	});

	it('pickables carry tavla_point sources as visible proxies; drop zones are invisible flat meshes (R2.j 2, 3)', () => {
		const {model} = mount();
		model.update(input(view({}, 1)));
		const sources = model.pickables().map((object) => object.userData.source);
		expect(sources).toHaveLength(8); // 24, 13, 8, 6 white and 1, 12, 17, 19 black
		expect(sources).toContainEqual({kind: 'tavla_point', point: 13});
		for (const zone of model.dropZones()) {
			expect(zone).toBeInstanceOf(Mesh);
			expect(((zone as Mesh).material as MeshBasicMaterial).visible).toBe(false);
			expect(zone.userData.target).toBeDefined();
		}
		// A proxy costs no draw call at rest; while the host carries it, it shows and that checker's instance goes.
		const proxy = model.pickables().find((object) => object.userData.source.point === 13)!;
		expect(proxy.visible).toBe(false);
		expect(model.animating()).toBe(false);
		const rest = proxy.position.clone();
		proxy.position.x += 0.1; // the host's beforeDraw moved it under the pointer
		expect(model.animating()).toBe(true); // one frame to show the change
		expect(proxy.visible).toBe(true);
		expect(solid(model).count).toBe(29);
		expect(instancePositions(solid(model)).some((p) => p.distanceTo(rest) < 1e-6)).toBe(false);
		expect(model.animating()).toBe(false);
		proxy.position.copy(rest); // dropped or cancelled: the host puts it back
		expect(model.animating()).toBe(true);
		expect(proxy.visible).toBe(false);
		expect(solid(model).count).toBe(30);
		expect(model.animating()).toBe(false);
	});

	it('≤ 2 draw calls per kind: checkers and dice are InstancedMesh, unlit, no lights', () => {
		const {model} = mount();
		model.update(input(view({}, 1)));
		const lights: Array<Light> = [];
		const materials = new Set<string>();
		model.root.traverse((object) => {
			if ((object as Light).isLight) lights.push(object as Light);
			if (object instanceof Mesh) for (const m of [object.material].flat()) materials.add(m.type);
		});
		expect(lights).toEqual([]);
		expect([...materials].every((type) => type === 'MeshBasicMaterial')).toBe(true);
		expect(checkerMeshes(model)).toHaveLength(2); // solid + ghost
	});

	it('checkers part from the wood field ≥ 2.5:1 in both colours (A1; the points are the GLB texture’s)', () => {
		// masa-parcalari rev 2, measured from the file: tavla_checker's top face bakes to sRGB 242/255 (median), the
		// board's wood field between the points reaches relative luminance 0.31 (p90 of atlas_board's playing surface).
		// Its cream (L ≈ 0.54) and dark (L ≈ 0.05) points match the checker colours; their mid tones are the next parts
		// revision's (DUZELTME-ADAY).
		const CHECKER_TOP_BAKE = 242 / 255;
		const FIELD_LUMINANCE = 0.31;
		const luminance = (color: Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b; // linear
		const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		const lit = (color: Color) =>
			luminance(color.clone().multiplyScalar(new Color().setRGB(CHECKER_TOP_BAKE, 0, 0, 'srgb').r));
		expect(contrast(lit(TAVLA_CHECKER_COLORS.white), FIELD_LUMINANCE)).toBeGreaterThanOrEqual(2.5);
		expect(contrast(lit(TAVLA_CHECKER_COLORS.black), FIELD_LUMINANCE)).toBeGreaterThanOrEqual(2.5);
		expect(lit(TAVLA_CHECKER_COLORS.white)).toBeGreaterThan(FIELD_LUMINANCE);
		expect(lit(TAVLA_CHECKER_COLORS.black)).toBeLessThan(FIELD_LUMINANCE);
		// The drawn instances carry exactly these colours.
		const {model} = mount();
		model.update(input(view({}, 1)));
		const colours = new Set<string>();
		const mesh = solid(model);
		const colour = new Color();
		for (let index = 0; index < mesh.count; index++) {
			mesh.getColorAt(index, colour);
			colours.add(`#${colour.getHexString()}`);
		}
		expect(colours).toEqual(
			new Set([`#${TAVLA_CHECKER_COLORS.white.getHexString()}`, `#${TAVLA_CHECKER_COLORS.black.getHexString()}`]),
		);
	});

	it('checkers are drawn at the board geometry’s diameter (they grow with the board, F-vis-board)', () => {
		const {model, parts} = mount();
		model.update(input(view({}, 1)));
		const geometry = (parts.node('tavla_checker') as Mesh).geometry;
		geometry.computeBoundingBox();
		const matrix = new Matrix4();
		solid(model).getMatrixAt(0, matrix);
		const drawn = geometry.boundingBox!.clone().applyMatrix4(matrix).getSize(new Vector3());
		expect(GEOMETRY.checker.diameter).toBeGreaterThan(0.04);
		expect(Math.max(drawn.x, drawn.z)).toBeCloseTo(GEOMETRY.checker.diameter, 6);
	});

	it('dispose leaves the shared parts untouched', () => {
		const {model, shared} = mount();
		model.update(input(view({}, 1)));
		const spies = shared.flatMap((mesh) => [
			vi.spyOn(mesh.geometry, 'dispose'),
			vi.spyOn(mesh.material as MeshBasicMaterial, 'dispose'),
		]);
		model.dispose();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(model.root.children).toEqual([]);
	});
});
