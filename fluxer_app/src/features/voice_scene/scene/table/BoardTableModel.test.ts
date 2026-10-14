// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {START_FEN} from '@app/features/table_game/state/TableGameTestViews';
import {
	BOARD_MOVE_MS,
	BOARD_PALETTE,
	createBoardTableModel,
	drawBoardTexture,
	PIECE_BAKE_GAIN,
} from '@app/features/voice_scene/scene/table/BoardTableModel';
import {boardOuterSize, boardSquareSize, squarePosition} from '@app/features/voice_scene/scene/table/boardLayout';
import type {TableGame3DModel, TablePartName, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {RoomLayout, TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_PER_SQUARE, SEAT_PIECE_SIZE_M} from '@app/features/voice_scene/utils/SeatedView';
import {damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	DamaView,
	TableGameKind,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	Box3,
	BoxGeometry,
	type BufferGeometry,
	Color,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	type Object3D,
	PerspectiveCamera,
	Raycaster,
	Vector2,
	Vector3,
} from 'three';
import {afterEach, beforeEach, describe, expect, it, type Mock, vi} from 'vitest';

// the ivory chess body reads at L 0.597–0.611 on screen with the gain at 1.8, i.e. the bake's
// shade there is ≈ 161/255 sRGB (its median is 167/255).
const PIECE_BAKE_SHADE = 161 / 255;

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
const {createTableGame3DHost} = await import('@app/features/voice_scene/scene/TableGame3DHost');

const TOP_SIZE = 1.3;
const SQUARE = boardSquareSize(TOP_SIZE);

// masa-parcalari rev2 measured sizes (dogrulama.txt): width × height × depth, base on y = 0.
const PART_SIZES: Record<string, [number, number, number]> = {
	piece_k: [0.038, 0.08, 0.038],
	piece_q: [0.038, 0.0735, 0.038],
	piece_r: [0.038, 0.057, 0.038],
	piece_b: [0.038, 0.071, 0.038],
	piece_n: [0.038, 0.06827, 0.03974],
	piece_p: [0.032, 0.0418, 0.032],
	piece_dm: [0.041, 0.012, 0.041],
	piece_dk: [0.041, 0.0235, 0.041],
};

const pieceMaterial = new MeshBasicMaterial({name: 'piece'});

function fakeParts(): TableParts {
	const geometries = new Map<string, BufferGeometry>();
	for (const [name, [w, h, d]] of Object.entries(PART_SIZES))
		geometries.set(name, new BoxGeometry(w, h, d).translate(0, h / 2, 0));
	return {
		geometry: (name: TablePartName) => {
			const geometry = geometries.get(name);
			if (!geometry) throw new Error(`no part ${name}`);
			return geometry;
		},
		material: (name: string) => {
			if (name !== 'piece') throw new Error(`no material ${name}`);
			return pieceMaterial;
		},
		node: () => null,
	};
}

interface Call {
	name: string;
	args: Array<unknown>;
	fillStyle: unknown;
}

function fakeContext() {
	const calls: Array<Call> = [];
	const context = new Proxy({fillStyle: '' as unknown} as Record<string, unknown>, {
		get(target, property: string) {
			if (property in target) return target[property];
			return (...args: Array<unknown>) => {
				calls.push({name: property, args, fillStyle: target.fillStyle});
			};
		},
		set(target, property: string, value) {
			target[property] = value;
			return true;
		},
	});
	return {context, calls};
}

function chess(over: Partial<ChessView> = {}): ChessView {
	return {
		game: 'chess',
		fen: START_FEN,
		white: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		legal_moves: null,
		in_check: false,
		...over,
	};
}

function damaBoard(cells: Record<string, string>): string {
	const board = Array<string>(64).fill('.');
	for (const [square, cell] of Object.entries(cells)) board[damaSquareIndex(square)] = cell;
	return board.join('');
}

function dama(over: Partial<DamaView> = {}): DamaView {
	return {
		game: 'dama',
		board: damaBoard({c3: 'w', d4: 'w', f6: 'b', b8: 'B'}),
		white: 1,
		turn: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		last_captured: [],
		legal_moves: null,
		...over,
	};
}

function input(gameView: TableGameView['game_view'], over: Partial<TableScene3DInput> = {}): TableScene3DInput {
	const game = gameView?.game ?? 'chess';
	return {
		view: {summary: {game}, game_view: gameView} as unknown as TableGameView,
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

let now = 0;
let requestRender: Mock<() => void>;

// What the renderer would draw: visible meshes whose ancestors are visible and whose material is visible.
function drawn(model: TableGame3DModel): Array<Mesh> {
	const result: Array<Mesh> = [];
	const walk = (object: Object3D): void => {
		if (!object.visible) return;
		if (object instanceof Mesh && (object.material as MeshBasicMaterial).visible) {
			if (!(object instanceof InstancedMesh) || object.count > 0) result.push(object);
		}
		for (const child of object.children) walk(child);
	};
	walk(model.root);
	return result;
}

interface Instance {
	geometry: BufferGeometry;
	white: boolean;
	position: Vector3; // root-local
	matrix: Matrix4; // root-local
}

function instances(model: TableGame3DModel): Array<Instance> {
	model.root.updateMatrixWorld(true);
	const white = new Color(BOARD_PALETTE.whitePiece).multiplyScalar(PIECE_BAKE_GAIN.white);
	const result: Array<Instance> = [];
	for (const mesh of drawn(model)) {
		if (!(mesh instanceof InstancedMesh)) continue;
		const material = mesh.material as MeshBasicMaterial;
		if (material.transparent) continue; // the marks
		for (let index = 0; index < mesh.count; index++) {
			const local = new Matrix4();
			mesh.getMatrixAt(index, local);
			const matrix = mesh.matrixWorld.clone().multiply(local);
			result.push({
				geometry: mesh.geometry,
				white: material.color.equals(white),
				position: new Vector3().setFromMatrixPosition(matrix),
				matrix,
			});
		}
	}
	return result;
}

const geometryOf = (model: TableGame3DModel, part: string) =>
	fakePartsCache.get(model)?.geometry(part as TablePartName);
const fakePartsCache = new WeakMap<TableGame3DModel, TableParts>();

function createWithParts(game: TableGameKind = 'chess') {
	const parts = fakeParts();
	const model = createBoardTableModel({
		parts,
		table: {center: {x: 0, y: 0.8, z: 0}, topSize: TOP_SIZE},
		game,
		requestRender,
	});
	fakePartsCache.set(model, parts);
	return model;
}

function instanceAt(model: TableGame3DModel, part: string, square: string): Instance | undefined {
	const {x, z} = squarePosition(square, SQUARE);
	return instances(model).find(
		(instance) =>
			instance.geometry === geometryOf(model, part) &&
			Math.abs(instance.position.x - x) < 1e-6 &&
			Math.abs(instance.position.z - z) < 1e-6,
	);
}

function worldSize(instance: Instance): Vector3 {
	return new Box3()
		.setFromBufferAttribute(instance.geometry.getAttribute('position') as never)
		.applyMatrix4(instance.matrix)
		.getSize(new Vector3());
}

beforeEach(() => {
	now = 1000;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	requestRender = vi.fn<() => void>();
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext().context as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('BoardTableModel', () => {
	it('≤ 2 draw calls per piece type (InstancedMesh per type × colour)', () => {
		const model = createWithParts('chess');
		model.update(input(chess()));
		const meshes = drawn(model);
		for (const part of ['piece_k', 'piece_q', 'piece_r', 'piece_b', 'piece_n', 'piece_p']) {
			const users = meshes.filter((mesh) => mesh.geometry === geometryOf(model, part));
			expect(users.length, part).toBe(2);
			for (const mesh of users) expect(mesh).toBeInstanceOf(InstancedMesh);
		}
		expect(instances(model)).toHaveLength(32);
		// Board + highlight quads + 12 piece meshes: the drag proxies and the 64 drop zones draw nothing.
		expect(meshes.length).toBeLessThanOrEqual(14);
		expect(model.pickables()).toHaveLength(32);
		for (const proxy of model.pickables()) expect(proxy.visible).toBe(false);

		const damaModel = createWithParts('dama');
		damaModel.update(input(dama()));
		const damaMeshes = drawn(damaModel);
		for (const part of ['piece_dm', 'piece_dk']) {
			const users = damaMeshes.filter((mesh) => mesh.geometry === geometryOf(damaModel, part));
			expect(users.length, part).toBeLessThanOrEqual(2);
		}
		expect(instances(damaModel)).toHaveLength(4);
		expect(damaMeshes.length).toBeLessThanOrEqual(6);
	});

	it('pieces grow with the squares (SEAT_PIECE_SIZE_M the floor) and stand inside the board', () => {
		const model = createWithParts('chess');
		model.update(input(chess()));
		const king = instanceAt(model, 'piece_k', 'e1')!;
		const pawn = instanceAt(model, 'piece_p', 'e2')!;
		const kingHeight = Math.max(SEAT_PIECE_SIZE_M.chessKing, SEAT_PIECE_PER_SQUARE.chessKing * SQUARE);
		// the smaller set (king 1 × square) rests on the king's 0.095 m floor at a 1.3 m top.
		expect(kingHeight).toBe(SEAT_PIECE_SIZE_M.chessKing);
		expect(worldSize(king).y).toBeCloseTo(kingHeight, 6);
		expect(worldSize(pawn).y).toBeGreaterThanOrEqual(SEAT_PIECE_SIZE_M.chessPawn - 1e-9);
		// SeatedView's readability takes the pawn at the floors' pawn: king of the grown king; the parts give more.
		expect(worldSize(pawn).y).toBeGreaterThanOrEqual(
			(kingHeight * SEAT_PIECE_SIZE_M.chessPawn) / SEAT_PIECE_SIZE_M.chessKing - 1e-9,
		);
		// The board plane: 8 squares and the frame, the size SeatedView frames.
		const plane = drawn(model).find((mesh) => !(mesh instanceof InstancedMesh))!;
		plane.geometry.computeBoundingBox();
		const planeSize = plane.geometry.boundingBox!.getSize(new Vector3());
		expect(planeSize.x).toBeCloseTo(boardOuterSize(TOP_SIZE), 6); // float32 vertices
		expect(planeSize.z).toBeCloseTo(boardOuterSize(TOP_SIZE), 6);
		for (const instance of instances(model)) {
			const box = new Box3()
				.setFromBufferAttribute(instance.geometry.getAttribute('position') as never)
				.applyMatrix4(instance.matrix);
			expect(Math.max(Math.abs(instance.position.x), Math.abs(instance.position.z))).toBeLessThanOrEqual(
				3.5 * SQUARE + 1e-6, // instance matrices are float32
			);
			// Each piece fits its square and stands on the board, not in the felt.
			expect(box.max.x - box.min.x).toBeLessThan(SQUARE);
			expect(box.min.y).toBeGreaterThan(0);
			expect(box.min.y).toBeLessThan(0.01);
		}

		const damaModel = createWithParts('dama');
		damaModel.update(input(dama()));
		const man = instanceAt(damaModel, 'piece_dm', 'c3')!;
		const king2 = instanceAt(damaModel, 'piece_dk', 'b8')!;
		const diameter = Math.max(SEAT_PIECE_SIZE_M.damaPiece, SEAT_PIECE_PER_SQUARE.damaPiece * SQUARE);
		expect(diameter).toBeGreaterThan(SEAT_PIECE_SIZE_M.damaPiece);
		expect(diameter).toBeLessThan(SQUARE);
		expect(worldSize(man).x).toBeCloseTo(diameter, 6);
		expect(worldSize(king2).x).toBeCloseTo(diameter, 6);
		expect(man.white).toBe(true);
		expect(king2.white).toBe(false);
	});

	it('my side towards +Z: the white king stands at my edge for white, at the far edge for black', () => {
		const model = createWithParts('chess');
		model.update(input(chess(), {perspective: 1}));
		const kingZ = () =>
			instances(model).find((instance) => instance.geometry === geometryOf(model, 'piece_k') && instance.white)!
				.position.z;
		expect(kingZ()).toBeCloseTo(3.5 * SQUARE, 6);
		model.update(input(chess(), {perspective: 3}));
		expect(kingZ()).toBeCloseTo(-3.5 * SQUARE, 6);
		model.update(input(chess({white: 3}), {perspective: 3}));
		expect(kingZ()).toBeCloseTo(3.5 * SQUARE, 6);
	});

	it('a move animates ≤ 400 ms then animating() false', () => {
		const model = createWithParts('chess');
		model.update(input(chess()));
		expect(model.animating()).toBe(false);
		const e2 = squarePosition('e2', SQUARE);
		const e4 = squarePosition('e4', SQUARE);
		const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
		model.update(input(chess({fen: after, last_move: 'e2e4'})));
		const pawnZ = () => {
			const pawns = instances(model).filter(
				(instance) => instance.geometry === geometryOf(model, 'piece_p') && instance.white,
			);
			return pawns.find((pawn) => Math.abs(pawn.position.x - e2.x) < 1e-6)!.position.z;
		};
		expect(pawnZ()).toBeCloseTo(e2.z, 6);
		expect(model.animating()).toBe(true);
		now += BOARD_MOVE_MS / 2;
		expect(model.animating()).toBe(true);
		expect(pawnZ()).toBeLessThan(e2.z);
		expect(pawnZ()).toBeGreaterThan(e4.z);
		now += BOARD_MOVE_MS / 2;
		requestRender.mockClear();
		expect(model.animating()).toBe(false);
		expect(pawnZ()).toBeCloseTo(e4.z, 6);
		// The draw loop asks after drawing: the final pose needs one more frame.
		expect(requestRender).toHaveBeenCalledTimes(1);
		requestRender.mockClear();
		expect(model.animating()).toBe(false);
		expect(requestRender).not.toHaveBeenCalled();
		// The same view again (clock or spectator update) does not replay the move.
		model.update(input(chess({fen: after, last_move: 'e2e4'})));
		expect(model.animating()).toBe(false);
	});

	it('captured pieces leave the board', () => {
		const model = createWithParts('chess');
		const before = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
		model.update(input(chess({fen: before, last_move: 'd7d5'})));
		const meshesBefore = drawn(model).filter((mesh) => mesh instanceof InstancedMesh);
		expect(instanceAt(model, 'piece_p', 'd5')?.white).toBe(false);
		const after = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
		model.update(input(chess({fen: after, last_move: 'e4d5'})));
		now += BOARD_MOVE_MS;
		model.animating();
		expect(instances(model)).toHaveLength(31);
		expect(instanceAt(model, 'piece_p', 'd5')?.white).toBe(true);
		expect(instances(model).filter((i) => i.geometry === geometryOf(model, 'piece_p') && !i.white)).toHaveLength(7);
		// Same meshes, moved instances (no mesh is recreated for a move).
		for (const mesh of meshesBefore) expect(mesh.parent).not.toBeNull();
		expect(model.pickables()).toHaveLength(31);

		const damaModel = createWithParts('dama');
		damaModel.update(input(dama({board: damaBoard({c3: 'w', d4: 'b', d6: 'b'})})));
		damaModel.update(
			input(dama({board: damaBoard({c7: 'w'}), last_move: ['c3', 'e5', 'c7'], last_captured: ['d4', 'd6']})),
		);
		now += BOARD_MOVE_MS;
		damaModel.animating();
		expect(instances(damaModel)).toHaveLength(1);
		expect(instanceAt(damaModel, 'piece_dm', 'c7')?.white).toBe(true);
	});

	it('legal targets and the last move draw as quads in one transparent InstancedMesh', () => {
		const model = createWithParts('chess');
		model.update(
			input(chess({last_move: 'e2e4'}), {
				selection: {kind: 'square', square: 'g1'},
				targets: [
					{kind: 'square', square: 'f3'},
					{kind: 'square', square: 'h3'},
				],
			}),
		);
		const quads = drawn(model).filter((mesh) => (mesh.material as MeshBasicMaterial).transparent);
		expect(quads).toHaveLength(1);
		const marks = quads[0] as InstancedMesh;
		expect(marks.count).toBe(5); // e2, e4 tinted; g1 selected; f3, h3 targets
		model.root.updateMatrixWorld(true);
		const centres = Array.from({length: marks.count}, (_, index) => {
			const local = new Matrix4();
			marks.getMatrixAt(index, local);
			return new Vector3().setFromMatrixPosition(marks.matrixWorld.clone().multiply(local));
		});
		for (const square of ['e2', 'e4', 'g1', 'f3', 'h3']) {
			const {x, z} = squarePosition(square, SQUARE);
			expect(
				centres.some((c) => Math.abs(c.x - x) < 1e-6 && Math.abs(c.z - z) < 1e-6),
				square,
			).toBe(true);
		}
		model.update(input(chess()));
		expect(drawn(model).some((mesh) => (mesh.material as MeshBasicMaterial).transparent)).toBe(false);
	});

	it('procedural board texture has 64 squares', () => {
		const {context, calls} = fakeContext();
		const canvas = {width: 0, height: 0, getContext: () => context} as unknown as HTMLCanvasElement;
		drawBoardTexture(canvas);
		expect(canvas.width).toBe(canvas.height);
		// One fill for the frame, then the squares inside it.
		const squares = calls.filter((call) => call.name === 'fillRect' && call.args[2] !== canvas.width);
		expect(squares).toHaveLength(64);
		const size = squares[0]!.args[2] as number;
		for (const square of squares) expect(square.args.slice(2)).toEqual([size, size]);
		expect(new Set(squares.map((square) => `${square.args[0]},${square.args[1]}`)).size).toBe(64);
		expect(size * 8).toBeLessThan(canvas.width);
		expect(new Set(squares.map((call) => call.fillStyle))).toEqual(new Set([BOARD_PALETTE.light, BOARD_PALETTE.dark]));
		// a8 (top left) is light, b8 dark: a1 is dark as on every chess and Normal dama board.
		expect(squares[0]!.fillStyle).toBe(BOARD_PALETTE.light);
		expect(squares[1]!.fillStyle).toBe(BOARD_PALETTE.dark);
		expect(squares[8]!.fillStyle).toBe(BOARD_PALETTE.dark);
	});

	it('board, pieces and felt keep apart (A1: piece on its own colour of square ≥ 2.5:1; frame on the green felt)', () => {
		const luminance = (color: Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b; // linear
		const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		const lit = (hex: string, gain: number, bake: number) =>
			luminance(new Color(hex).multiplyScalar(gain * new Color().setRGB(bake, 0, 0, 'srgb').r));
		const light = luminance(new Color(BOARD_PALETTE.light));
		const dark = luminance(new Color(BOARD_PALETTE.dark));
		const frame = luminance(new Color(BOARD_PALETTE.frame));
		// The weakest pairs: ivory on a light square, black on a dark one. Both squares sit in mid tones for it, so the
		// squares part at ~2:1 (the pieces' readability comes first). Each piece is taken where the
		// screen reads it worst: ivory on its chess body, in the bake's shade; black on its dama top face,
		// where the bake is all but white (taken as white).
		expect(
			contrast(lit(BOARD_PALETTE.whitePiece, PIECE_BAKE_GAIN.white, PIECE_BAKE_SHADE), light),
		).toBeGreaterThanOrEqual(2.5);
		expect(contrast(lit(BOARD_PALETTE.blackPiece, PIECE_BAKE_GAIN.black, 1), dark)).toBeGreaterThanOrEqual(2.5);
		expect(light).toBeGreaterThan(dark);
		expect(contrast(light, dark)).toBeGreaterThanOrEqual(1.8);
		// The table top felt's luminance band (0.08–0.35): the frame stays darker than any of it.
		for (const felt of [0.08, 0.35]) expect(contrast(frame, felt)).toBeGreaterThanOrEqual(1.5);
	});

	it('drop zones are the 64 squares; pickables carry their square and stay hidden until dragged', () => {
		const model = createWithParts('chess');
		model.update(input(chess()));
		model.root.updateMatrixWorld(true);
		const zones = model.dropZones();
		expect(zones).toHaveLength(64);
		const squares = new Set<string>();
		for (const zone of zones) {
			const target = zone.userData.target as {kind: string; square: string};
			expect(target.kind).toBe('square');
			squares.add(target.square);
			expect(((zone as Mesh).material as MeshBasicMaterial).visible).toBe(false);
			const {x, z} = squarePosition(target.square, SQUARE);
			const world = zone.getWorldPosition(new Vector3());
			expect(world.x).toBeCloseTo(x, 6);
			expect(world.z).toBeCloseTo(z, 6);
		}
		expect(squares.size).toBe(64);
		const sources = model.pickables().map((proxy) => (proxy.userData.source as {square: string}).square);
		expect(new Set(sources).size).toBe(32);
		expect(sources).toContain('e1');
	});

	it('square rays pick pawns behind tall pieces for either colour and rotated perspective; empty squares have no source', () => {
		for (const white of [1, 3] as const)
			for (const perspective of [1, 3] as const) {
				const model = createWithParts('chess');
				model.update(input(chess({white}), {perspective}));
				model.root.position.set(2, 0.8, -1);
				model.root.rotation.y = 0.55;
				model.root.updateMatrixWorld(true);
				const camera = new PerspectiveCamera(55, 16 / 9, 0.05, 100);
				camera.position.copy(model.root.localToWorld(new Vector3(0, 0.445, 1.13)));
				camera.lookAt(model.root.localToWorld(new Vector3(0, 0.02, 0)));
				camera.updateMatrixWorld();
				const ray = new Raycaster();
				const squareRay = (square: string) => {
					const zone = model.dropZones().find((zone) => zone.userData.target.square === square)!;
					const ndc = zone.getWorldPosition(new Vector3()).project(camera);
					ray.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
				};
				const rank = white === perspective ? '2' : '7';
				for (const file of ['d', 'e']) {
					const square = `${file}${rank}`;
					squareRay(square);
					// The old triangle-first selection hits my king/queen before this pawn's square.
					const physical = ray.intersectObjects(
						model.pickables().map((proxy) => {
							const mesh = new Mesh((proxy as Mesh).geometry, (proxy as Mesh).material);
							mesh.matrixWorld.copy(proxy.matrixWorld);
							mesh.userData.source = proxy.userData.source;
							return mesh;
						}),
						false,
					);
					expect(physical[0]?.object.userData.source.square).not.toBe(square);
					expect(ray.intersectObjects([...model.pickables()], false)[0]?.object.userData.source.square).toBe(square);
				}
				for (const proxy of model.pickables()) {
					const square = proxy.userData.source.square;
					squareRay(square);
					expect(ray.intersectObjects([...model.pickables()], false)[0]?.object).toBe(proxy);
				}
				squareRay('e4');
				expect(ray.intersectObjects([...model.pickables()], false)).toHaveLength(0);
				expect(ray.intersectObjects([...model.dropZones()], false)[0]?.object.userData.target.square).toBe('e4');
				model.dispose();
			}
	});

	it('a dragged piece shows its proxy instead of its instance; put back, the instance returns', () => {
		const model = createWithParts('chess');
		model.update(input(chess()));
		const proxy = model.pickables().find((p) => (p.userData.source as {square: string}).square === 'g1')!;
		const home = proxy.position.clone();
		// The host moves the pickable while dragging.
		proxy.position.set(home.x, 0.03, home.z - 0.1);
		requestRender.mockClear();
		expect(model.animating()).toBe(false);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(proxy.visible).toBe(true);
		expect(instances(model)).toHaveLength(31);
		expect(instanceAt(model, 'piece_n', 'g1')).toBeUndefined();
		// Dropped or cancelled: the host puts it back.
		proxy.position.copy(home);
		model.animating();
		expect(proxy.visible).toBe(false);
		expect(instances(model)).toHaveLength(32);
		requestRender.mockClear();
		model.animating();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it('lobby: an empty board with its 64 zones; dispose frees only what the model made', () => {
		const model = createWithParts('dama');
		model.update(input(null));
		expect(instances(model)).toHaveLength(0);
		expect(model.pickables()).toHaveLength(0);
		expect(model.dropZones()).toHaveLength(64);
		expect(drawn(model).length).toBeGreaterThanOrEqual(1); // the board
		const sharedDispose = vi.spyOn(pieceMaterial, 'dispose');
		model.dispose();
		expect(sharedDispose).not.toHaveBeenCalled();
	});

	it.each([
		[1, 1],
		[1, 3],
		[3, 1],
		[3, 3],
	] as const)(
		'with the real host, white %i perspective %i: square selection, hits and proxy drag agree',
		async (white, perspective) => {
			const center = {x: 2, y: 0.8, z: -1};
			const layout: RoomLayout = {
				seats: [1, 2, 3, 4].map((position) => {
					const angle = ((position - 1) * Math.PI) / 2;
					return {
						name: `seat_T01_${position}`,
						group: 'T01',
						position: {x: center.x + 1.08 * Math.sin(angle), y: 1.1, z: center.z + 1.08 * Math.cos(angle)},
						table: {slot: 'T01', position: position as 1 | 2 | 3 | 4},
						watch: null,
					};
				}),
				stands: [],
				tables: [{slot: 'T01', center, topSize: TOP_SIZE}],
				camTarget: {x: 0, y: 2, z: 0},
				camHome: {x: 10, y: 10, z: 10},
				camPan: {x: 0, z: 0},
				screen: null,
			};
			const [width, height] = [1280, 720];
			const camera = new PerspectiveCamera(55, width / height, 0.05, 100);
			const direction = perspective === 1 ? 1 : -1;
			camera.position.set(center.x, 1.245, center.z + direction * 1.13);
			camera.lookAt(center.x, center.y + 0.02, center.z);
			camera.updateMatrixWorld();
			const dom = document.createElement('div');
			dom.getBoundingClientRect = () => ({left: 0, top: 0, width, height}) as DOMRect;
			dom.setPointerCapture = () => {};
			dom.hasPointerCapture = () => false;
			let model: TableGame3DModel | null = null;
			const handler = {canDrag: vi.fn(() => true), onDragStart: vi.fn(), onDrop: vi.fn(), onSelect: vi.fn()};
			const host = createTableGame3DHost({
				parent: new Group(),
				camera,
				dom,
				layout,
				slot: 'T01',
				game: 'chess',
				factoryFor: () => (options) => {
					model = createBoardTableModel(options);
					return model;
				},
				parts: Promise.resolve(fakeParts()),
				requestRender,
			});
			host.setDragHandler(handler);
			host.update(input(chess({white}), {perspective}));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(model).not.toBeNull();
			const screenOf = (square: string, y: number) => {
				const zone = model!.dropZones().find((zone) => zone.userData.target.square === square)!;
				model!.root.parent!.updateMatrixWorld(true);
				const p = zone.getWorldPosition(new Vector3());
				p.y += y - 0.002;
				p.project(camera);
				return {clientX: ((p.x + 1) / 2) * width, clientY: ((1 - p.y) / 2) * height};
			};
			const pointer = (type: string, at: {clientX: number; clientY: number}) =>
				dom.dispatchEvent(new PointerEvent(type, {...at, pointerId: 1, button: 0, bubbles: true}));

			for (const file of ['d', 'e']) {
				const square = `${file}${white === perspective ? '2' : '7'}`;
				const at = screenOf(square, 0.002);
				expect(host.hits(at.clientX, at.clientY)).toBe(true);
				pointer('pointerdown', at);
				pointer('pointerup', at);
				expect(handler.onSelect).toHaveBeenLastCalledWith({kind: 'square', square});
			}
			const empty = screenOf('e4', 0.002);
			expect(host.hits(empty.clientX, empty.clientY)).toBe(false);
			pointer('pointerdown', empty);
			pointer('pointerup', empty);
			expect(handler.onSelect).toHaveBeenLastCalledWith({kind: 'square', square: 'e4'});
			host.update(input(chess({white, fen: '4k3/8/8/8/8/8/4P3/K7 w - - 0 1'}), {perspective}));
			pointer('pointerdown', screenOf('e2', 0.002));
			expect(handler.canDrag).toHaveBeenCalledWith({kind: 'square', square: 'e2'});
			pointer('pointermove', screenOf('e5', 0.03));
			host.beforeDraw();
			const proxy = model!.pickables().find((p) => (p.userData.source as {square: string}).square === 'e2')!;
			model!.animating(); // the frame after the first move: the proxy shows, the instance goes
			expect(proxy.visible).toBe(true);
			expect(instances(model!)).toHaveLength(2);
			pointer('pointermove', screenOf('e4', 0.002));
			host.beforeDraw();
			pointer('pointerup', screenOf('e4', 0.002));
			expect(handler.onDrop).toHaveBeenCalledExactlyOnceWith(
				{kind: 'square', square: 'e2'},
				{kind: 'square', square: 'e4'},
			);
			model!.animating();
			expect(proxy.visible).toBe(false);
			expect(instances(model!)).toHaveLength(3);
			host.dispose();
		},
	);
});
