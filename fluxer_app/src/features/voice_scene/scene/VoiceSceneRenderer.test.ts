// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {readFileSync} from 'node:fs';
import type {RoomSeat, SceneCameraMode, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {CAMERA_TWEEN_MS} from '@app/features/voice_scene/utils/CameraLimits';
import {SEAT_VIEW_REFERENCE_M, seatedPose} from '@app/features/voice_scene/utils/SeatedView';
import {
	BackSide,
	BoxGeometry,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicMaterial,
	Object3D,
	PerspectiveCamera,
	PlaneGeometry,
	Raycaster,
	type Scene,
	Texture,
	Vector3,
} from 'three';
import {computeBoundsTree, MeshBVH} from 'three-mesh-bvh';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	scenes: [] as Array<unknown>,
	render: null as null | ((scene: unknown, camera: unknown) => void),
	modelMade: null as null | (() => void),
	modelAnimating: null as null | (() => boolean),
	rendererError: null as null | Error,
	workers: [] as Array<{
		terminate: () => void;
		postMessage: (message: unknown, transfer: Array<ArrayBuffer>) => void;
		onerror: ((event: {message: string; preventDefault(): void}) => void) | null;
	}>,
	workerPosted: null as null | (() => void),
	workerCallbackErrors: [] as Array<unknown>,
}));

vi.mock('three', async (importOriginal) => {
	const three = await importOriginal<typeof import('three')>();
	// No WebGL under test: a renderer that only records what it was asked to draw.
	class FakeWebGLRenderer {
		constructor() {
			if (env.rendererError) throw env.rendererError;
		}
		domElement = document.createElement('canvas');
		capabilities = {getMaxAnisotropy: () => 1};
		outputColorSpace = '';
		toneMapping = 0;
		setPixelRatio() {}
		setClearColor() {}
		setSize() {}
		render(scene: unknown, camera: unknown) {
			env.render?.(scene, camera);
		}
		dispose() {}
		forceContextLoss() {}
	}
	return {...three, WebGLRenderer: FakeWebGLRenderer};
});
vi.mock('three-mesh-bvh', async (importOriginal) => {
	const bvh = await importOriginal<typeof import('three-mesh-bvh')>();
	return {...bvh, computeBoundsTree: vi.fn(bvh.computeBoundsTree)};
});
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		parseAsync() {
			return Promise.resolve({scene: env.scenes.shift()});
		}
	},
}));
vi.mock('@fluxer/constants/src/VoiceRoomPartsManifest', () => ({
	VOICE_ROOM_PARTS_MANIFEST: {file: 'masa-parcalari.0123456789ab.glb', bytes: 8},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
const fakeModels = vi.hoisted(() => async () => {
	const {Group: ModelRoot} = await import('three');
	const factory = () => {
		env.modelMade?.();
		return {
			root: new ModelRoot(),
			update() {},
			pickables: () => [],
			dropZones: () => [],
			animating: () => env.modelAnimating?.() ?? false,
			dispose() {},
		};
	};
	return {createOkeyTableModel: factory, createBoardTableModel: factory, createTavlaTableModel: factory};
});
vi.mock('@app/features/voice_scene/scene/table/OkeyTableModel', fakeModels);
vi.mock('@app/features/voice_scene/scene/table/BoardTableModel', fakeModels);
vi.mock('@app/features/voice_scene/scene/table/TavlaTableModel', fakeModels);

const {collectContractNodes, createVoiceSceneRenderer, projectPoint} = await import(
	'@app/features/voice_scene/scene/VoiceSceneRenderer'
);

const WIDTH = 1280;
const HEIGHT = 720;
const CENTER = new Vector3(0, 0.8, 0);

function placed(object: Object3D, name: string, x: number, y: number, z: number): Object3D {
	object.name = name;
	object.position.set(x, y, z);
	return object;
}

// A Kahvehane-sized table room: table T01 (top 1.3) with its four seats 1.08 m out, a TV on the north wall.
function roomScene(): Group {
	const root = new Group();
	const table = placed(new Object3D(), 'table_T01', CENTER.x, CENTER.y, CENTER.z);
	table.userData = {top_size: 1.3};
	root.add(table);
	for (const [position, x, z] of [
		[1, 0, 1.08],
		[2, 1.08, 0],
		[3, 0, -1.08],
		[4, -1.08, 0],
	] as const)
		root.add(placed(new Object3D(), `seat_T01_${position}`, x, 1.1, z));
	root.add(placed(new Object3D(), 'seat_A_01', 4, 1.1, 3));
	root.add(placed(new Object3D(), 'cam_target', 0, 2, 0));
	root.add(placed(new Object3D(), 'cam_home', 8.5, 21, 23));
	root.add(placed(new Mesh(new PlaneGeometry(2, 1.125), new MeshBasicMaterial()), 'screen', 0, 2.2, -6));
	// Rev 4: four wall groups (x ±7, z -6.2…1.8) and the ceiling at 3.2 m. The south wall stands
	// 0.57–0.67 m behind seat 1's eye (z 1.23 at okey, 1.13 at chess): inside the 0.75 m band, so only the orbit-only rule
	// keeps it while seated.
	for (const [name, plane] of [
		['wall_N', [0, -6.2, 0, -1]],
		['wall_E', [7, 0, 1, 0]],
		['wall_S', [0, 1.8, 0, 1]],
		['wall_W', [-7, 0, -1, 0]],
	] as const) {
		const group = placed(new Group(), name, 0, 0, 0);
		group.userData = {wall_plane: [...plane]};
		group.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));
		root.add(group);
	}
	const ceiling = placed(new Group(), 'ceiling', 0, 3.2, 0);
	ceiling.userData = {ceiling_y: 3.2};
	root.add(ceiling);
	return root;
}

// A room GLB without its wall groups and ceiling (older than rev 4).
function olderRoomScene(): Group {
	const root = roomScene();
	for (const name of ['wall_N', 'wall_E', 'wall_S', 'wall_W', 'ceiling']) root.remove(root.getObjectByName(name)!);
	return root;
}

function partsScene(): Group {
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
	])
		root.add(placed(new Mesh(new PlaneGeometry(0.01, 0.01), new MeshBasicMaterial()), name, 0, 0, 0));
	return root;
}

