// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type {TableGame3DModel, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {createRenderLoop} from '@app/features/voice_scene/scene/VoiceSceneRenderLoop';
import type {
	RoomLayout,
	TableDragHandler,
	TableDragSource,
	TableDropTarget,
	TableScene3DInput,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameKind, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Vector3} from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';

const manifest = vi.hoisted(() => ({value: null as {file: string; bytes: number} | null}));
const parsedScene = vi.hoisted(() => ({value: null as unknown}));
vi.mock('@fluxer/constants/src/VoiceRoomPartsManifest', () => ({
	get VOICE_ROOM_PARTS_MANIFEST() {
		return manifest.value;
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		parseAsync() {
			return Promise.resolve({scene: parsedScene.value});
		}
	},
}));

const {createTableGame3DHost, mountTableGame3D} = await import('@app/features/voice_scene/scene/TableGame3DHost');

const WIDTH = 1280;
const HEIGHT = 720;
const CENTER = {x: 2, y: 0.8, z: -1};

const layout: RoomLayout = {
	seats: [1, 2, 3, 4].map((position) => {
		const angle = ((position - 1) * Math.PI) / 2;
		return {
			name: `seat_T01_${position}`,
			group: 'T01',
			position: {x: CENTER.x + 1.08 * Math.sin(angle), y: 1.1, z: CENTER.z + 1.08 * Math.cos(angle)},
			table: {slot: 'T01', position: position as 1 | 2 | 3 | 4},
			watch: null,
		};
	}),
	stands: [],
	tables: [{slot: 'T01', center: CENTER, topSize: 1.3}],
	camTarget: {x: 0, y: 2, z: 0},
	camHome: {x: 10, y: 10, z: 10},
	camPan: {x: 0, z: 0},
	screen: null,
};

const PIECE: TableDragSource = {kind: 'square', square: 'e2'};
const ZONE_A: TableDropTarget = {kind: 'square', square: 'd7'};
const ZONE_B: TableDropTarget = {kind: 'square', square: 'f7'};

// A stand-in model: one piece near my edge and two flat drop zones on the far half (root-local metres).
function fakeModel() {
	const root = new Group();
	const piece = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), new MeshBasicMaterial());
	piece.position.set(0, 0.03, 0.3);
	piece.userData.source = PIECE;
	const zone = (target: TableDropTarget, x: number) => {
		const mesh = new Mesh(new PlaneGeometry(0.2, 0.2), new MeshBasicMaterial({visible: false}));
		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(x, 0.001, -0.25);
		mesh.userData.target = target;
		return mesh;
	};
	const zones = [zone(ZONE_A, -0.2), zone(ZONE_B, 0.2)];
	root.add(piece, ...zones);
	let animatingFrames = 0;
	const model = {
		root,
		update: vi.fn(),
		pickables: () => [piece],
		dropZones: () => zones,
		animating: vi.fn(() => animatingFrames-- > 0),
		dispose: vi.fn(),
	} satisfies TableGame3DModel;
	return {
		model,
		piece,
		animateFor(frames: number) {
			animatingFrames = frames;
		},
	};
}

function view(game: TableGameKind, gameView: unknown = null): TableGameView {
	return {summary: {game}, game_view: gameView} as unknown as TableGameView;
}

