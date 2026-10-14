// SPDX-License-Identifier: AGPL-3.0-or-later

// VoiceSceneView loads this module with import(): it and everything under scene/ that imports three (camera rig, TV
// layer, 3D table host, parts, models) form one lazy chunk (KW-LAZY).

import {createRoomCameraRig} from '@app/features/voice_scene/scene/RoomCameraRig';
import {createScreenLayer} from '@app/features/voice_scene/scene/ScreenLayer';
import {mountTableGame3D, type TableGame3DHost} from '@app/features/voice_scene/scene/TableGame3DHost';
import {createBoardTableModel} from '@app/features/voice_scene/scene/table/BoardTableModel';
import {createOkeyTableModel} from '@app/features/voice_scene/scene/table/OkeyTableModel';
import type {TableGame3DModelFactory} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {releaseTableParts} from '@app/features/voice_scene/scene/table/TableParts';
import {createTavlaTableModel} from '@app/features/voice_scene/scene/table/TavlaTableModel';
import {createRenderLoop} from '@app/features/voice_scene/scene/VoiceSceneRenderLoop';
import type {SceneCameraMode, Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {cutawayHidden, REFERENCE_FOV_DEG, screenInView} from '@app/features/voice_scene/utils/CameraLimits';
import {parseRoomLayout, type RoomContractNode} from '@app/features/voice_scene/utils/GlbRoomContract';
import {SEAT_VIEW_REFERENCE_M, seatedPose} from '@app/features/voice_scene/utils/SeatedView';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	Box3,
	type BufferGeometry,
	CanvasTexture,
	type Intersection,
	type Material,
	Mesh,
	MeshBasicMaterial,
	NoToneMapping,
	type Object3D,
	PerspectiveCamera,
	PlaneGeometry,
	Raycaster,
	Scene,
	SRGBColorSpace,
	Texture,
	Vector3,
	WebGLRenderer,
} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {acceleratedRaycast, disposeBoundsTree, MeshBVH} from 'three-mesh-bvh';

const MAX_PIXEL_RATIO = 2;
// rays stop this short of an anchor's point, so what it sits on or in does not count as in front of it.
const OCCLUSION_MARGIN_M = 0.15;
const TABLE_TOP_LIFT_M = 0.003;
const CONTRACT_NAME = /^(?:seat_|stand_|table_|cam_target$|cam_home$|screen$)/;

// Model registry. A kind this build does not know (a newer client set the table up) gets no 3D table.
const TABLE_MODELS: Partial<Record<string, TableGame3DModelFactory>> = {
	okey: createOkeyTableModel,
	okey101: createOkeyTableModel,
	chess: createBoardTableModel,
	dama: createBoardTableModel,
	dama_normal: createBoardTableModel,
	tavla: createTavlaTableModel,
};
const tableModelFor = (game: TableGameKind): TableGame3DModelFactory | undefined => TABLE_MODELS[game];

const toVec3 = (v: Vector3): Vec3 => ({x: v.x, y: v.y, z: v.z});