let frames: Map<number, FrameRequestCallback>;
let now: number;
let lastScene: Scene | null;
let lastCamera: PerspectiveCamera | null;

function runFrames(ms: number): void {
	const end = now + ms;
	while (now < end) {
		now += 1000 / 30;
		const queued = [...frames.values()];
		frames.clear();
		for (const callback of queued) callback(now);
	}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(
	room: Group = roomScene(),
	signal: AbortSignal = new AbortController().signal,
): Promise<{handle: VoiceSceneHandle; container: HTMLElement; dispose(): void}> {
	env.scenes.push(room, partsScene());
	const container = document.createElement('div');
	Object.defineProperty(container, 'clientWidth', {value: WIDTH});
	Object.defineProperty(container, 'clientHeight', {value: HEIGHT});
	document.body.appendChild(container);
	const renderer = await createVoiceSceneRenderer({
		container,
		url: 'https://static.example/rooms/kahvehane.0123456789ab.glb',
		signal,
		onContextLost: vi.fn(),
	});
	runFrames(100);
	return {handle: renderer.handle, container, dispose: renderer.dispose};
}

function tableTopImages(): Array<unknown> {
	const images: Array<unknown> = [];
	lastScene?.traverse((object) => {
		if (object instanceof Mesh && object.material instanceof MeshBasicMaterial) {
			const map = object.material.map;
			if (map instanceof CanvasTexture) images.push(map.image);
		}
	});
	return images;
}

describe('createVoiceSceneRenderer (oda-3b-masa)', () => {
	beforeEach(() => {
		vi.mocked(computeBoundsTree).mockClear();
		env.rendererError = null;
		env.workers.length = 0;
		env.workerPosted = null;
		env.workerCallbackErrors.length = 0;
		vi.stubGlobal(
			'Worker',
			class {
				onmessage: ((event: {data: unknown}) => void) | null = null;
				onerror: ((event: {message: string}) => void) | null = null;
				stopped = false;
				constructor() {
					env.workers.push(this);
				}
				terminate = vi.fn(() => {
					this.stopped = true;
				});
				postMessage = vi.fn((message, transfer) => {
					const data = structuredClone(message, {transfer});
					env.workerPosted?.();
					if (this.stopped) return;
					queueMicrotask(() => {
						if (this.stopped) return;
						let response: {serialized: ReturnType<typeof MeshBVH.serialize> | null; error: unknown};
						try {
							const geometry = new BufferGeometry();
							geometry.setAttribute('position', new BufferAttribute(data.position, 3));
							if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
							geometry.groups = data.options.groups;
							const tree = computeBoundsTree.call(geometry, data.options) as MeshBVH;
							response = {serialized: MeshBVH.serialize(tree), error: null};
						} catch (error) {
							response = {serialized: null, error};
						}
						// Native event dispatch reports a throwing message callback; the worker does not turn it into a reply.
						try {
							if (!this.stopped) this.onmessage?.({data: response});
						} catch (error) {
							env.workerCallbackErrors.push(error);
						}
					});
				});
			},
		);
		env.scenes.length = 0;
		frames = new Map();
		now = 0;
		lastScene = null;
		lastCamera = null;
		let id = 0;
		env.render = (scene, camera) => {
			lastScene = scene as Scene;
			lastCamera = camera as PerspectiveCamera;
		};
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frames.set(++id, callback);
			return id;
		});
		vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response(new ArrayBuffer(8)))),
		);
	});

	afterEach(() => {
		env.rendererError = null;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it('BVHs are built once per shared geometry, kept across occluders and cut-away, and disposed with the room', async () => {
		const room = roomScene();
		const shared = new BoxGeometry(1, 1, 1);
		const first = new Mesh(shared, new MeshBasicMaterial());
		const second = new Mesh(shared, new MeshBasicMaterial());
		room.add(first, second);
		const index = Array.from(shared.index!.array);
		const originalRaycast = Mesh.prototype.raycast;
		const {handle, dispose} = await mount(room);
		const trees = new Map();
		room.traverse((object) => {
			if (object instanceof Mesh) trees.set(object.geometry, object.geometry.boundsTree);
		});
		expect([...trees.values()].every(Boolean)).toBe(true);
		expect(env.workers).toHaveLength(1);
		expect(env.workers[0]!.postMessage).toHaveBeenCalledTimes(trees.size);
		expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
		expect(computeBoundsTree).toHaveBeenCalledTimes(trees.size);
		expect(Array.from(shared.index!.array)).toEqual(index);
		const firstCheck = handle.occluder!();
		firstCheck({x: 0, y: 0, z: 0});
		handle.enterSeatView({seat: handle.layout.seats[0]!, slot: 'T01', game: null, role: 'player'});
		runFrames(600);
		handle.occluder!()({x: 0, y: 0, z: 0});
		for (const [geometry, tree] of trees) expect(geometry.boundsTree).toBe(tree);
		expect(computeBoundsTree).toHaveBeenCalledTimes(trees.size);
		expect(Mesh.prototype.raycast).toBe(originalRaycast);
		expect(first.raycast).toBe(originalRaycast);
		dispose();
		for (const geometry of trees.keys()) expect(geometry.boundsTree).toBeNull();
	});

	it('occlusion matches vanilla rays for visible meshes, material sides, transforms, layers and the anchor margin', async () => {
		const room = roomScene();
		room.getObjectByName('screen')!.position.x = 100;
		for (const name of ['wall_N', 'wall_E', 'wall_S', 'wall_W']) room.getObjectByName(name)!.clear();
		const front = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
		front.position.z = 5;
		const back = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({side: BackSide}));
		back.position.set(-2, 0, 5);
		const transformed = new Group();
		transformed.position.set(2, 0, 5);
		transformed.rotation.y = 0.3;
		transformed.scale.set(1.2, 0.8, 1.4);
		transformed.add(
			new Mesh(
				new BoxGeometry(1, 1, 1),
				Array.from({length: 6}, () => new MeshBasicMaterial({side: DoubleSide})),
			),
		);
		const hidden = new Group();
		hidden.visible = false;
		const hiddenMesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
		hiddenMesh.position.set(6, 0, 5);
		hidden.add(hiddenMesh);
		const otherLayer = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
		otherLayer.position.set(8, 0, 5);
		otherLayer.layers.set(1);
		room.add(front, back, transformed, hidden, otherLayer);
		const {handle, dispose} = await mount(room);
		lastCamera!.position.set(0, 0, 10);
		room.updateMatrixWorld(true);
		const raycast = vi.spyOn(front, 'raycast');
		const vanilla = (point: Vector3) => {
			const towards = point.clone().sub(lastCamera!.position);
			const far = towards.length() - 0.15;
			if (!(far > 0)) return false;
			const ray = new Raycaster(lastCamera!.position, towards.normalize(), 0, far);
			const meshes: Array<Mesh> = [];
			room.traverseVisible((object) => {
				if (object instanceof Mesh) meshes.push(object);
			});
			return ray.intersectObjects(meshes, false).length > 0;
		};
		const points = [
			new Vector3(0, 0, 0),
			new Vector3(-4, 0, 0),
			new Vector3(4, 0, 0),
			new Vector3(12, 0, 0),
			new Vector3(16, 0, 0),
			new Vector3(0, 0, 5.14),
			new Vector3(0, 0, 4.84),
			new Vector3(0, 0, 9.9),
			new Vector3(0, 0, 10),
		];
		for (const shown of [false, true, false]) {
			hidden.visible = shown;
			const check = handle.occluder!();
			const actual = points.map((point) => check(point));
			expect(raycast).not.toHaveBeenCalled();
			expect(actual).toEqual(points.map(vanilla));
			expect(actual[0]).toBe(true);
			expect(actual[1]).toBe(false);
			expect(actual[2]).toBe(true);
			expect(actual[3]).toBe(shown);
			expect(actual[4]).toBe(false);
			expect(actual.slice(5)).toEqual([false, true, false, false]);
			raycast.mockClear();
		}
		// The table picking path uses an ordinary Raycaster: it must still return all hits in distance order.
		const picking = new Raycaster(new Vector3(0.1, 0, 10), new Vector3(0, 0, -1));
		const rear = new Mesh(front.geometry, front.material);
		rear.position.z = 4;
		rear.updateMatrixWorld(true);
		const picked = picking.intersectObjects([rear, front], true);
		expect(picked).toHaveLength(2);
		expect(picked[0]!.object).toBe(front);
		expect(picked[1]!.object).toBe(rear);
		expect(raycast).toHaveBeenCalledTimes(1);
		expect(picking.firstHitOnly).toBeUndefined();
		dispose();
	});

	it('an abort during BVH preparation disposes all geometry and built trees before creating a canvas', async () => {
		const room = roomScene();
		const controller = new AbortController();
		const build = vi.mocked(computeBoundsTree).getMockImplementation()!;
		vi.mocked(computeBoundsTree).mockImplementationOnce(function (this: BufferGeometry, options) {
			const result = build.call(this, options);
			controller.abort();
			return result;
		});
		const meshes: Array<Mesh> = [];
		room.traverse((object) => {
			if (object instanceof Mesh) meshes.push(object);
		});
		const disposals = meshes.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
		await expect(mount(room, controller.signal)).rejects.toThrow();
		expect(computeBoundsTree).toHaveBeenCalledTimes(1);
		for (const mesh of meshes) expect(mesh.geometry.boundsTree == null).toBe(true);
		for (const disposal of disposals) expect(disposal).toHaveBeenCalled();
		expect(document.querySelector('canvas')).toBeNull();
	});

	it('a renderer setup failure releases prepared BVHs', async () => {
		const room = roomScene();
		const meshes: Array<Mesh> = [];
		room.traverse((object) => {
			if (object instanceof Mesh) meshes.push(object);
		});
		env.rendererError = new Error('WebGL unavailable');
		await expect(mount(room)).rejects.toThrow('WebGL unavailable');
		expect(computeBoundsTree).toHaveBeenCalledTimes(meshes.length);
		for (const mesh of meshes) expect(mesh.geometry.boundsTree).toBeNull();
	});

	it('a failed BVH build releases trees built earlier in preparation', async () => {
		const room = roomScene();
		const build = vi.mocked(computeBoundsTree).getMockImplementation()!;
		vi.mocked(computeBoundsTree)
			.mockImplementationOnce(build)
			.mockImplementationOnce(() => {
				throw new Error('BVH build failed');
			});
		await expect(mount(room)).rejects.toThrow('BVH build failed');
		room.traverse((object) => {
			if (object instanceof Mesh) expect(object.geometry.boundsTree == null).toBe(true);
		});
		expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
	});

	it('aborting a pending worker terminates it immediately and rejects setup', async () => {
		const controller = new AbortController();
		env.workerPosted = () => {
			controller.abort();
			expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
		};
		await expect(mount(roomScene(), controller.signal)).rejects.toThrow();
		expect(computeBoundsTree).not.toHaveBeenCalled();
		expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
	});

	it('a native worker error rejects setup and releases the worker', async () => {
		env.workerPosted = () => env.workers[0]!.onerror?.(new ErrorEvent('error', {message: 'worker crashed'}));
		await expect(mount()).rejects.toThrow('Room BVH worker failed: worker crashed');
		expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
		expect(document.querySelector('canvas')).toBeNull();
	});

	it('a BVH decoder failure rejects setup and terminates the worker instead of leaving loading pending', async () => {
		vi.spyOn(MeshBVH, 'deserialize').mockImplementationOnce(() => {
			throw new Error('invalid BVH response');
		});
		const result = await Promise.race([
			mount().then(
				() => 'mounted',
				(error: Error) => error.message,
			),
			new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30)),
		]);
		expect(result).toBe('invalid BVH response');
		expect(env.workerCallbackErrors).toEqual([]);
		expect(env.workers[0]!.terminate).toHaveBeenCalledTimes(1);
	});

	it('worker BVHs keep nonindexed geometry and ordinary picking equivalent', async () => {
		const room = roomScene();
		const geometry = new PlaneGeometry(1, 1).toNonIndexed();
		const mesh = new Mesh(geometry, new MeshBasicMaterial());
		mesh.position.set(0, 0, 5);
		room.add(mesh);
		const {handle, dispose} = await mount(room);
		expect(geometry.index).toBeNull();
		lastCamera!.position.set(0, 0, 10);
		const check = handle.occluder!();
		expect(check({x: 0.1, y: 0.2, z: 0})).toBe(true);
		expect(check({x: 0, y: 0, z: 5.14})).toBe(false);
		const ray = new Raycaster(lastCamera!.position, new Vector3(0.01, 0.02, -1).normalize());
		expect(ray.intersectObject(mesh)).toHaveLength(1);
		expect(geometry.index).toBeNull();
		dispose();
		expect(geometry.boundsTree).toBeNull();
	});

	it('normalized quantized GLB positions match vanilla rays across the mesh without changing their original data', async () => {
		const room = roomScene();
		const geometry = new PlaneGeometry(2, 2, 20, 20);
		const quantized = new Int16Array(geometry.getAttribute('position').array.map((value) => Math.round(value * 32767)));
		const original = Array.from(quantized);
		const attribute = new BufferAttribute(quantized, 3, true);
		geometry.setAttribute('position', attribute);
		const mesh = new Mesh(geometry, new MeshBasicMaterial());
		mesh.position.z = 5;
		room.add(mesh);
		const {handle, dispose} = await mount(room);
		lastCamera!.position.set(0, 0, 10);
		const check = handle.occluder!();
		const actual: Array<boolean> = [];
		const expected: Array<boolean> = [];
		for (let x = -8; x <= 8; x++) {
			for (let y = -8; y <= 8; y++) {
				const point = new Vector3(x * 0.27, y * 0.25, 0);
				const towards = point.clone().sub(lastCamera!.position);
				const ray = new Raycaster(lastCamera!.position, towards.clone().normalize(), 0, towards.length() - 0.15);
				actual.push(check(point));
				expected.push(ray.intersectObject(mesh).length > 0);
			}
		}
		expect(actual).toEqual(expected);
		expect(expected.some(Boolean)).toBe(true);
		expect(geometry.getAttribute('position')).toBe(attribute);
		expect(attribute.normalized).toBe(true);
		expect(Array.from(quantized)).toEqual(original);
		dispose();
	});

	it('worker transfers preserve shared GLB buffers, attributes and finite triangle draw ranges', async () => {
		const room = roomScene();
		const shared = new ArrayBuffer(18 * 4);
		const positions = new Float32Array(shared, 0, 9);
		positions.set([-1, -1, 5, 1, -1, 5, 0, 1, 5]);
		const normals = new Float32Array(shared, 9 * 4, 9);
		normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const indices = new Uint16Array([0, 1, 2]);
		const geometries = [new BufferGeometry(), new BufferGeometry()];
		for (const geometry of geometries) {
			geometry.setAttribute('position', new BufferAttribute(positions, 3));
			geometry.setAttribute('normal', new BufferAttribute(normals, 3));
			geometry.setIndex(new BufferAttribute(indices, 1));
			room.add(new Mesh(geometry, new MeshBasicMaterial()));
		}
		const ranged = new PlaneGeometry(1, 1);
		ranged.setDrawRange(0, 3);
		room.add(new Mesh(ranged, new MeshBasicMaterial()));
		const {handle, dispose} = await mount(room);
		expect(shared.byteLength).toBe(72);
		expect(indices.buffer.byteLength).toBe(6);
		for (const geometry of geometries) {
			expect(geometry.getAttribute('position').array).toBe(positions);
			expect(geometry.getAttribute('normal').array).toBe(normals);
			expect(geometry.index!.array).toBe(indices);
		}
		expect(Array.from(positions)).toEqual([-1, -1, 5, 1, -1, 5, 0, 1, 5]);
		expect(Array.from(normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		lastCamera!.position.set(0, 0, 10);
		const ray = new Raycaster(lastCamera!.position, new Vector3(0.02, 0.03, -1).normalize());
		const accelerated: Array<unknown> = [];
		// Indirect BVH retains the original geometry, including its finite draw range.
		ranged.boundsTree!.raycastObject3D(room.children.at(-1)!, ray, accelerated as never);
		expect(accelerated.length).toBe(ray.intersectObject(room.children.at(-1)!, false).length);
		expect(handle.occluder!()({x: 0, y: 0, z: 0})).toBe(true);
		dispose();
	});
	it('closing a room releases each decoded bitmap once, including images shared by textures and meshes', async () => {
		class DecodedBitmap {
			close = vi.fn();
		}
		vi.stubGlobal('ImageBitmap', DecodedBitmap);
		const bitmap = new DecodedBitmap();
		const room = roomScene();
		const first = new Texture(bitmap);
		const second = new Texture(bitmap);
		const material = new MeshBasicMaterial({map: first, alphaMap: second});
		room.add(new Mesh(new PlaneGeometry(), material), new Mesh(new PlaneGeometry(), material));
		const firstDispose = vi.spyOn(first, 'dispose');
		const secondDispose = vi.spyOn(second, 'dispose');
		const {dispose} = await mount(room);

		expect(bitmap.close).not.toHaveBeenCalled();
		dispose();

		expect(firstDispose).toHaveBeenCalled();
		expect(secondDispose).toHaveBeenCalled();
		expect(bitmap.close).toHaveBeenCalledTimes(1);
	});

	it('closing a room lets go of the table parts it used, so the next room loads them afresh', async () => {
		const partsFetches = () =>
			vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('masa-parcalari')).length;
		const first = await mount();
		first.handle.mountTableGame('T01', 'chess');
		await flush();
		const before = partsFetches();
		first.dispose();

		const second = await mount();
		second.handle.mountTableGame('T01', 'chess');
		await flush();

		expect(partsFetches()).toBe(before + 1);
		second.dispose();
	});

	it.each(['contract', 'abort'] as const)(
		'releases decoded bitmaps when room creation fails at %s',
		async (failure) => {
			class DecodedBitmap {
				close = vi.fn();
			}
			vi.stubGlobal('ImageBitmap', DecodedBitmap);
			const bitmap = new DecodedBitmap();
			const room = failure === 'contract' ? olderRoomScene() : roomScene();
			room.add(new Mesh(new PlaneGeometry(), new MeshBasicMaterial({map: new Texture(bitmap)})));
			env.scenes.push(room);
			const abort = new AbortController();
			if (failure === 'abort') abort.abort();

			await expect(
				createVoiceSceneRenderer({
					container: document.createElement('div'),
					url: 'https://static.example/rooms/kahvehane.0123456789ab.glb',
					signal: abort.signal,
					onContextLost: vi.fn(),
				}),
			).rejects.toThrow(failure === 'contract' ? /Room GLB contract/ : /aborted/);
			expect(bitmap.close).toHaveBeenCalledTimes(1);
		},
	);

	it('enterSeatView moves the camera to the seated pose and the whole room shows (D4)', async () => {
		const {handle, dispose} = await mount();
		expect(handle.getCameraMode()).toBe('orbit');
		const modes: Array<SceneCameraMode> = [];
		handle.onCameraModeChange((mode) => modes.push(mode));

		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);

		const pose = seatedPose({layout: handle.layout, seat, slot: 'T01', game: 'chess', aspect: WIDTH / HEIGHT});
		expect(handle.getCameraMode()).toBe('seat');
		expect(modes).toEqual(['seat']);
		expect(lastCamera!.position.distanceTo(new Vector3(pose.eye.x, pose.eye.y, pose.eye.z))).toBeLessThan(1e-6);
		const hidden: Array<string> = [];
		lastScene!.traverse((object) => {
			if (!object.visible) hidden.push(object.name);
		});
		expect(hidden).toEqual([]);
		// The seat is a pose of the same scene: back to the room on exit.
		handle.exitToOrbit();
		runFrames(600);
		expect(handle.getCameraMode()).toBe('orbit');
		expect(modes).toEqual(['seat', 'orbit']);
		dispose();
	});

	it('a game set up at my table moves the seat view to its chess pose in one smooth tween', async () => {
		const {handle, dispose} = await mount();
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		const modes: Array<SceneCameraMode> = [];
		handle.onCameraModeChange((mode) => modes.push(mode));
		handle.enterSeatView({seat, slot: 'T01', game: null, role: 'player'});
		runFrames(600);
		const pose = (game: 'chess' | null) =>
			seatedPose({layout: handle.layout, seat, slot: 'T01', game, aspect: WIDTH / HEIGHT});
		const eye = (game: 'chess' | null) => new Vector3(pose(game).eye.x, pose(game).eye.y, pose(game).eye.z);
		expect(lastCamera!.position.distanceTo(eye(null))).toBeLessThan(1e-6);
		expect(eye(null).distanceTo(eye('chess'))).toBeCloseTo(Math.hypot(0.54 - 0.14, 0.05 - 0.15), 9);
		// useSeatView re-enters with the new kind (its test: 'a game set up at my table re-enters with its pose').
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		const frame = 1000 / 30;
		const path: Array<number> = [];
		let elapsed = 0;
		let arrived = Number.POSITIVE_INFINITY;
		while (frames.size > 0 && elapsed < 2000) {
			runFrames(frame);
			elapsed += frame;
			path.push(lastCamera!.position.distanceTo(eye(null)));
			if (arrived === Number.POSITIVE_INFINITY && lastCamera!.position.distanceTo(eye('chess')) < 1e-6)
				arrived = elapsed;
		}
		// No jump: the eye moves in steps and arrives within the tween time, give or take the 30 fps frames
		// (the first one starts it, the one past its end lands it); a frame or two later the loop goes quiet.
		expect(arrived).toBeLessThanOrEqual(CAMERA_TWEEN_MS + 2 * frame);
		expect(elapsed - arrived).toBeLessThanOrEqual(3 * frame);
		expect(path.length).toBeGreaterThan(5);
		const travel = eye(null).distanceTo(eye('chess'));
		for (let i = 1; i < path.length; i++) expect((path[i]! - path[i - 1]!) / travel).toBeLessThan(0.25);
		expect(lastCamera!.position.distanceTo(eye('chess'))).toBeLessThan(1e-6);
		expect(lastCamera!.fov).toBeCloseTo(pose('chess').fovDeg, 6);
		// Never turned: it ends looking where the chess pose looks (the board), not along the lobby's look.
		const target = pose('chess').target;
		const wanted = new Vector3(target.x, target.y, target.z).sub(eye('chess')).normalize();
		expect(lastCamera!.getWorldDirection(new Vector3()).dot(wanted)).toBeCloseTo(1, 9);
		// Still seated all along: no mode change for the overlay.
		expect(handle.getCameraMode()).toBe('seat');
		expect(modes).toEqual(['seat']);
		dispose();
	});

	it('project scale uses the seat reference distance in seat mode', async () => {
		const {handle, dispose} = await mount();
		// Orbit: 1 at the cam_home distance (the camera sits at cam_home looking at cam_target).
		expect(handle.project(handle.layout.camTarget).scale).toBeCloseTo(1, 6);
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_3') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'okey', role: 'player'});
		runFrames(600);
		const eye = lastCamera!.position;
		const projected = handle.project({x: CENTER.x, y: CENTER.y, z: CENTER.z});
		expect(projected.scale).toBeCloseTo(SEAT_VIEW_REFERENCE_M / eye.distanceTo(CENTER), 6);
		expect(projected.visible).toBe(true);
		dispose();
	});

	it('screen layer replaces CSS3DRenderer (no CSS3DRenderer import)', async () => {
		// vitest runs from fluxer_app/.
		const source = readFileSync(`${process.cwd()}/src/features/voice_scene/scene/VoiceSceneRenderer.ts`, 'utf8');
		expect(source).not.toMatch(/CSS3DRenderer|CSS3DObject/);
		const {handle, container, dispose} = await mount();
		const tv = document.createElement('div');
		handle.attachScreenElement(tv);
		expect(container.contains(tv)).toBe(true);
		handle.attachScreenElement(null);
		expect(container.contains(tv)).toBe(false);
		dispose();
	});

	it('seat view: the TV layer takes no pointer events, so a press over it reaches the table, not focusScreen (A4)', async () => {
		const {handle, dispose} = await mount();
		const tv = document.createElement('div');
		handle.attachScreenElement(tv);
		const holder = tv.parentElement as HTMLElement;
		expect(holder.style.pointerEvents).toBe('auto');
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		expect(holder.style.pointerEvents).toBe('none');
		handle.exitToOrbit();
		runFrames(600);
		expect(holder.style.pointerEvents).toBe('auto');
		handle.focusScreen();
		runFrames(600);
		expect(handle.getCameraMode()).toBe('focus');
		expect(holder.style.pointerEvents).toBe('auto');
		dispose();
	});

	it('setTableTop ignored for a mounted 3D table, restored on unmount', async () => {
		const {handle, dispose} = await mount();
		const first = document.createElement('canvas');
		const second = document.createElement('canvas');
		handle.setTableTop('T01', first);
		runFrames(50);
		expect(tableTopImages()).toEqual([first]);

		const made = vi.fn();
		env.modelMade = made;
		const game = handle.mountTableGame('T01', 'chess');
		expect(game).not.toBeNull();
		await flush();
		runFrames(50);
		expect(made).toHaveBeenCalledTimes(1);
		expect(tableTopImages()).toEqual([]);
		handle.setTableTop('T01', second);
		runFrames(50);
		expect(tableTopImages()).toEqual([]);

		game!.dispose();
		runFrames(50);
		expect(tableTopImages()).toEqual([second]);
		env.modelMade = null;
		dispose();
	});

	it('a table animation steps on every frame while the camera moves, then 0 frames (Ş7)', async () => {
		const {handle, dispose} = await mount();
		const game = handle.mountTableGame('T01', 'chess');
		await flush();
		runFrames(100);
		let draws = 0;
		env.render = () => {
			draws++;
		};
		let steps = 0;
		env.modelAnimating = () => ++steps <= 3;
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(1000);
		expect(draws).toBeGreaterThan(3);
		// The camera tween keeps frames coming; the model must still be asked (and so step) on each of them.
		expect(steps).toBe(draws);
		const settled = draws;
		runFrames(1000);
		expect(draws).toBe(settled);
		env.modelAnimating = null;
		game!.dispose();
		dispose();
	});

	it('cut-away (rev 4): orbiting, a wall hides only near or beyond its plane, the ceiling only above it; seated or on the TV nothing hides; idle stays idle (Ş7)', async () => {
		const {handle, container, dispose} = await mount();
		const shown = () =>
			Object.fromEntries(
				['wall_N', 'wall_E', 'wall_S', 'wall_W', 'ceiling'].map((name) => [
					name,
					lastScene!.getObjectByName(name)!.visible,
				]),
			);
		// cam_home (8.5, 21, 23): beyond the south and east walls, above the ceiling.
		expect(shown()).toEqual({wall_N: true, wall_E: false, wall_S: false, wall_W: true, ceiling: false});
		expect(frames.size).toBe(0);
		// Seated: nothing is cut away, not even a wall a seat stands near.
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		expect(shown()).toEqual({wall_N: true, wall_E: true, wall_S: true, wall_W: true, ceiling: true});
		handle.exitToOrbit();
		runFrames(600);
		expect(shown()).toEqual({wall_N: true, wall_E: false, wall_S: false, wall_W: true, ceiling: false});
		// Nor on the TV.
		handle.focusScreen();
		runFrames(600);
		expect(shown()).toEqual({wall_N: true, wall_E: true, wall_S: true, wall_W: true, ceiling: true});
		handle.exitToOrbit();
		runFrames(600);
		// Half way round (720 px at rotateSpeed 0.5 = 180°): beyond the north and west walls instead.
		const canvas = container.querySelector('canvas')!;
		Object.defineProperty(canvas, 'clientHeight', {value: HEIGHT});
		const at = {pointerId: 1, button: 0, pointerType: 'mouse', clientX: 600, clientY: 300};
		canvas.dispatchEvent(new PointerEvent('pointerdown', at));
		document.dispatchEvent(new PointerEvent('pointermove', {...at, clientX: 600 + HEIGHT}));
		document.dispatchEvent(new PointerEvent('pointerup', {...at, clientX: 600 + HEIGHT}));
		runFrames(3000);
		expect(lastCamera!.position.x).toBeLessThan(-7);
		expect(lastCamera!.position.z).toBeLessThan(-6.2);
		expect(shown()).toEqual({wall_N: false, wall_E: true, wall_S: true, wall_W: false, ceiling: false});
		// Settled: no frame is asked for (the cut-away is worked out on camera changes only).
		expect(frames.size).toBe(0);
		dispose();
	});

	it('from a seat facing a TV high on the wall, the TV layer shows (F-cam 1: 40° down while seated)', async () => {
		const room = roomScene();
		// 3.6 m in front of seat 1's eye, 1.8 m above it: 26° up, out of the orbit cone, inside the seated one.
		room.getObjectByName('screen')!.position.set(0, 3, -2.5);
		const {handle, container, dispose} = await mount(room);
		const tv = document.createElement('div');
		handle.attachScreenElement(tv);
		const holder = tv.parentElement as HTMLElement;
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		// Look up at it (the seat's look turns +30° at most).
		const canvas = container.querySelector('canvas')!;
		Object.defineProperty(canvas, 'clientHeight', {value: HEIGHT});
		const at = {pointerId: 1, button: 0, pointerType: 'mouse', clientX: 600, clientY: 300};
		canvas.dispatchEvent(new PointerEvent('pointerdown', at));
		document.dispatchEvent(new PointerEvent('pointermove', {...at, clientY: 300 + HEIGHT}));
		document.dispatchEvent(new PointerEvent('pointerup', {...at, clientY: 300 + HEIGHT}));
		runFrames(2000);
		expect(handle.screenInView()).toBe(true);
		expect(holder.style.display).not.toBe('none');
		dispose();
	});

	it('a wall group is found by its node, not its name: an unnamed one never hides the whole room (F-cam 4)', async () => {
		const room = roomScene();
		room.name = '';
		room.getObjectByName('wall_S')!.name = '';
		const {dispose} = await mount(room);
		// cam_home is beyond the south wall: that group hides, the room stays.
		expect(room.visible).toBe(true);
		const south = room.children.find((child) => child.userData.wall_plane?.[1] === 1.8)!;
		expect(south.visible).toBe(false);
		dispose();
	});

	it('the cut-away waits for a settled orbit: no wall hides on the way between seats or back to the room (F-cam 5)', async () => {
		const {handle, dispose} = await mount();
		const south = () => lastScene!.getObjectByName('wall_S')!.visible;
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: null, role: 'player'});
		runFrames(600);
		expect(south()).toBe(true);
		// The game changes: the eye glides to the chess pose; the nearby wall stays all the way.
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		for (let i = 0; i < 20; i++) {
			runFrames(1000 / 30);
			expect(south(), `frame ${i}`).toBe(true);
		}
		// Back to the room: shown until the camera has settled out there, then cut away (cam_home is beyond it).
		handle.exitToOrbit();
		runFrames(1000 / 30);
		runFrames(1000 / 30);
		expect(south()).toBe(true);
		runFrames(1000);
		expect(handle.getCameraMode()).toBe('orbit');
		expect(south()).toBe(false);
		dispose();
	});

	it('the same seat posed again (a resize) keeps the look the viewer turned to (F-cam 6)', async () => {
		const {handle, container, dispose} = await mount();
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		const target = {seat, slot: 'T01', game: 'chess' as const, role: 'player' as const};
		handle.enterSeatView(target);
		runFrames(600);
		const canvas = container.querySelector('canvas')!;
		Object.defineProperty(canvas, 'clientHeight', {value: HEIGHT});
		const at = {pointerId: 1, button: 0, pointerType: 'mouse', clientX: 600, clientY: 300};
		canvas.dispatchEvent(new PointerEvent('pointerdown', at));
		document.dispatchEvent(new PointerEvent('pointermove', {...at, clientX: 900}));
		document.dispatchEvent(new PointerEvent('pointerup', {...at, clientX: 900}));
		runFrames(2000);
		const turned = lastCamera!.getWorldDirection(new Vector3());
		handle.enterSeatView({...target});
		runFrames(600);
		expect(lastCamera!.getWorldDirection(new Vector3()).dot(turned)).toBeCloseTo(1, 9);
		// Another seat starts from its own look.
		const other = handle.layout.seats.find((entry) => entry.name === 'seat_T01_3') as RoomSeat;
		handle.enterSeatView({seat: other, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		const pose = seatedPose({layout: handle.layout, seat: other, slot: 'T01', game: 'chess', aspect: WIDTH / HEIGHT});
		const wanted = new Vector3(
			pose.target.x - pose.eye.x,
			pose.target.y - pose.eye.y,
			pose.target.z - pose.eye.z,
		).normalize();
		expect(lastCamera!.getWorldDirection(new Vector3()).dot(wanted)).toBeCloseTo(1, 6);
		dispose();
	});

	it('occluder: visible room geometry between the camera and a point, hidden groups and the point’s own surface aside (F-cam 8)', async () => {
		const {handle, dispose} = await mount();
		// One tester per rest check, over the meshes visible when it was made.
		const occluded = (point: {x: number; y: number; z: number}) => handle.occluder()(point);
		// From cam_home: just behind the TV quad is covered, just in front of it is not.
		expect(occluded({x: 0, y: 2.2, z: -6.5})).toBe(true);
		expect(occluded({x: 0, y: 2.2, z: -5})).toBe(false);
		// 10 cm behind the quad (≈ 0.13 m along the ray): the last 0.15 m before a point never count (what an anchor
		// sits on or in).
		expect(occluded({x: 0, y: 2.2, z: -6.1})).toBe(false);
		// The fixture's wall quads all lie on the origin: leave the south wall's alone there. Its group is cut away from
		// here, so it covers nothing; shown, it covers the point behind it.
		for (const name of ['wall_N', 'wall_E', 'wall_W'])
			for (const quad of lastScene!.getObjectByName(name)!.children) quad.visible = false;
		const south = lastScene!.getObjectByName('wall_S')!;
		expect(south.visible).toBe(false);
		expect(occluded({x: 0, y: 0, z: -0.3})).toBe(false);
		south.visible = true;
		expect(occluded({x: 0, y: 0, z: -0.3})).toBe(true);
		dispose();
	});

	it('handle.wheel hands a wheel from the DOM over the canvas to the camera (D3: the TV poster, avatars)', async () => {
		const {handle, container, dispose} = await mount();
		const canvas = container.querySelector('canvas')!;
		canvas.getBoundingClientRect = () =>
			({left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, x: 0, y: 0}) as DOMRect;
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		const base = lastCamera!.fov;
		const event = new WheelEvent('wheel', {deltaY: -100, cancelable: true});
		Object.defineProperties(event, {clientX: {value: WIDTH / 2}, clientY: {value: HEIGHT / 2}});
		handle.wheel(event);
		runFrames(600);
		expect(lastCamera!.fov).toBeLessThan(base);
		dispose();
	});

	it('a wheel on the TV (its picture, or its poster through handle.wheel) goes into the TV focus near enough (D3, DOM events)', async () => {
		// As in browsers, a WheelEvent is a MouseEvent (happy-dom's is not): a copy keeps the pointer position.
		class BrowserWheelEvent extends MouseEvent {
			readonly deltaX: number;
			readonly deltaY: number;
			readonly deltaZ = 0;
			readonly deltaMode: number;
			readonly DOM_DELTA_PIXEL = 0;
			readonly DOM_DELTA_LINE = 1;
			readonly DOM_DELTA_PAGE = 2;
			constructor(type: string, init: WheelEventInit = {}) {
				super(type, init);
				this.deltaX = init.deltaX ?? 0;
				this.deltaY = init.deltaY ?? 0;
				this.deltaMode = init.deltaMode ?? 0;
			}
		}
		vi.stubGlobal('WheelEvent', BrowserWheelEvent);
		const room = roomScene();
		// A pan box reaching the TV wall, as rev 5 rooms have.
		room.getObjectByName('cam_target')!.userData = {pan_x: 6, pan_z: 5};
		const {handle, container, dispose} = await mount(room);
		const canvas = container.querySelector('canvas')!;
		canvas.getBoundingClientRect = () =>
			({left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, x: 0, y: 0}) as DOMRect;
		const tv = document.createElement('div');
		handle.attachScreenElement(tv);
		const notchOnTv = (send: (event: WheelEvent) => void): number => {
			let notches = 0;
			while (handle.getCameraMode() === 'orbit' && notches < 40) {
				const at = handle.project(handle.layout.screen!.center);
				send(
					new BrowserWheelEvent('wheel', {deltaY: -100, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true}),
				);
				runFrames(100);
				notches++;
			}
			return notches;
		};
		// Watching: the wheel lands on the TV layer's element.
		expect(notchOnTv((event) => tv.dispatchEvent(event))).toBeLessThan(40);
		expect(handle.getCameraMode()).toBe('focus');
		handle.exitToOrbit();
		runFrames(600);
		handle.attachScreenElement(null);
		// Not watching: the poster (an anchor) hands it on.
		expect(notchOnTv((event) => handle.wheel(event))).toBeLessThan(40);
		expect(handle.getCameraMode()).toBe('focus');
		dispose();
	});

	it('a room GLB older than rev 4 does not load: the flat view takes over (D11)', async () => {
		await expect(mount(olderRoomScene())).rejects.toThrow(/Room GLB contract/);
	});

	it('seated, a narrowed view scales the DOM over it with the room (D7)', async () => {
		const {handle, container, dispose} = await mount();
		const canvas = container.querySelector('canvas')!;
		canvas.getBoundingClientRect = () =>
			({left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, x: 0, y: 0}) as DOMRect;
		const seat = handle.layout.seats.find((entry) => entry.name === 'seat_T01_1') as RoomSeat;
		handle.enterSeatView({seat, slot: 'T01', game: 'chess', role: 'player'});
		runFrames(600);
		const base = lastCamera!.fov;
		const before = handle.project({x: CENTER.x, y: CENTER.y, z: CENTER.z});
		const wheel = new WheelEvent('wheel', {deltaY: -100, cancelable: true});
		Object.defineProperties(wheel, {clientX: {value: WIDTH / 2}, clientY: {value: HEIGHT / 2}});
		canvas.dispatchEvent(wheel);
		runFrames(600);
		const narrowed = lastCamera!.fov;
		expect(narrowed).toBeLessThan(base);
		const after = handle.project({x: CENTER.x, y: CENTER.y, z: CENTER.z});
		const ratio = Math.tan((base * Math.PI) / 360) / Math.tan((narrowed * Math.PI) / 360);
		expect(after.scale).toBeCloseTo(before.scale * ratio, 6);
		expect(frames.size).toBe(0);
		dispose();
	});

	it('a kind this build does not know gets no 3D table', async () => {
		const {handle, dispose} = await mount();
		expect(handle.mountTableGame('T01', 'backgammon_plus' as never)).toBeNull();
		dispose();
	});
});