function input(over: Partial<TableScene3DInput> = {}): TableScene3DInput {
	return {
		view: view('chess', {game: 'chess'}),
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const mountedHosts: Array<ReturnType<typeof createTableGame3DHost>> = [];

async function mount(options: {game?: TableGameKind; noModelFor?: TableGameKind} = {}) {
	const parent = new Group();
	// From seat 1, as the seated view would look: eye behind my edge, looking at the table centre.
	const camera = new PerspectiveCamera(55, WIDTH / HEIGHT, 0.05, 100);
	camera.position.set(CENTER.x, 1.2, CENTER.z + 1.25);
	camera.lookAt(CENTER.x, CENTER.y, CENTER.z + 0.1);
	camera.updateMatrixWorld();
	const dom = document.createElement('div');
	dom.getBoundingClientRect = () => ({left: 0, top: 0, width: WIDTH, height: HEIGHT}) as DOMRect;
	const models: Array<ReturnType<typeof fakeModel>> = [];
	const factoryFor = vi.fn((game: TableGameKind) =>
		game === options.noModelFor
			? undefined
			: vi.fn(() => {
					const made = fakeModel();
					models.push(made);
					return made.model;
				}),
	);
	const requestRender = vi.fn();
	const onModelMounted = vi.fn();
	const handler = {
		canDrag: vi.fn(() => true),
		onDragStart: vi.fn(),
		onDrop: vi.fn(),
		onSelect: vi.fn(),
	} satisfies TableDragHandler;
	const host = createTableGame3DHost({
		parent,
		camera,
		dom,
		layout,
		slot: 'T01',
		game: options.game ?? 'chess',
		factoryFor,
		parts: Promise.resolve({} as TableParts),
		requestRender,
		onModelMounted,
	});
	mountedHosts.push(host);
	// The camera's pointerdown listener on the same canvas (OrbitControls registers a plain bubbling one).
	const orbitPress = vi.fn();
	dom.addEventListener('pointerdown', orbitPress);
	host.setDragHandler(handler);
	const game = options.game ?? 'chess';
	host.update(input({view: view(game, {game})}));
	await flush();
	// CSS px of a root-local point (the anchor sits on the table centre, turned to seat 1 = no turn).
	const screenOf = (x: number, y: number, z: number) => {
		const p = new Vector3(CENTER.x + x, CENTER.y + y, CENTER.z + z).project(camera);
		return {clientX: ((p.x + 1) / 2) * WIDTH, clientY: ((1 - p.y) / 2) * HEIGHT};
	};
	const pointer = (type: string, at: {clientX: number; clientY: number}) =>
		dom.dispatchEvent(new PointerEvent(type, {...at, pointerId: 1, button: 0, bubbles: true}));
	return {
		host,
		dom,
		parent,
		models,
		factoryFor,
		requestRender,
		orbitPress,
		onModelMounted,
		handler,
		pointer,
		onPiece: screenOf(0, 0.03, 0.3),
		onZoneA: screenOf(-0.2, 0.001, -0.25),
		onZoneB: screenOf(0.2, 0.001, -0.25),
		offTable: {clientX: 20, clientY: 20},
	};
}

afterEach(() => {
	for (const host of mountedHosts.splice(0)) host.dispose();
	manifest.value = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('TableGame3DHost', () => {
	it.each(['pointerup', 'pointercancel'])(
		'a target-only press released outside the canvas (%s) permits the next drag',
		async (type) => {
			const t = await mount({game: 'dama'});
			t.pointer('pointerdown', t.onZoneA);
			window.dispatchEvent(new PointerEvent(type, {...t.offTable, pointerId: 1, bubbles: true}));
			expect(t.handler.onSelect).not.toHaveBeenCalled();
			expect(t.handler.onDrop).not.toHaveBeenCalled();
			t.pointer('pointerdown', t.onPiece);
			t.pointer('pointermove', t.onZoneB);
			t.pointer('pointerup', t.onZoneB);
			expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_B);
		},
	);

	it.each(['lostpointercapture', 'blur', 'visibilitychange', 'contextmenu'])(
		'%s cancels a drag and allows exactly one subsequent drop',
		async (type) => {
			const t = await mount({game: 'dama'});
			t.pointer('pointerdown', t.onPiece);
			t.pointer('pointermove', t.onZoneA);
			t.host.beforeDraw();
			if (type === 'blur') window.dispatchEvent(new Event(type));
			else if (type === 'visibilitychange') {
				vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
				document.dispatchEvent(new Event(type));
			} else t.pointer(type, t.onZoneA);
			expect(t.models[0]!.piece.position.toArray()).toEqual([0, 0.03, 0.3]);
			expect(t.handler.onSelect).not.toHaveBeenCalled();
			expect(t.handler.onDrop.mock.calls.filter(([, target]) => target !== null)).toHaveLength(0);
			t.handler.onDrop.mockClear();
			t.pointer('pointerup', t.onZoneA);
			t.pointer('pointerdown', t.onPiece);
			t.pointer('pointermove', t.onZoneB);
			t.pointer('pointerup', t.onZoneB);
			expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_B);
		},
	);

	it('capture loss caused by a normal release does not cancel or duplicate the final drop', async () => {
		const t = await mount();
		t.dom.hasPointerCapture = () => true;
		t.dom.releasePointerCapture = (pointerId) => {
			t.dom.dispatchEvent(new PointerEvent('lostpointercapture', {pointerId}));
		};
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.pointer('pointerup', t.onZoneA);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_A);
	});

	it('cancellation can synchronously update local highlights without retaining a press or submitting a move', async () => {
		const t = await mount();
		t.handler.onDrop.mockImplementation(() => t.host.update(input({targets: []})));
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.host.beforeDraw();
		window.dispatchEvent(new Event('blur'));
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, null);
		t.handler.onDrop.mockClear();
		t.pointer('pointerup', t.onZoneA);
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneB);
		t.pointer('pointerup', t.onZoneB);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_B);
	});

	it('a visibilitychange to visible cancels an active drag and permits the next single drop', async () => {
		const t = await mount({game: 'dama'});
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.host.beforeDraw();
		document.dispatchEvent(new Event('visibilitychange'));
		expect(t.models[0]!.piece.position.toArray()).toEqual([0, 0.03, 0.3]);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, null);
		t.handler.onDrop.mockClear();
		t.pointer('pointerup', t.onZoneA);
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneB);
		t.pointer('pointerup', t.onZoneB);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_B);
	});

	it.each([
		{interactive: false},
		{perspective: 2 as const},
		{view: {...view('chess', {game: 'chess'}), viewer_position: 3 as const}},
		{view: view('chess', {game: 'chess', fen: 'new position'})},
	])('a changed game position or player context cancels the active drag: %j', async (change) => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.host.beforeDraw();
		t.host.update(input(change));
		expect(t.models[0]!.piece.position.toArray()).toEqual([0, 0.03, 0.3]);
		t.handler.onDrop.mockClear();
		t.pointer('pointerup', t.onZoneA);
		expect(t.handler.onDrop).not.toHaveBeenCalled();
	});

	it('local highlights and presence-only table updates preserve the active drag', async () => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.host.beforeDraw();
		t.host.update(
			input({
				targets: [ZONE_A],
				view: {...view('chess', {game: 'chess'}), summary: {game: 'chess', version: 2} as TableGameView['summary']},
			}),
		);
		t.pointer('pointerup', t.onZoneA);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, ZONE_A);
	});

	it('pointerdown on a pickable starts a drag and disables orbit', async () => {
		const t = await mount();
		expect(t.onModelMounted).toHaveBeenCalledWith(true);
		t.pointer('pointerdown', t.onPiece);
		expect(t.handler.canDrag).toHaveBeenCalledWith(PIECE);
		expect(t.orbitPress).not.toHaveBeenCalled();
		// A press elsewhere is the camera's.
		t.pointer('pointerup', t.onPiece);
		t.pointer('pointerdown', t.offTable);
		expect(t.orbitPress).toHaveBeenCalledTimes(1);
	});

	it('pointermove requests at most one frame per animation frame (≤ 30 fps)', async () => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.requestRender.mockClear();
		for (let i = 1; i <= 10; i++)
			t.pointer('pointermove', {clientX: t.onPiece.clientX + 10 * i, clientY: t.onPiece.clientY - 5 * i});
		expect(t.requestRender).toHaveBeenCalledTimes(1);
		t.host.beforeDraw();
		t.pointer('pointermove', t.onZoneA);
		t.pointer('pointermove', t.onZoneB);
		expect(t.requestRender).toHaveBeenCalledTimes(2);
		// The frame moves the piece under the pointer, on the table plane.
		t.host.beforeDraw();
		const piece = t.models[0]!.piece;
		expect(piece.position.x).toBeGreaterThan(0.1);
		expect(piece.position.z).toBeLessThan(0);
	});

	it('drop sends exactly one onDrop with the zone under the pointer, none while dragging', async () => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.onZoneA);
		t.host.beforeDraw();
		t.pointer('pointermove', t.onZoneB);
		expect(t.handler.onDragStart).toHaveBeenCalledTimes(1);
		expect(t.handler.onDragStart).toHaveBeenCalledWith(PIECE);
		expect(t.handler.onDrop).not.toHaveBeenCalled();
		t.pointer('pointerup', t.onZoneB);
		expect(t.handler.onDrop).toHaveBeenCalledTimes(1);
		expect(t.handler.onDrop).toHaveBeenCalledWith(PIECE, ZONE_B);
		expect(t.handler.onSelect).not.toHaveBeenCalled();
		// The piece goes back to its place; the server's answer moves it.
		expect(t.models[0]!.piece.position.toArray()).toEqual([0, 0.03, 0.3]);
		t.pointer('pointerup', t.onZoneB);
		expect(t.handler.onDrop).toHaveBeenCalledTimes(1);
	});

	it('release outside any zone → onDrop(target null)', async () => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', t.offTable);
		t.pointer('pointerup', t.offTable);
		expect(t.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, null);
		// A cancelled pointer (focus loss, touch taken by the system) also puts the piece back.
		const c = await mount();
		c.pointer('pointerdown', c.onPiece);
		c.pointer('pointermove', c.onZoneA);
		c.pointer('pointercancel', c.onZoneA);
		expect(c.handler.onDrop).toHaveBeenCalledExactlyOnceWith(PIECE, null);
	});

	it('click without movement → onSelect', async () => {
		const t = await mount();
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointermove', {clientX: t.onPiece.clientX + 2, clientY: t.onPiece.clientY});
		t.pointer('pointerup', t.onPiece);
		expect(t.handler.onSelect).toHaveBeenCalledExactlyOnceWith(PIECE);
		expect(t.handler.onDragStart).not.toHaveBeenCalled();
		expect(t.handler.onDrop).not.toHaveBeenCalled();
		t.pointer('pointerdown', t.onZoneA);
		t.pointer('pointerup', t.onZoneA);
		expect(t.handler.onSelect).toHaveBeenLastCalledWith(ZONE_A);
	});

	it('watchers and read-only tables never pick (the camera keeps the pointer)', async () => {
		const t = await mount();
		t.host.update(input({interactive: false}));
		t.pointer('pointerdown', t.onPiece);
		t.pointer('pointerup', t.onPiece);
		expect(t.orbitPress).toHaveBeenCalledTimes(1);
		expect(t.handler.onSelect).not.toHaveBeenCalled();
	});

	it('model animating() keeps frames coming, then 0 frames', async () => {
		const t = await mount();
		const queue = new Map<number, FrameRequestCallback>();
		let id = 0;
		let now = 0;
		const draw = vi.fn(() => {
			t.host.beforeDraw();
			return t.host.animating();
		});
		const loop = createRenderLoop({
			draw,
			canvas: new EventTarget(),
			onContextLost: vi.fn(),
			doc: Object.assign(new EventTarget(), {hidden: false}),
			requestFrame: (callback) => {
				queue.set(++id, callback);
				return id;
			},
			cancelFrame: (frame) => queue.delete(frame),
		});
		const runFrames = (count: number) => {
			for (let i = 0; i < count; i++) {
				const next = [...queue.entries()][0];
				if (!next) return;
				queue.delete(next[0]);
				now += 1000 / 30;
				next[1](now);
			}
		};
		t.models[0]!.animateFor(5);
		loop.requestRender();
		runFrames(20);
		// 5 animating frames plus the last one that reported the end, then idle.
		expect(draw).toHaveBeenCalledTimes(6);
		expect(queue.size).toBe(0);
		loop.dispose();
	});

	it('lobby (game_view null) mounts an empty board of the table’s kind', async () => {
		const t = await mount({game: 'dama'});
		t.host.update(input({view: view('dama', null), interactive: false}));
		expect(t.factoryFor).toHaveBeenCalledWith('dama');
		expect(t.models).toHaveLength(1);
		expect(t.models[0]!.model.update).toHaveBeenLastCalledWith(
			expect.objectContaining({view: expect.objectContaining({game_view: null})}),
		);
	});

	it('a kind change remounts the model', async () => {
		const t = await mount();
		const first = t.models[0]!;
		t.host.update(input({view: view('tavla', null)}));
		expect(first.model.dispose).toHaveBeenCalledTimes(1);
		expect(t.factoryFor).toHaveBeenLastCalledWith('tavla');
		expect(t.models).toHaveLength(2);
		const anchor = t.parent.children[0]!;
		expect(anchor.children).toEqual([t.models[1]!.model.root]);
		expect(t.models[1]!.model.update).toHaveBeenCalledWith(
			expect.objectContaining({view: expect.objectContaining({game_view: null})}),
		);
		// Same kind again: updated in place, not remounted.
		t.host.update(input({view: view('tavla', {game: 'tavla'})}));
		expect(t.models).toHaveLength(2);
		t.host.dispose();
		expect(t.models[1]!.model.dispose).toHaveBeenCalledTimes(1);
		expect(t.parent.children).toHaveLength(0);
		expect(t.onModelMounted).toHaveBeenLastCalledWith(false);
	});

	it('a slot with no model never hides the 2D top', async () => {
		// A kind this build has no model for (a newer build's table): the parts load, nothing mounts.
		const unknown = 'future_game' as TableGameKind;
		const none = await mount({game: unknown, noModelFor: unknown});
		expect(none.models).toHaveLength(0);
		none.host.dispose();
		expect(none.onModelMounted).not.toHaveBeenCalled();
		// A table set up again with such a kind: the model goes and the 2D top comes back; a known kind hides it again.
		const t = await mount({noModelFor: unknown});
		t.host.update(input({view: view(unknown, null)}));
		expect(t.onModelMounted.mock.calls).toEqual([[true], [false]]);
		t.host.update(input({view: view('tavla', null)}));
		t.host.dispose();
		expect(t.onModelMounted.mock.calls).toEqual([[true], [false], [true], [false]]);
	});

	it('the anchor sits on the table centre, +Z towards the perspective seat', async () => {
		const t = await mount();
		const anchor = t.parent.children[0]!;
		expect(anchor.position.toArray()).toEqual([CENTER.x, CENTER.y, CENTER.z]);
		expect(anchor.rotation.y).toBeCloseTo(0);
		t.host.update(input({perspective: 2}));
		const towards = new Vector3(0, 0, 1).applyEuler(anchor.rotation);
		expect(towards.x).toBeCloseTo(1);
		expect(towards.z).toBeCloseTo(0);
	});

	it('parts are fetched once, lazily, only from the manifest path (Ş8)', async () => {
		const {createTableParts} = await import('@app/features/voice_scene/scene/table/TableParts');
		const root = new Group();
		for (const name of [
			'piece_k',
			'piece_q',
			'piece_r',
			'piece_b',
			'piece_n',
			'piece_p',
			'piece_dm',
			'piece_dk',
			'tavla_board',
			'tavla_checker',
			'tavla_die',
			'okey_face',
			'okey_body',
			'okey_rack',
		]) {
			const part = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), new MeshBasicMaterial());
			part.name = name;
			root.add(part);
		}
		expect(() => createTableParts(root)).not.toThrow();
		parsedScene.value = root;
		const fetchSpy = vi.fn(() => Promise.resolve(new Response(new ArrayBuffer(8))));
		vi.stubGlobal('fetch', fetchSpy);
		manifest.value = {file: 'masa-parcalari.0123456789ab.glb', bytes: 8};
		expect(fetchSpy).not.toHaveBeenCalled();
		const options = {
			parent: new Group(),
			camera: new PerspectiveCamera(),
			dom: document.createElement('div'),
			layout,
			slot: 'T01',
			game: 'okey' as const,
			factoryFor: () => () => fakeModel().model,
			requestRender: vi.fn(),
		};
		const first = mountTableGame3D(options);
		const second = mountTableGame3D(options);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		await flush();
		expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('https://static.example/rooms/masa-parcalari.0123456789ab.glb');
		first?.dispose();
		second?.dispose();
	});
});