function measureQuad(root: Object3D): Pick<RoomContractNode, 'position' | 'plane'> | null {
	const meshes: Array<Mesh> = [];
	root.traverse((object) => {
		if (object instanceof Mesh) meshes.push(object);
	});
	const points: Array<Vector3> = [];
	let facing: Vector3 | null = null;
	for (const mesh of meshes) {
		const positions = mesh.geometry.getAttribute('position');
		for (let i = 0; i < positions.count; i++)
			points.push(new Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
		// The exported vertex normal is the front of the quad, which faces into the room.
		const normals = mesh.geometry.getAttribute('normal');
		if (!facing && normals) facing = new Vector3().fromBufferAttribute(normals, 0).transformDirection(mesh.matrixWorld);
	}
	if (points.length < 3 || !facing) return null;
	const center = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
	// A TV hangs upright: its up axis is world up flattened onto the quad.
	const up = new Vector3(0, 1, 0).addScaledVector(facing, -facing.y).normalize();
	const right = new Vector3().crossVectors(up, facing);
	const extent = (axis: Vector3): number => {
		const along = points.map((point) => point.clone().sub(center).dot(axis));
		return Math.max(...along) - Math.min(...along);
	};
	return {position: toVec3(center), plane: {width: extent(right), height: extent(up), normal: toVec3(facing)}};
}

// World-space contract nodes of a loaded room (names: docs/oda-3b/GLB-SOZLESME.md; rev 4 cut-away groups by their
// extras); glTF extras arrive as userData.
export function collectContractNodes(root: Object3D): Array<RoomContractNode> {
	root.updateMatrixWorld(true);
	const nodes: Array<RoomContractNode> = [];
	root.traverse((object) => {
		const cutaway = 'wall_plane' in object.userData || 'ceiling_y' in object.userData;
		if (!cutaway && !CONTRACT_NAME.test(object.name)) return;
		const node: RoomContractNode = {
			name: object.name,
			position: toVec3(object.getWorldPosition(new Vector3())),
			userData: object.userData,
			...(cutaway ? {id: object.uuid} : {}),
		};
		nodes.push(object.name === 'screen' ? {...node, ...measureQuad(object)} : node);
	});
	return nodes;
}

// VoiceSceneHandle.project: CSS px in the canvas box; scale is 1 at the mode's reference distance (orbit/focus: the
// cam_home distance, seat: SEAT_VIEW_REFERENCE_M) and grows as the camera nears.
export function projectPoint(
	camera: PerspectiveCamera,
	size: {width: number; height: number},
	referenceDistance: number,
	point: Vec3,
): {x: number; y: number; visible: boolean; scale: number} {
	const world = new Vector3(point.x, point.y, point.z);
	const scale = referenceDistance / Math.max(world.distanceTo(camera.position), 1e-6);
	const view = world.applyMatrix4(camera.matrixWorldInverse);
	const inFront = view.z < -camera.near;
	const ndc = view.applyMatrix4(camera.projectionMatrix);
	return {
		x: ((ndc.x + 1) / 2) * size.width,
		y: ((1 - ndc.y) / 2) * size.height,
		visible: inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1,
		scale,
	};
}

async function buildRoomBoundsTrees(root: Object3D, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const geometries = new Set<BufferGeometry>();
	root.traverse((object) => {
		if (object instanceof Mesh) geometries.add(object.geometry);
	});
	// Use the official worker entry directly: WorkerBase.generate drops a rejecting finally promise and its
	// dispose leaves generate pending. This room owns one worker and settles errors/abort before terminating it.
	const worker = new Worker(new URL('three-mesh-bvh/src/workers/generateMeshBVH.worker.js', import.meta.url), {
		type: 'module',
	});
	let stopped = false;
	let rejectPending: ((reason?: unknown) => void) | null = null;
	const stop = (): void => {
		if (!stopped) worker.terminate();
		stopped = true;
	};
	const abort = (): void => {
		stop();
		rejectPending?.(signal.reason);
	};
	signal.addEventListener('abort', abort, {once: true});
	try {
		for (const geometry of geometries) {
			signal.throwIfAborted();
			// GLB accessors can share an ArrayBuffer. Transfer owned copies so normals, UVs and other meshes stay intact.
			const source = geometry.getAttribute('position');
			// The official worker treats positions as unnormalized floats; decode KHR_mesh_quantization accessors first.
			const position = source.normalized ? new Float32Array(source.count * 3) : source.clone().array;
			if (source.normalized) {
				for (let i = 0; i < source.count; i++) {
					position[i * 3] = source.getX(i);
					position[i * 3 + 1] = source.getY(i);
					position[i * 3 + 2] = source.getZ(i);
				}
			}
			const index = geometry.index?.clone().array ?? null;
			geometry.boundsTree = await new Promise<MeshBVH>((resolve, reject) => {
				rejectPending = reject;
				worker.onmessage = ({
					data,
				}: MessageEvent<{error?: Error; serialized?: ReturnType<typeof MeshBVH.serialize>}>) => {
					try {
						if (data.error) reject(data.error);
						else if (data.serialized) resolve(MeshBVH.deserialize(data.serialized, geometry, {setIndex: false}));
					} catch (error) {
						reject(error);
					}
				};
				worker.onerror = (event) => {
					event.preventDefault();
					reject(new Error(`Room BVH worker failed: ${event.message}`));
				};
				worker.postMessage(
					{position, index, options: {indirect: true, range: geometry.drawRange, groups: geometry.groups}},
					index ? [position.buffer, index.buffer] : [position.buffer],
				);
			});
			rejectPending = null;
			if (!geometry.boundingBox) geometry.boundingBox = geometry.boundsTree.getBoundingBox(new Box3());
		}
	} finally {
		signal.removeEventListener('abort', abort);
		worker.onmessage = null;
		worker.onerror = null;
		stop();
	}
}

function disposeTree(root: Object3D): void {
	const bitmaps = new Set<ImageBitmap>();
	root.traverse((object) => {
		if (!(object instanceof Mesh)) return;
		disposeBoundsTree.call(object.geometry);
		object.geometry.dispose();
		const materials: Array<Material> = Array.isArray(object.material) ? object.material : [object.material];
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if (!(value instanceof Texture)) continue;
				if (typeof ImageBitmap !== 'undefined' && value.image instanceof ImageBitmap) bitmaps.add(value.image);
				value.dispose();
			}
			material.dispose();
		}
	});
	// GLTFLoader's decoded images own CPU resources that Texture.dispose() does not release.
	for (const bitmap of bitmaps) bitmap.close();
}