function named(object: Object3D, name: string, x: number, y: number, z: number): Object3D {
	object.name = name;
	object.position.set(x, y, z);
	return object;
}

describe('collectContractNodes', () => {
	it('reads world positions of named empties and extras from userData', () => {
		const root = new Group();
		const offset = named(new Group(), 'Collection', 1, 0, 0);
		const table = named(new Object3D(), 'table_T01', -3, 0.8, 0);
		table.userData = {top_size: 1.3};
		offset.add(named(new Object3D(), 'seat_A_01', 0, 1.1, 0), table);
		root.add(offset);
		const nodes = collectContractNodes(root);
		const seat = nodes.find((node) => node.name === 'seat_A_01');
		expect(seat?.position).toEqual({x: 1, y: 1.1, z: 0});
		expect(nodes.find((node) => node.name === 'table_T01')?.userData).toEqual({top_size: 1.3});
		expect(nodes.some((node) => node.name === 'Collection')).toBe(false);
	});

	it('screen quad gives center, size and facing normal in world space', () => {
		const root = new Group();
		const screen = named(new Mesh(new PlaneGeometry(1.6, 0.9), new MeshBasicMaterial()), 'screen', 0, 2, -4);
		// The quad faces +Z in its own space; a quarter turn makes it face -X (a TV on the east wall).
		screen.rotation.y = -Math.PI / 2;
		root.add(screen);
		const node = collectContractNodes(root).find((entry) => entry.name === 'screen');
		expect(node?.position.x).toBeCloseTo(0);
		expect(node?.position.y).toBeCloseTo(2);
		expect(node?.position.z).toBeCloseTo(-4);
		expect(node?.plane?.width).toBeCloseTo(1.6);
		expect(node?.plane?.height).toBeCloseTo(0.9);
		expect(node?.plane?.normal.x).toBeCloseTo(-1);
		expect(node?.plane?.normal.y).toBeCloseTo(0);
		expect(node?.plane?.normal.z).toBeCloseTo(0);
	});
});

