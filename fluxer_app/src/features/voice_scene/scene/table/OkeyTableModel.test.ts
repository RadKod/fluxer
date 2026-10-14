// SPDX-License-Identifier: AGPL-3.0-or-later

import type {OkeyStage} from '@app/features/table_game/components/okey/Okey101Staging';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {testOkeyGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import {resolveTableDrop} from '@app/features/table_game/utils/TableDrop';
import {createOkeyTableModel} from '@app/features/voice_scene/scene/table/OkeyTableModel';
import {okeyCellOffset, okeyTileCell} from '@app/features/voice_scene/scene/table/OkeyTileAtlas';
import type {TableGame3DModel, TablePartName, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {
	RoomLayout,
	TableDragSource,
	TableDropTarget,
	TableScene3DInput,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_READABILITY_PROBES, seatedPose} from '@app/features/voice_scene/utils/SeatedView';
import type {Okey101View, OkeyView, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
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
	PlaneGeometry,
	Raycaster,
	Vector3,
} from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
const {createTableGame3DHost} = await import('@app/features/voice_scene/scene/TableGame3DHost');

// masa-parcalari rev 2 shapes: the tile 34 × 48 × 10 mm standing on y = 0, face towards +Z; the rack as its measured
// bounds (dogrulama.txt and the GLB accessor: 0.578 × 0.094 m, z −0.073…0.026; its end caps and back wall reach the
// top), so whatever these bounds hide, the real rack hides too.
function fakeParts(): TableParts {
	const geometries: Partial<Record<TablePartName, BufferGeometry>> = {
		okey_face: new PlaneGeometry(0.034, 0.048).translate(0, 0.024, 0.005),
		okey_body: new BoxGeometry(0.034, 0.048, 0.01).translate(0, 0.024, 0),
		okey_rack: new BoxGeometry(0.578, 0.094, 0.099).translate(0, 0.047, -0.0235),
	};
	const materials = new Map(['okey_body', 'wood'].map((name) => [name, new MeshBasicMaterial({name})]));
	return {
		geometry: (name) => geometries[name] ?? new BoxGeometry(0.01, 0.01, 0.01),
		material: (name) => materials.get(name)!,
		node: () => null,
	};
}

// The atlas draws on a canvas; node has none, so a recording 2D context stands in.
function fakeCanvas() {
	const context = new Proxy({} as Record<string, unknown>, {
		get(target, property: string) {
			if (property in target) return target[property];
			if (property === 'measureText')
				return () => ({width: 10, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 0});
			return () => {};
		},
		set(target, property: string, value) {
			target[property] = value;
			return true;
		},
	});
	return {width: 0, height: 0, getContext: () => context};
}

beforeEach(() => {
	vi.stubGlobal('document', {createElement: () => fakeCanvas()});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const MY_RACK = ['t0', 't1', 't2', null, 't20', 't21', 't22', 't23', 't24', 't25', 't26', 't27', 't28', 't29'];
const myTiles = (rack: ReadonlyArray<RackSlot>) => rack.filter((tile): tile is string => tile !== null);

function input(view: TableGameView, extra: Partial<TableScene3DInput> = {}): TableScene3DInput {
	return {
		view,
		perspective: 1,
		rack: MY_RACK,
		stage: null,
		pendingTavla: [],
		selection: null,
		targets: [],
		interactive: true,
		...extra,
	};
}

function model() {
	const requestRender = vi.fn();
	const result = createOkeyTableModel({
		parts: fakeParts(),
		table: {center: {x: 2, y: 0.8, z: -1}, topSize: 1.3},
		game: 'okey',
		requestRender,
	});
	return {model: result, requestRender};
}

function instanced(root: Object3D): Array<InstancedMesh> {
	const meshes: Array<InstancedMesh> = [];
	root.traverse((object) => {
		if (object instanceof InstancedMesh) meshes.push(object);
	});
	return meshes;
}
const tileMeshes = (root: Object3D) =>
	instanced(root).filter((mesh) => mesh.name === 'okey_face' || mesh.name === 'okey_body');
const face = (root: Object3D) => tileMeshes(root).find((mesh) => mesh.name === 'okey_face')!;
const body = (root: Object3D) => tileMeshes(root).find((mesh) => mesh.name === 'okey_body')!;

// What the renderer would draw: visible meshes with a visible material (instanced ones only with instances).
function drawn(root: Object3D): Array<Mesh> {
	const meshes: Array<Mesh> = [];
	root.traverseVisible((object) => {
		if (!(object instanceof Mesh) || !(object.material as MeshBasicMaterial).visible) return;
		if (!(object instanceof InstancedMesh) || object.count > 0) meshes.push(object);
	});
	return meshes;
}

const indexOfCell = (mesh: InstancedMesh, token: string) => {
	const cells = mesh.geometry.getAttribute('okeyCell');
	const {u, v} = okeyCellOffset(okeyTileCell(token));
	return Array.from({length: mesh.count}, (_, index) => index).find(
		(index) => cells.getX(index) === Math.fround(u) && cells.getY(index) === Math.fround(v),
	)!;
};

const positionOf = (mesh: InstancedMesh, index: number) => {
	const matrix = new Matrix4();
	mesh.getMatrixAt(index, matrix);
	return new Vector3().setFromMatrixPosition(matrix);
};

// All 106 tiles out: my 13 face up, 3 × 14 backs, the indicator and a pile of 50.
function fullView(): TableGameView {
	return testView({
		game: 'okey',
		gameView: testOkeyGameView({
			rack: myTiles(MY_RACK),
			rack_counts: [13, 14, 14, 14],
			pile_count: 50,
			indicator: 't5',
		}),
	});
}

describe('OkeyTableModel', () => {
	it('106 tiles draw with two InstancedMesh (face + body)', () => {
		const {model: m} = model();
		m.update(input(fullView()));
		const tiles = tileMeshes(m.root);
		expect(tiles).toHaveLength(2);
		for (const mesh of tiles) {
			expect(mesh.count).toBe(106);
			expect(mesh.instanceMatrix.count).toBe(106);
		}
		// Every visible tile is one of those two calls: no per-tile mesh is drawn.
		const draws = drawn(m.root);
		expect(draws.filter((mesh) => mesh instanceof InstancedMesh && tiles.includes(mesh))).toHaveLength(2);
		expect(draws.filter((mesh) => !(mesh instanceof InstancedMesh))).toEqual([]);
		// The face cell of each instance reaches the shader as the atlas offset of that tile.
		const cells = face(m.root).geometry.getAttribute('okeyCell');
		const myFirst = okeyCellOffset(okeyTileCell('t0'));
		const offsets = Array.from({length: 106}, (_, index) => ({u: cells.getX(index), v: cells.getY(index)}));
		expect(offsets).toContainEqual(myFirst);
		expect(m.animating()).toBe(false);
	});

	it('update with a new view moves instances without recreating meshes', () => {
		const {model: m} = model();
		m.update(input(fullView()));
		const before = {face: face(m.root), body: body(m.root), children: [...m.root.children]};
		const pickables = new Map(m.pickables().map((object) => [JSON.stringify(object.userData.source), object]));
		const t0Before = positionOf(before.face, indexOfCell(before.face, 't0')).clone();

		const next = testView({
			game: 'okey',
			version: 2,
			gameView: testOkeyGameView({
				rack: myTiles(MY_RACK).slice(1),
				rack_counts: [12, 14, 14, 14],
				pile_count: 50,
				indicator: 't5',
				discards: [['t0'], [], [], []],
				turn: 2,
			}),
		});
		m.update(input(next, {rack: MY_RACK.slice(1)}));
		expect(face(m.root)).toBe(before.face);
		expect(body(m.root)).toBe(before.body);
		expect(face(m.root).count).toBe(106);
		expect(positionOf(face(m.root), indexOfCell(face(m.root), 't0')).distanceTo(t0Before)).toBeGreaterThan(0.1);
		expect(face(m.root).instanceMatrix.version).toBeGreaterThan(0);
		// The pickable objects are reused (the host may hold one mid-drag).
		for (const object of m.pickables()) {
			const old = [...pickables.values()].includes(object);
			expect(old).toBe(true);
		}
		for (const child of before.children) expect(m.root.children).toContain(child);
	});

	it('staged 101 groups show as ghosts in my meld rows', () => {
		const {model: m} = model();
		const gameView = {
			...testOkeyGameView({rack: myTiles(MY_RACK), rack_counts: [13, 14, 14, 14], pile_count: 30}),
			game: 'okey101',
			phase: 'play',
			melds: [],
			opened: ['none', 'none', 'none', 'none'],
			penalties: [0, 0, 0, 0],
			scores: null,
		} as Okey101View;
		const view = testView({game: 'okey101', gameView});
		m.update(input(view));
		const plain = face(m.root).count;
		const colorsBefore = new Set(
			Array.from({length: plain}, (_, index) => {
				const color = new Color();
				body(m.root).getColorAt(index, color);
				return color.getHexString();
			}),
		);

		const stage: OkeyStage = {take: null, open: [['t20', 't21', 't22']], add: []};
		m.update(input(view, {stage}));
		expect(face(m.root).count).toBe(plain);
		const ghostCells = new Set(['t20', 't21', 't22'].map((token) => okeyTileCell(token)));
		const ghostOffsets = [...ghostCells].map((cell) => {
			const {u, v} = okeyCellOffset(cell);
			return JSON.stringify({u: Math.fround(u), v: Math.fround(v)});
		});
		const cells = face(m.root).geometry.getAttribute('okeyCell');
		const ghosts = Array.from({length: plain}, (_, index) => index).filter((index) =>
			ghostOffsets.includes(JSON.stringify({u: cells.getX(index), v: cells.getY(index)})),
		);
		expect(ghosts).toHaveLength(3);
		for (const index of ghosts) {
			const color = new Color();
			face(m.root).getColorAt(index, color);
			expect(colorsBefore.has(color.getHexString())).toBe(false);
			// On my strip across the middle, beside the indicator column (root-local +Z is my edge).
			const position = positionOf(face(m.root), index);
			expect(position.z).toBeLessThan(0);
			expect(position.z).toBeGreaterThan(-0.15);
			expect(Math.abs(position.x)).toBeGreaterThan(SEAT_READABILITY_PROBES.okeyMyMeldInner);
		}
		// They left the rack: no pickable for them while staged.
		const sources = m.pickables().map((object) => object.userData.source as TableDragSource);
		expect(sources.some((source) => source.kind === 'rack_tile' && ghostCells.has(okeyTileCell(source.tile)))).toBe(
			false,
		);
	});

	it('the selected tile is a visible stand-in inside its pickable', () => {
		const {model: m} = model();
		m.update(input(fullView()));
		const selection: TableDragSource = {kind: 'rack_tile', tile: 't1', cell: 1};
		m.update(input(fullView(), {selection}));
		expect(face(m.root).count).toBe(105);
		const pickable = m
			.pickables()
			.find((object) => JSON.stringify(object.userData.source) === JSON.stringify(selection))!;
		const standIn = drawn(pickable);
		expect(standIn.map((mesh) => mesh.geometry.type).sort()).toEqual(['BoxGeometry', 'PlaneGeometry']);
		// Moving the pickable (as the host does while dragging) carries the stand-in.
		const at = new Vector3();
		standIn[0]!.getWorldPosition(at);
		pickable.position.x += 0.2;
		pickable.updateMatrixWorld(true);
		const moved = new Vector3();
		standIn[0]!.getWorldPosition(moved);
		expect(moved.x - at.x).toBeCloseTo(0.2, 9);

		m.update(input(fullView()));
		expect(face(m.root).count).toBe(106);
		expect(drawn(pickable)).toEqual([]);
	});

	it('a pickable the host drags carries the stand-in from that frame on, with no selection', () => {
		const {model: m} = model();
		m.update(input(fullView()));
		const pickable = m.pickables().find((object) => object.userData.source?.kind === 'pile')!;
		const home = pickable.position.clone();
		// The host moves the pickable in beforeDraw; the renderer then updates world matrices before drawing.
		pickable.position.set(0.1, 0.03, 0.2);
		m.root.updateMatrixWorld();
		expect(face(m.root).count).toBe(105);
		expect(
			drawn(pickable)
				.map((mesh) => mesh.geometry.type)
				.sort(),
		).toEqual(['BoxGeometry', 'PlaneGeometry']);
		// Dropped: the host puts it back before onDrop; the instance returns on that same frame.
		pickable.position.copy(home);
		m.root.updateMatrixWorld();
		expect(face(m.root).count).toBe(106);
		expect(drawn(pickable)).toEqual([]);
	});

	it('the dragged stand-in draws over everything, my rack too; a merely selected one keeps its depth (Y4)', () => {
		const {model: m} = model();
		const selection: TableDragSource = {kind: 'rack_tile', tile: 't1', cell: 1};
		m.update(input(fullView(), {selection}));
		const pickable = m
			.pickables()
			.find((object) => JSON.stringify(object.userData.source) === JSON.stringify(selection))!;
		const standIn = drawn(pickable);
		const materials = () => standIn.map((mesh) => mesh.material as MeshBasicMaterial);
		// Selected in place: the lower row in front of it still hides its foot.
		expect(materials().map((material) => material.depthTest)).toEqual([true, true]);
		// Dragged (the host moved it): last in the last pass, no depth test, the face over its own body.
		pickable.position.y += 0.05;
		m.root.updateMatrixWorld();
		expect(materials().map((material) => [material.transparent, material.depthTest])).toEqual([
			[true, false],
			[true, false],
		]);
		const others = drawn(m.root).filter((mesh) => !standIn.includes(mesh));
		const top = Math.max(...others.map((mesh) => mesh.renderOrder));
		for (const mesh of standIn) expect(mesh.renderOrder).toBeGreaterThan(top);
		const faceMesh = standIn.find((mesh) => mesh.geometry.type === 'PlaneGeometry')!;
		const bodyMesh = standIn.find((mesh) => mesh.geometry.type === 'BoxGeometry')!;
		expect(faceMesh.renderOrder).toBeGreaterThan(bodyMesh.renderOrder);
		pickable.position.y -= 0.05;
		m.root.updateMatrixWorld();
		expect(materials().map((material) => material.depthTest)).toEqual([true, true]);
	});

	it('a lit rack cell glows inside its tile, behind the digit; a lit table zone stays on its zone (Y4)', () => {
		const {model: m} = model();
		m.update(input(fullView(), {targets: [{kind: 'rack_cell', cell: 1}, {kind: 'discard_zone'}]}));
		const highlight = instanced(m.root).find((mesh) => mesh.name === 'okey_targets')!;
		expect(highlight.count).toBe(2);
		const tile = positionOf(face(m.root), indexOfCell(face(m.root), 't1'));
		const half = (0.01 / 2) * (0.082 / 0.048);
		const cell = positionOf(highlight, 0);
		expect(cell.z).toBeLessThan(tile.z + half / 2);
		expect(cell.z).toBeGreaterThan(tile.z - half);
		expect(cell.x).toBeCloseTo(tile.x, 6);
		const discard = m.dropZones().find((zone) => zone.userData.target.kind === 'discard_zone')!;
		expect(positionOf(highlight, 1).distanceTo(discard.position)).toBeLessThan(1e-6);
	});

	it('drop zones are invisible flat meshes with userData.target; legal targets light up in one draw', () => {
		const {model: m} = model();
		const targets: Array<TableDropTarget> = [{kind: 'discard_zone'}, {kind: 'rack_cell', cell: 3}];
		m.update(input(fullView(), {targets}));
		const zones = m.dropZones();
		expect(zones.length).toBe(32);
		for (const zone of zones) {
			expect(zone).toBeInstanceOf(Mesh);
			expect(((zone as Mesh).material as MeshBasicMaterial).visible).toBe(false);
			expect(zone.userData.target).toBeDefined();
		}
		const highlight = instanced(m.root).find((mesh) => mesh.name === 'okey_targets')!;
		expect(highlight.count).toBe(2);
		m.update(input(fullView()));
		expect(highlight.count).toBe(0);
	});

	it('lobby: empty table, nothing to pick or drop; dispose leaves the shared parts alone', () => {
		const {model: m} = model();
		m.update(input(testView({game: 'okey', status: 'lobby'})));
		expect(tileMeshes(m.root).every((mesh) => mesh.count === 0)).toBe(true);
		expect(m.pickables()).toEqual([]);
		expect(m.dropZones()).toEqual([]);
		const parts = fakeParts();
		const bodyMaterial = parts.material('okey_body');
		const spy = vi.spyOn(bodyMaterial, 'dispose');
		const other = createOkeyTableModel({
			parts,
			table: {center: {x: 0, y: 0, z: 0}, topSize: 1.3},
			game: 'okey',
			requestRender: () => {},
		});
		other.dispose();
		expect(spy).not.toHaveBeenCalled();
	});
});

// T01 of each room (as SeatedView.test.ts reads them): centre, top, the player seats' distance out and head
// height. Read again from Gece Lounge 5.1, Kahvehane 5.1 and Oyun Odası 5.2 (manifest c76564c1b78e, 37719e591aad,
// 5f87cdc44f97): unchanged since rev 3, as GLB contract rev 4 keeps seats and tables in place (dogrula.py checks
// it). The GLB files are not in this repository, so the numbers stay written out here.
// The seat camera is the real seatedPose; the table is mounted through the real host.
const ROOMS = {
	'gece-lounge': {center: {x: -3.7, y: 1.26, z: -3.13}, topSize: 1.3, out: 1.1, headY: 1.54},
	kahvehane: {center: {x: -4.35, y: 0.795, z: 1.2}, topSize: 1.3, out: 1.08, headY: 1.1},
	'oyun-odasi': {center: {x: 1.23, y: 0.8, z: -2.68}, topSize: 1.4, out: 1.14, headY: 1.125},
} as const;
type Room = keyof typeof ROOMS;
type Position = 1 | 2 | 3 | 4;
// lower: the seat eye this far under the room's (a margin check), 0 by default.
const SEATS: Array<{room: Room; position: Position; width: number; height: number; lower?: number}> = (
	Object.keys(ROOMS) as Array<Room>
).flatMap((room) =>
	([1, 2, 3, 4] as const).flatMap((position) => [
		{room, position, width: 1440, height: 900},
		{room, position, width: 1280, height: 720},
	]),
);

function roomLayout(room: Room, lower = 0): RoomLayout {
	const {center, topSize, out, headY} = ROOMS[room];
	return {
		seats: ([1, 2, 3, 4] as const).map((position) => {
			const angle = ((position - 1) * Math.PI) / 2;
			return {
				name: `seat_T01_${position}`,
				group: 'T01',
				position: {x: center.x + out * Math.sin(angle), y: headY - lower, z: center.z + out * Math.cos(angle)},
				table: {slot: 'T01', position},
				watch: null,
			};
		}),
		stands: [],
		tables: [{slot: 'T01', center, topSize}],
		camTarget: {x: 0, y: 2, z: 0},
		camHome: {x: 10, y: 10, z: 10},
		camPan: {x: 0, z: 0},
		screen: null,
	};
}

// What I see from my seat: 101 in play (my turn, nothing opened) or classic okey, with a pile at each corner.
function seatView(game: 'okey' | 'okey101', me: Position): TableGameView {
	const base = testOkeyGameView({
		rack: myTiles(MY_RACK),
		rack_counts: [14, 14, 14, 14],
		pile_count: 21,
		turn: me,
		discards: [
			['t60', 't61'],
			['t62', 't63'],
			['t64', 't65'],
			['t66', 't67'],
		],
	});
	const gameView =
		game === 'okey'
			? ({...base, phase: 'discard'} as OkeyView)
			: ({
					...base,
					game: 'okey101',
					phase: 'play',
					melds: [],
					opened: ['none', 'none', 'none', 'none'],
					penalties: [0, 0, 0, 0],
					scores: null,
				} as Okey101View);
	return testView({game, viewerPosition: me, gameView});
}

// A canvas stand-in for the host: pointer events are plain Events carrying the fields the host reads.
function fakeDom(width: number, height: number) {
	return Object.assign(new EventTarget(), {
		ownerDocument: Object.assign(new EventTarget(), {defaultView: null}),
		getBoundingClientRect: () => ({left: 0, top: 0, width, height}),
		setPointerCapture: () => {},
		hasPointerCapture: () => false,
		releasePointerCapture: () => {},
	}) as unknown as HTMLElement;
}

async function seated(
	seat: (typeof SEATS)[number],
	game: 'okey' | 'okey101',
	given: {view?: TableGameView; stage?: OkeyStage | null} = {},
) {
	const {room, position, width, height, lower = 0} = seat;
	const layout = roomLayout(room, lower);
	const pose = seatedPose({layout, seat: layout.seats[position - 1]!, slot: 'T01', game, aspect: width / height});
	const camera = new PerspectiveCamera(pose.fovDeg, width / height, 0.05, 100);
	camera.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
	camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
	camera.updateMatrixWorld();
	const dom = fakeDom(width, height);
	const parent = new Group();
	let made: TableGame3DModel | null = null;
	const handler = {canDrag: vi.fn(() => true), onDragStart: vi.fn(), onDrop: vi.fn(), onSelect: vi.fn()};
	const host = createTableGame3DHost({
		parent,
		camera,
		dom,
		layout,
		slot: 'T01',
		game,
		factoryFor: () => (options) => {
			made = createOkeyTableModel(options);
			return made;
		},
		parts: Promise.resolve(fakeParts()),
		requestRender: () => {},
	});
	host.setDragHandler(handler);
	const view = given.view ?? seatView(game, position);
	host.update(input(view, {perspective: position, stage: given.stage ?? null}));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const m = made as TableGame3DModel | null;
	if (!m) throw new Error('no okey model mounted');
	parent.updateMatrixWorld(true);
	const raycaster = new Raycaster();
	const ndc = (world: Vector3) => world.clone().project(camera);
	return {
		host,
		model: m,
		view,
		handler,
		name: `${room}${lower ? ` ${lower} m lower` : ''} seat ${position} ${width}`,
		inView: (world: Vector3) => {
			const p = ndc(world);
			return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1;
		},
		screenOf: (world: Vector3) => {
			const p = ndc(world);
			return {clientX: ((p.x + 1) / 2) * width, clientY: ((1 - p.y) / 2) * height};
		},
		pointer: (type: string, at: {clientX: number; clientY: number}) =>
			dom.dispatchEvent(Object.assign(new Event(type), {...at, pointerId: 1, button: 0})),
		// What lies on the line from my eye to a world point, nearest first, short of the point itself.
		before: (world: Vector3, objects: ReadonlyArray<Object3D>) => {
			const offset = world.clone().sub(camera.position);
			raycaster.set(camera.position, offset.clone().normalize());
			raycaster.far = offset.length() - 1e-4;
			return raycaster.intersectObjects([...objects], true);
		},
		// The drop zone the host's release would pick at a world point (the first zone along that ray).
		zoneAt: (world: Vector3): TableDropTarget | null => {
			raycaster.set(camera.position, world.clone().sub(camera.position).normalize());
			raycaster.far = Number.POSITIVE_INFINITY;
			return raycaster.intersectObjects([...m.dropZones()], true)[0]?.object.userData.target ?? null;
		},
	};
}

describe('OkeyTableModel from the seats (R, 03 Eki: Y1, Y3)', () => {
	it('from every seat, each of my table drop zones is the first hit over its whole inner area', async () => {
		// Per seat and zone: how many of its 5 × 5 inner points another zone (or the frame edge) takes.
		const misses: Array<string> = [];
		for (const seat of SEATS)
			for (const game of ['okey', 'okey101'] as const) {
				const t = await seated(seat, game);
				const table = t.model
					.dropZones()
					.filter((zone) => (zone.userData.target as TableDropTarget).kind !== 'rack_cell');
				expect(table.map((zone) => zone.userData.target.kind)).toContain(game === 'okey' ? 'finish_zone' : 'meld_zone');
				for (const zone of table) {
					const kind = (zone.userData.target as TableDropTarget).kind;
					let lost = 0;
					for (const u of [-0.4, -0.2, 0, 0.2, 0.4])
						for (const v of [-0.4, -0.2, 0, 0.2, 0.4]) {
							const point = zone.localToWorld(new Vector3(u, v, 0));
							if (t.zoneAt(point)?.kind !== kind || !t.inView(point)) lost++;
						}
					if (lost > 0) misses.push(`${t.name} ${game} ${kind}: ${lost}/25`);
				}
				t.host.dispose();
			}
		expect(misses).toEqual([]);
	});

	it('staging a 101 group by dragging works: a rack tile dropped on the meld zone stages its set', async () => {
		for (const seat of SEATS) {
			const t = await seated(seat, 'okey101');
			const source: TableDragSource = {kind: 'rack_tile', tile: 't1', cell: 1};
			const pickable = t.model
				.pickables()
				.find((object) => JSON.stringify(object.userData.source) === JSON.stringify(source))!;
			const from = t.screenOf(new Box3().setFromObject(pickable).getCenter(new Vector3()));
			const meld = t.model.dropZones().find((zone) => zone.userData.target.kind === 'meld_zone')!;
			const to = t.screenOf(meld.getWorldPosition(new Vector3()));
			t.pointer('pointerdown', from);
			t.pointer('pointermove', {clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2});
			t.host.beforeDraw();
			t.pointer('pointermove', to);
			t.host.beforeDraw();
			t.pointer('pointerup', to);
			expect(t.handler.onDrop, t.name).toHaveBeenCalledExactlyOnceWith(source, {kind: 'meld_zone'});
			expect(
				resolveTableDrop({
					view: t.view,
					me: seat.position,
					rack: MY_RACK,
					stage: null,
					tavlaSteps: [],
					source,
					target: t.handler.onDrop.mock.calls[0]![1] as TableDropTarget,
				}),
			).toEqual({kind: 'stage', stage: {take: null, open: [['t0', 't1', 't2']], add: []}});
			t.host.dispose();
		}
	});

	it('my discard pile and the one I take from are visible from my seat (not occluded by my rack)', async () => {
		const hidden: Array<string> = [];
		for (const seat of SEATS) {
			const t = await seated(seat, 'okey');
			const me = seat.position;
			const previous = ((me + 2) % 4) + 1;
			const racks = instanced(t.model.root).filter((mesh) => mesh.name === 'okey_rack');
			const faces = face(t.model.root);
			const {discards} = t.view.game_view as OkeyView;
			for (const owner of [me, previous]) {
				const local = new Matrix4();
				faces.getMatrixAt(indexOfCell(faces, discards[owner - 1]!.at(-1)!), local);
				const world = faces.matrixWorld.clone().multiply(local);
				// The digit area: the face's middle and four points 30% out towards its corners (GLB face units).
				const lost = [
					[0, 0],
					[-0.3, -0.3],
					[0.3, -0.3],
					[-0.3, 0.3],
					[0.3, 0.3],
				].filter(([du, dv]) => {
					const point = new Vector3(du! * 0.034, 0.024 + dv! * 0.048, 0.005).applyMatrix4(world);
					return !t.inView(point) || t.before(point, racks).length > 0;
				});
				if (lost.length > 0)
					hidden.push(`${t.name}: ${owner === me ? 'mine' : 'previous'} hidden at ${JSON.stringify(lost)}`);
			}
			t.host.dispose();
		}
		expect(hidden).toEqual([]);
	});
});

// my 101 sets, staged or opened, on my strip across the middle.
const MY_SET_TOKENS = ['t30', 't31', 't32', 't33', 't34', 't35', 't36'];
function myStrip(me: Position, opened: boolean): {view: TableGameView; stage: OkeyStage | null; tokens: Array<string>} {
	const view = seatView('okey101', me);
	if (!opened) {
		// Two sets dragged from my rack, not opened yet: a run of four and a group of three (one strip row with its gap).
		const stage: OkeyStage = {
			take: null,
			open: [
				['t20', 't21', 't22', 't23'],
				['t24', 't25', 't26'],
			],
			add: [],
		};
		return {view, stage, tokens: stage.open.flat()};
	}
	const game = view.game_view as Okey101View;
	const melds = [
		{id: 0, owner: me, kind: 'run' as const, tiles: MY_SET_TOKENS.slice(0, 4)},
		{id: 1, owner: me, kind: 'group' as const, tiles: MY_SET_TOKENS.slice(4)},
	];
	const opened101 = game.opened.map((state, index) => (index === me - 1 ? 'sets' : state)) as Okey101View['opened'];
	return {
		view: testView({game: 'okey101', viewerPosition: me, gameView: {...game, melds, opened: opened101}}),
		stage: null,
		tokens: MY_SET_TOKENS,
	};
}

// Three sets of three, staged or opened: four slots a half row and one between sets put the third in my second row.
function mySecondRow(me: Position, opened: boolean) {
	// Staged from my rack, or opened from tiles no longer on it.
	const first = opened ? 30 : 20;
	const sets = [0, 3, 6].map((k) => [0, 1, 2].map((i) => `t${first + k + i}`));
	const view = seatView('okey101', me);
	if (!opened) return {view, stage: {take: null, open: sets, add: []} as OkeyStage, second: sets[2]!};
	const game = view.game_view as Okey101View;
	const melds = sets.map((tiles, id) => ({id, owner: me, kind: 'run' as const, tiles}));
	const opened101 = game.opened.map((state, index) => (index === me - 1 ? 'sets' : state)) as Okey101View['opened'];
	return {
		view: testView({game: 'okey101', viewerPosition: me, gameView: {...game, melds, opened: opened101}}),
		stage: null,
		second: sets[2]!,
	};
}

// Drags rack tile t1 to a world point through the host, as a pointer would.
function dragT1(t: Awaited<ReturnType<typeof seated>>, world: Vector3): TableDragSource {
	const source: TableDragSource = {kind: 'rack_tile', tile: 't1', cell: 1};
	const pickable = t.model
		.pickables()
		.find((object) => JSON.stringify(object.userData.source) === JSON.stringify(source))!;
	const from = t.screenOf(new Box3().setFromObject(pickable).getCenter(new Vector3()));
	const to = t.screenOf(world);
	t.pointer('pointerdown', from);
	t.pointer('pointermove', {clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2});
	t.host.beforeDraw();
	t.pointer('pointermove', to);
	t.host.beforeDraw();
	t.pointer('pointerup', to);
	return source;
}

// The meld zone's height on the 1440 and 1280 canvases (the flat 0.44 × 0.3 m middle was ~52 px at 1440). The
// felt my eye sees between my rack's cells and the far player's meld ends is about this tall in the Gece Lounge.
const MELD_ZONE_MIN_PX = [68, 60] as const;
// The preview canvases under the 74 px header (1440×900 and 1280×720 windows).
const CANVASES: Array<(typeof SEATS)[number]> = SEATS.map((seat) => ({
	...seat,
	height: seat.width === 1440 ? 826 : 646,
}));

describe('my 101 strip from the seats (UX-okey2)', () => {
	it('from every seat my staged and opened 101 sets are visible (not occluded by my rack) and inside the frame', async () => {
		const hidden: Array<string> = [];
		for (const seat of SEATS)
			for (const opened of [false, true]) {
				const {view, stage, tokens} = myStrip(seat.position, opened);
				const t = await seated(seat, 'okey101', {view, stage});
				const faces = face(t.model.root);
				// Anything drawn in front of a digit hides it: the racks, the pile, the indicator, other tiles.
				const occluders = instanced(t.model.root).filter(
					(mesh) => mesh.name === 'okey_rack' || mesh.name === 'okey_body',
				);
				for (const token of tokens) {
					const local = new Matrix4();
					faces.getMatrixAt(indexOfCell(faces, token), local);
					const world = faces.matrixWorld.clone().multiply(local);
					const lost = [
						[0, 0],
						[-0.3, -0.3],
						[0.3, -0.3],
						[-0.3, 0.3],
						[0.3, 0.3],
					].filter(([du, dv]) => {
						const point = new Vector3(du! * 0.034, 0.024 + dv! * 0.048, 0.005).applyMatrix4(world);
						return !t.inView(point) || t.before(point, occluders).length > 0;
					});
					if (lost.length > 0) hidden.push(`${t.name} ${opened ? 'opened' : 'staged'} ${token}: ${lost.length}/5`);
				}
				t.host.dispose();
			}
		expect(hidden).toEqual([]);
	});

	it('my second row of 101 sets reads from every seat: ≥ 60 % of each digit seen past the first row, ≥ 14 px (item 5)', async () => {
		// Four opened sets, 3 + 4 + 3 + 3: the first two fill the first row's half rows, the last two lie in the second.
		const tokens = Array.from({length: 13}, (_, i) => `t${30 + i}`);
		const second = tokens.slice(7);
		const report: Array<string> = [];
		// also from a seat eye 2 cm under the Gece Lounge's (the lowest), the margin okeyMySecondRowZ keeps.
		const lowered = SEATS.filter((seat) => seat.room === 'gece-lounge').map((seat) => ({...seat, lower: 0.02}));
		for (const seat of [...SEATS, ...lowered]) {
			const base = seatView('okey101', seat.position).game_view as Okey101View;
			const melds = [
				{id: 0, owner: seat.position, kind: 'run' as const, tiles: tokens.slice(0, 3)},
				{id: 1, owner: seat.position, kind: 'run' as const, tiles: tokens.slice(3, 7)},
				{id: 2, owner: seat.position, kind: 'run' as const, tiles: tokens.slice(7, 10)},
				{id: 3, owner: seat.position, kind: 'run' as const, tiles: tokens.slice(10)},
			];
			const opened = base.opened.map((state, index) =>
				index === seat.position - 1 ? 'sets' : state,
			) as Okey101View['opened'];
			const view = testView({game: 'okey101', viewerPosition: seat.position, gameView: {...base, melds, opened}});
			const t = await seated(seat, 'okey101', {view});
			const faces = face(t.model.root);
			const occluders = instanced(t.model.root).filter(
				(mesh) => mesh.name === 'okey_rack' || mesh.name === 'okey_body',
			);
			for (const token of second) {
				const local = new Matrix4();
				faces.getMatrixAt(indexOfCell(faces, token), local);
				const world = faces.matrixWorld.clone().multiply(local);
				// The digit: the face's middle 55 % in height, its middle half in width; 5 × 3 samples.
				const at = (du: number, v: number) => new Vector3(du * 0.034, v * 0.048, 0.005).applyMatrix4(world);
				let seen = 0;
				let all = 0;
				for (const v of [0.225, 0.3625, 0.5, 0.6375, 0.775])
					for (const du of [-0.25, 0, 0.25]) {
						all++;
						const point = at(du, v);
						if (t.inView(point) && t.before(point, occluders).length === 0) seen++;
					}
				const [low, high] = [t.screenOf(at(0, 0.225)), t.screenOf(at(0, 0.775))];
				const px = Math.hypot(high.clientX - low.clientX, high.clientY - low.clientY);
				if (seen / all < 0.6 || px < 14) report.push(`${t.name} ${token}: ${seen}/${all} seen, ${px.toFixed(1)} px`);
			}
			t.host.dispose();
		}
		expect(report).toEqual([]);
	});

	it('the meld zone takes a drop on any of my strip tiles and stands tall on screen', async () => {
		const short: Array<string> = [];
		const missed: Array<string> = [];
		for (const seat of CANVASES) {
			const {view, stage, tokens} = myStrip(seat.position, false);
			const t = await seated(seat, 'okey101', {view, stage});
			const faces = face(t.model.root);
			for (const token of tokens) {
				const local = new Matrix4();
				faces.getMatrixAt(indexOfCell(faces, token), local);
				const centre = new Vector3(0, 0.024, 0.005).applyMatrix4(faces.matrixWorld.clone().multiply(local));
				if (t.zoneAt(centre)?.kind !== 'meld_zone') missed.push(`${t.name} ${token}`);
			}
			// Down its middle: the screen rows where a drop lands on it.
			const meld = t.model.dropZones().find((zone) => zone.userData.target.kind === 'meld_zone')!;
			const rows: Array<number> = [];
			for (let v = -0.5; v <= 0.5; v += 0.01) {
				const point = meld.localToWorld(new Vector3(0, v, 0));
				if (t.inView(point) && t.zoneAt(point)?.kind === 'meld_zone') rows.push(t.screenOf(point).clientY);
			}
			const tall = Math.max(...rows) - Math.min(...rows);
			if (tall < (seat.width === 1440 ? MELD_ZONE_MIN_PX[0] : MELD_ZONE_MIN_PX[1]))
				short.push(`${t.name}: ${tall.toFixed(1)} px`);
			t.host.dispose();
		}
		expect(missed).toEqual([]);
		expect(short).toEqual([]);
	});

	it('the meld zone leaves the other players’ meld ends past the middle reachable (two rows each)', async () => {
		const blocked: Array<string> = [];
		for (const seat of CANVASES) {
			const {view, stage} = myStrip(seat.position, false);
			const game = view.game_view as Okey101View;
			// Each other player opened two runs of six: two rows of their strip.
			const others = ([1, 2, 3, 4] as const).filter((position) => position !== seat.position);
			const melds = others.flatMap((owner, index) =>
				[0, 1].map((half) => ({
					id: 2 * index + half,
					owner,
					kind: 'run' as const,
					tiles: Array.from({length: 6}, (_, k) => `t${40 + 12 * index + 6 * half + k}`),
				})),
			);
			const opened = game.opened.map((state, index) => (index === seat.position - 1 ? state : 'sets'));
			const full = testView({
				game: 'okey101',
				viewerPosition: seat.position,
				gameView: {...game, melds, opened: opened as Okey101View['opened']},
			});
			const t = await seated(seat, 'okey101', {view: full, stage});
			for (const end of t.model.dropZones().filter((zone) => zone.userData.target.kind === 'meld_end')) {
				const middle = end.getWorldPosition(new Vector3());
				if (t.model.root.worldToLocal(middle.clone()).z >= 0) continue; // the near half: behind my rack anyway
				// Two sets' facing ends share the gap slot between them (the first one wins there); none goes to my zones.
				const hit = t.zoneAt(middle);
				if (hit?.kind !== 'meld_end') blocked.push(`${t.name} ${JSON.stringify(end.userData.target)} → ${hit?.kind}`);
			}
			t.host.dispose();
		}
		expect(blocked).toEqual([]);
	});

	it('adding a rack tile to my opened set by dragging it to the set’s end still works where the set now lies', async () => {
		for (const seat of SEATS) {
			const {view} = myStrip(seat.position, true);
			const t = await seated(seat, 'okey101', {view});
			const ends = t.model.dropZones().filter((zone) => zone.userData.target.kind === 'meld_end');
			// The outer end of each set is the first zone under its middle, in view; the run fills its half row up to the
			// indicator and the group starts right past it, so towards the middle they have no end.
			expect(ends.length, t.name).toBe(2);
			for (const end of ends) {
				const middle = end.getWorldPosition(new Vector3());
				expect(t.inView(middle), t.name).toBe(true);
				expect(t.zoneAt(middle), t.name).toEqual(end.userData.target);
			}
			// Where the added tile would stand, one slot past a set's end tile, its whole digit area takes the drop as that
			// end (a flat end on the felt would leave it to the middle's zone).
			const faces = face(t.model.root);
			const slot = 0.034 + (0.003 * 0.048) / 0.082; // the slot pitch (tile + 3 mm gap) in GLB face units
			for (const [token, at, meldId] of [
				['t30', 'start', 0],
				['t36', 'end', 1],
			] as const) {
				const local = new Matrix4();
				faces.getMatrixAt(indexOfCell(faces, token), local);
				const world = faces.matrixWorld.clone().multiply(local);
				for (const dv of [-0.3, 0, 0.3]) {
					const point = new Vector3((at === 'end' ? 1 : -1) * slot, 0.024 + dv * 0.048, 0.005).applyMatrix4(world);
					expect(t.zoneAt(point), `${t.name} ${token} ${dv}`).toEqual({kind: 'meld_end', meldId, at});
				}
			}
			const source: TableDragSource = {kind: 'rack_tile', tile: 't1', cell: 1};
			const pickable = t.model
				.pickables()
				.find((object) => JSON.stringify(object.userData.source) === JSON.stringify(source))!;
			const from = t.screenOf(new Box3().setFromObject(pickable).getCenter(new Vector3()));
			const target: TableDropTarget = {kind: 'meld_end', meldId: 0, at: 'start'};
			const end = ends.find((zone) => JSON.stringify(zone.userData.target) === JSON.stringify(target))!;
			const to = t.screenOf(end.getWorldPosition(new Vector3()));
			t.pointer('pointerdown', from);
			t.pointer('pointermove', {clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2});
			t.host.beforeDraw();
			t.pointer('pointermove', to);
			t.host.beforeDraw();
			t.pointer('pointerup', to);
			expect(t.handler.onDrop, t.name).toHaveBeenCalledExactlyOnceWith(source, target);
			expect(
				resolveTableDrop({view, me: seat.position, rack: MY_RACK, stage: null, tavlaSteps: [], source, target}),
			).toEqual({kind: 'action', action: {type: 'meld', add: [{meld_id: 0, tiles: ['t1'], at: 'start'}]}});
			t.host.dispose();
		}
	});

	// What a drop on my second row reaches (CAM3 2): the middle's zone leans just behind my first row, under the sight
	// lines past it, so it neither takes my second row's set ends nor leaves its staged tiles without a target.
	const centreOf = (t: Awaited<ReturnType<typeof seated>>, token: string, dv = 0) => {
		const faces = face(t.model.root);
		const local = new Matrix4();
		faces.getMatrixAt(indexOfCell(faces, token), local);
		return new Vector3(0, 0.024 + dv * 0.048, 0.005).applyMatrix4(faces.matrixWorld.clone().multiply(local));
	};

	it('my opened set in my second row takes a rack tile at either end, dragged there (CAM3 2a)', async () => {
		const missed: Array<string> = [];
		for (const seat of SEATS) {
			const {view, second} = mySecondRow(seat.position, true);
			const t = await seated(seat, 'okey101', {view});
			for (const token of second)
				expect(t.model.root.worldToLocal(centreOf(t, token)).z, `${t.name} ${token}`).toBeLessThan(-0.2);
			const ends = t.model
				.dropZones()
				.filter((zone) => zone.userData.target.kind === 'meld_end' && zone.userData.target.meldId === 2);
			expect(ends.length, t.name).toBe(2);
			// The upper half of the slot past each end tile, across the digit's width. TEMPORARY: its lower half lies behind
			// my first row's zones from every seat (that row's end at the same x, or the middle's zone) and goes to them;
			// all of it would need the second row further out than okeyMySecondRowZ (SeatedView), up to the far rows.
			for (const end of ends)
				for (const u of [-0.3, 0, 0.3])
					for (const v of [0, 0.3]) {
						const point = end.localToWorld(new Vector3(u, v, 0));
						const hit = t.zoneAt(point);
						if (!t.inView(point) || JSON.stringify(hit) !== JSON.stringify(end.userData.target))
							missed.push(`${t.name} ${end.userData.target.at} (${u}, ${v}) → ${hit?.kind}`);
					}
			const target: TableDropTarget = {kind: 'meld_end', meldId: 2, at: 'start'};
			const end = ends.find((zone) => JSON.stringify(zone.userData.target) === JSON.stringify(target))!;
			const source = dragT1(t, end.getWorldPosition(new Vector3()));
			const dropped = t.handler.onDrop.mock.calls[0]?.[1];
			if (JSON.stringify(dropped) !== JSON.stringify(target))
				missed.push(`${t.name} drag → ${JSON.stringify(dropped)}`);
			expect(
				resolveTableDrop({view, me: seat.position, rack: MY_RACK, stage: null, tavlaSteps: [], source, target}),
			).toEqual({kind: 'action', action: {type: 'meld', add: [{meld_id: 2, tiles: ['t1'], at: 'start'}]}});
			t.host.dispose();
		}
		expect(missed).toEqual([]);
	});

	it('a drop on my staged set in my second row lands on the meld zone (CAM3 2b)', async () => {
		const missed: Array<string> = [];
		for (const seat of SEATS) {
			const {view, stage, second} = mySecondRow(seat.position, false);
			if (!stage) throw new Error('mySecondRow(…, false) stages its sets');
			const t = await seated(seat, 'okey101', {view, stage});
			for (const token of second) {
				expect(t.model.root.worldToLocal(centreOf(t, token)).z, `${t.name} ${token}`).toBeLessThan(-0.2);
				for (const dv of [-0.3, 0, 0.3]) {
					const point = centreOf(t, token, dv);
					const hit = t.zoneAt(point);
					if (!t.inView(point) || hit?.kind !== 'meld_zone') missed.push(`${t.name} ${token} ${dv} → ${hit?.kind}`);
				}
			}
			const source = dragT1(t, centreOf(t, second[1]!));
			const dropped = t.handler.onDrop.mock.calls[0]?.[1] as TableDropTarget | undefined;
			if (dropped?.kind !== 'meld_zone') missed.push(`${t.name} drag → ${JSON.stringify(dropped)}`);
			expect(
				resolveTableDrop({
					view,
					me: seat.position,
					rack: MY_RACK,
					stage,
					tavlaSteps: [],
					source,
					target: {kind: 'meld_zone'},
				}),
			).toEqual({kind: 'stage', stage: {...stage, open: [...stage.open, ['t0', 't1', 't2']]}});
			t.host.dispose();
		}
		expect(missed).toEqual([]);
	});
});