export interface VoiceSceneRendererOptions {
	container: HTMLElement;
	// Hashed manifest path only; never a user-supplied URL.
	url: string;
	signal: AbortSignal;
	onContextLost(): void;
}

export interface VoiceSceneRenderer {
	handle: VoiceSceneHandle;
	dispose(): void;
}

export async function createVoiceSceneRenderer({
	container,
	url,
	signal,
	onContextLost,
}: VoiceSceneRendererOptions): Promise<VoiceSceneRenderer> {
	const response = await fetch(url, {signal});
	if (!response.ok) throw new Error(`Room file request failed with ${response.status}`);
	const buffer = await response.arrayBuffer();
	performance.mark('oda-3b:glb');
	const gltf = await new GLTFLoader().parseAsync(buffer, '');
	performance.mark('oda-3b:parse');
	let renderer: WebGLRenderer;
	let layout: VoiceSceneHandle['layout'];
	try {
		layout = parseRoomLayout(collectContractNodes(gltf.scene));
		await buildRoomBoundsTrees(gltf.scene, signal);
		signal.throwIfAborted();
		renderer = new WebGLRenderer({antialias: true, alpha: true});
	} catch (error) {
		disposeTree(gltf.scene);
		throw error;
	}
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = NoToneMapping;
	renderer.setClearColor(0x000000, 0);
	const canvas = renderer.domElement;
	canvas.style.display = 'block';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	container.appendChild(canvas);

	const scene = new Scene();
	scene.add(gltf.scene);
	const {camHome, camTarget} = layout;
	const homeDistance = Math.hypot(camHome.x - camTarget.x, camHome.y - camTarget.y, camHome.z - camTarget.z);
	// The rig sets position, fov and near/far for every mode.
	const camera = new PerspectiveCamera(REFERENCE_FOV_DEG, 16 / 9, 1, homeDistance * 3);
	const hosts = new Map<string, TableGame3DHost>();
	// a double click on a 3D piece is the piece's, not the seat look's.
	const pickedAt = (clientX: number, clientY: number): boolean =>
		[...hosts.values()].some((host) => host.hits(clientX, clientY));
	const rig = createRoomCameraRig({camera, dom: canvas, layout, pickedAt});
	// TV: a DOM layer above the canvas (Fluxer's stream UI, not a video texture), on the quad by homography.
	const screenLayer = createScreenLayer({container, layout, wheelTarget: canvas});
	// Contract rev 4: the wall groups and the ceiling the orbit camera cuts away, by their nodes (a name is a
	// label, and an unnamed node must never stand for the whole room).
	const cutaway = layout.cutaway;
	const nodeOf = (id: string | undefined) => (id ? gltf.scene.getObjectByProperty('uuid', id) : undefined);
	const wallGroups = cutaway?.walls.map((wall) => nodeOf(wall.id)) ?? [];
	const ceilingGroup = cutaway ? nodeOf(cutaway.ceiling.id) : undefined;
	// only in a settled orbit; seated, on the TV and on every way between (seat to seat, back to the room)
	// the whole room shows. Worked out when the camera moves only, before that frame draws (nothing per idle frame).
	const applyCutaway = (): void => {
		if (!cutaway) return;
		const orbiting = rig.mode() === 'orbit' && !rig.tweening();
		const hidden = cutawayHidden(cutaway, camera.position);
		wallGroups.forEach((group, index) => {
			if (group) group.visible = !(orbiting && hidden.walls[index]);
		});
		if (ceilingGroup) ceilingGroup.visible = !(orbiting && hidden.ceiling);
	};
	applyCutaway();

	const tableTops = new Map<string, {mesh: Mesh<PlaneGeometry, MeshBasicMaterial>; texture: CanvasTexture}>();
	// the last 2D face drawn per slot, kept while that slot's 3D table is on and put back when it leaves.
	const tableCanvases = new Map<string, HTMLCanvasElement | null>();
	const tables3D = new Set<string>();
	const viewListeners = new Set<() => void>();
	const modeListeners = new Set<(mode: SceneCameraMode) => void>();
	const size = {width: 0, height: 0};
	let cameraMode = rig.mode();
	const occluder = new Raycaster();
	occluder.firstHitOnly = true;
	let seatName: string | null = null;
	let viewDirty = true;
	let firstFrameDrawn = false;

	const loop = createRenderLoop({
		canvas,
		onContextLost,
		draw() {
			const busy = rig.update(performance.now());
			for (const host of hosts.values()) host.beforeDraw();
			renderer.render(scene, camera);
			screenLayer.update(camera, size, rig.mode() === 'seat');
			if (!firstFrameDrawn) {
				firstFrameDrawn = true;
				performance.mark('oda-3b:first-frame');
			}
			if (viewDirty) {
				viewDirty = false;
				for (const listener of viewListeners) listener();
			}
			// frames only while the camera moves or a table animates. Every host is asked every frame (no short
			// circuit): asking steps its animation, so a camera move must not pause it.
			const animating = [...hosts.values()].map((host) => host.animating());
			return busy || animating.some(Boolean);
		},
	});
	const markViewChanged = (): void => {
		viewDirty = true;
		loop.requestRender();
	};
	const offRigChange = rig.onChange(() => {
		applyCutaway();
		markViewChanged();
		const mode = rig.mode();
		if (mode === cameraMode) return;
		cameraMode = mode;
		screenLayer.setInteractive(mode !== 'seat');
		for (const listener of modeListeners) listener(mode);
	});

	const resize = (width: number, height: number): void => {
		if (width <= 0 || height <= 0 || (width === size.width && height === size.height)) return;
		size.width = width;
		size.height = height;
		renderer.setSize(width, height, false);
		rig.setAspect(width / height);
		markViewChanged();
	};
	const resizeObserver = new ResizeObserver((entries) => {
		const box = entries[0]?.contentRect;
		if (box) resize(box.width, box.height);
	});
	resizeObserver.observe(container);
	resize(container.clientWidth, container.clientHeight);

	const removeTableTop = (slot: string): void => {
		const top = tableTops.get(slot);
		if (!top) return;
		scene.remove(top.mesh);
		top.mesh.geometry.dispose();
		top.mesh.material.dispose();
		top.texture.dispose();
		tableTops.delete(slot);
	};
	const drawTableTop = (slot: string, tableCanvas: HTMLCanvasElement | null): void => {
		const current = tableTops.get(slot);
		if (current && tableCanvas && current.texture.image === tableCanvas) {
			current.texture.needsUpdate = true;
			return;
		}
		removeTableTop(slot);
		const table = layout.tables.find((entry) => entry.slot === slot);
		if (!tableCanvas || !table) return;
		const texture = new CanvasTexture(tableCanvas);
		texture.colorSpace = SRGBColorSpace;
		texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
		const mesh = new Mesh(
			new PlaneGeometry(table.topSize, table.topSize),
			new MeshBasicMaterial({map: texture, transparent: true}),
		);
		// Canvas bottom edge → +Z (south, seat 1), right edge → +X (seat 2), as drawTableTop lays it out.
		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(table.center.x, table.center.y + TABLE_TOP_LIFT_M, table.center.z);
		scene.add(mesh);
		tableTops.set(slot, {mesh, texture});
	};

	const handle: VoiceSceneHandle = {
		layout,
		project(point) {
			const projected = projectPoint(camera, size, rig.mode() === 'seat' ? SEAT_VIEW_REFERENCE_M : homeDistance, point);
			// seated, a narrowed view enlarges the avatars, labels and camera tiles with the room.
			return {...projected, scale: projected.scale * rig.zoomScale()};
		},
		onViewChange(listener) {
			viewListeners.add(listener);
			return () => viewListeners.delete(listener);
		},
		getCameraAzimuth: () => rig.azimuthFromHome(),
		requestRender: () => loop.requestRender(),
		setTableTop(slot, tableCanvas) {
			tableCanvases.set(slot, tableCanvas);
			// a slot with its 3D table on shows no 2D face; the last one comes back when the table leaves.
			if (!tables3D.has(slot)) drawTableTop(slot, tableCanvas);
			loop.requestRender();
		},
		attachScreenElement(element) {
			screenLayer.attach(element);
			loop.requestRender();
		},
		screenInView: () => layout.screen !== null && screenInView(layout.screen, camera.position, rig.mode() === 'seat'),
		wheel: (event) => canvas.dispatchEvent(new WheelEvent('wheel', event)),
		// ponytail (TEMPORARY): per-geometry BVHs are built once in a room-owned worker and reused across cut-away.
		// KW-PERF-bvh: at 4× CPU, max total/slice is 2.3 ms and max ray is 0.5 ms across the three rooms.
		// The visible mesh set is still traversed per rest check; VoiceSceneAnchors keeps its ≤ 6 ms slices.
		// At 8× CPU, total > 100 ms or one ray > 16 ms triggers a room visibility cache / worker ray batches.
		occluder() {
			const meshes: Array<Mesh> = [];
			const hits: Array<Intersection> = [];
			gltf.scene.traverseVisible((object) => {
				if (object instanceof Mesh) meshes.push(object);
			});
			return (point) => {
				const towards = new Vector3(point.x, point.y, point.z).sub(camera.position);
				const reach = towards.length() - OCCLUSION_MARGIN_M;
				if (!(reach > 0)) return false;
				occluder.set(camera.position, towards.normalize());
				occluder.far = reach;
				for (const mesh of meshes) {
					if (!mesh.layers.test(occluder.layers)) continue;
					hits.length = 0;
					acceleratedRaycast.call(mesh, occluder, hits);
					if (hits.length > 0) return true;
				}
				return false;
			};
		},
		getCameraMode: () => rig.mode(),
		onCameraModeChange(listener) {
			modeListeners.add(listener);
			return () => modeListeners.delete(listener);
		},
		focusScreen() {
			rig.focusScreen();
			loop.requestRender();
		},
		enterSeatView(target) {
			// the same seat posed again (a resize, its game changing) keeps the look the viewer turned to.
			const keepLook = rig.mode() === 'seat' && seatName === target.seat.name;
			seatName = target.seat.name;
			rig.enterSeat(
				seatedPose({layout, seat: target.seat, slot: target.slot, game: target.game, aspect: camera.aspect}),
				keepLook,
			);
			loop.requestRender();
		},
		exitToOrbit() {
			rig.exitToOrbit();
			loop.requestRender();
		},
		mountTableGame(slot, game) {
			hosts.get(slot)?.dispose();
			if (!tableModelFor(game)) return null;
			const host = mountTableGame3D({
				parent: scene,
				camera,
				dom: canvas,
				layout,
				slot,
				game,
				factoryFor: tableModelFor,
				requestRender: () => loop.requestRender(),
				onModelMounted(mounted) {
					if (mounted) {
						tables3D.add(slot);
						removeTableTop(slot);
					} else {
						tables3D.delete(slot);
						drawTableTop(slot, tableCanvases.get(slot) ?? null);
					}
				},
			});
			if (!host) return null;
			const disposeHost = host.dispose;
			host.dispose = () => {
				if (hosts.get(slot) === host) hosts.delete(slot);
				disposeHost();
			};
			hosts.set(slot, host);
			return host;
		},
	};
	loop.requestRender();

	return {
		handle,
		dispose() {
			loop.dispose();
			resizeObserver.disconnect();
			for (const host of [...hosts.values()]) host.dispose();
			releaseTableParts();
			offRigChange();
			rig.dispose();
			viewListeners.clear();
			modeListeners.clear();
			screenLayer.dispose();
			for (const slot of [...tableTops.keys()]) removeTableTop(slot);
			disposeTree(gltf.scene);
			renderer.dispose();
			renderer.forceContextLoss();
			canvas.remove();
		},
	};
}