describe('projectPoint', () => {
	const camera = new PerspectiveCamera(24, 2, 0.1, 500);
	camera.position.set(0, 0, 10);
	camera.lookAt(0, 0, 0);
	camera.updateMatrixWorld();
	const size = {width: 800, height: 400};

	it('maps the look-at point to the canvas centre with scale 1 at the home distance', () => {
		const projected = projectPoint(camera, size, 10, {x: 0, y: 0, z: 0});
		expect(projected.x).toBeCloseTo(400);
		expect(projected.y).toBeCloseTo(200);
		expect(projected.visible).toBe(true);
		expect(projected.scale).toBeCloseTo(1);
		expect(projectPoint(camera, size, 10, {x: 0, y: 0, z: 5}).scale).toBeCloseTo(2);
	});

	it('screen y grows downwards like CSS', () => {
		expect(projectPoint(camera, size, 10, {x: 0, y: 1, z: 0}).y).toBeLessThan(200);
		expect(projectPoint(camera, size, 10, {x: 1, y: 0, z: 0}).x).toBeGreaterThan(400);
	});

	it('points behind the camera or outside the canvas are not visible', () => {
		expect(projectPoint(camera, size, 10, {x: 0, y: 0, z: 20}).visible).toBe(false);
		expect(projectPoint(camera, size, 10, {x: 50, y: 0, z: 0}).visible).toBe(false);
	});
});
