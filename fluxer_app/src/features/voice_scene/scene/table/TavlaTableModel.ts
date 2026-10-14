// SPDX-License-Identifier: AGPL-3.0-or-later

import {DiceAnimation} from '@app/features/voice_scene/scene/table/DiceAnimation';
import type {TableGame3DModelFactory, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {
	BAR_BLACK,
	BAR_WHITE,
	planTavlaReplay,
	sampleTavlaReplay,
	type TavlaBoardSource,
	type TavlaLayout,
	type TavlaRect,
	type TavlaReplay,
	tavlaBoardGeometry,
	tavlaBoardYaw,
	tavlaDiceRest,
	tavlaLayout,
	tavlaStacks,
} from '@app/features/voice_scene/scene/table/tavlaLayout';
import type {TableDropTarget, TableScene3DInput, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_SIZE_M} from '@app/features/voice_scene/utils/SeatedView';
import {TAVLA_CHECKERS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	Box3,
	type BufferAttribute,
	type BufferGeometry,
	CanvasTexture,
	Color,
	Group,
	InstancedMesh,
	type Material,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Quaternion,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	Vector3,
} from 'three';

// Unlit: the parts' baked grey light times these colours; no lights, no shadows. both
// stand off the board's wood field ≥ 2.5:1 (the test has the parts file's numbers).
export const TAVLA_CHECKER_COLORS = {white: new Color(0xfffdf8), black: new Color(0x2a1a12)} as const;
const WHITE = TAVLA_CHECKER_COLORS.white;
const BLACK = TAVLA_CHECKER_COLORS.black;
const TARGET = new Color(0xffd54a);
const SELECTED = new Color(0x7fd4ff);
const GHOST_OPACITY = 0.45;
const BADGE_SIZE_M = 0.026;
const MAX_GHOSTS = 8; // ≤ 4 steps a turn, each may hit a blot
const MAX_BADGES = 6; // ≤ 2 overfull points a side, and both bars
const MAX_HIGHLIGHTS = 26; // 24 points, the off tray, the selection
const IDENTITY = new Quaternion();
const STANDING = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
const ONE = new Vector3(1, 1, 1);

function meshesOf(parts: TableParts, name: string): Array<Mesh> {
	const meshes: Array<Mesh> = [];
	parts.node(name)?.traverse((object) => {
		if (object instanceof Mesh) meshes.push(object);
	});
	if (meshes.length === 0) throw new Error(`Table parts GLB contract: ${name} has no mesh`);
	return meshes;
}

const boundsOf = (geometry: BufferGeometry) =>
	new Box3().setFromBufferAttribute(geometry.getAttribute('position') as BufferAttribute);

// a part scaled from its bounding box to `size` (largest horizontal extent, or largest of all), pivot
// moved to its base centre or its centre.
function fitMatrix(box: Box3, size: number, extent: 'horizontal' | 'all', pivot: 'base' | 'centre'): Matrix4 {
	const dims = box.getSize(new Vector3());
	const scale = size / (extent === 'horizontal' ? Math.max(dims.x, dims.z) : Math.max(dims.x, dims.y, dims.z));
	const centre = box.getCenter(new Vector3());
	if (pivot === 'base') centre.y = box.min.y;
	return new Matrix4().makeScale(scale, scale, scale).multiply(new Matrix4().makeTranslation(centre.negate()));
}

function boardSource(parts: TableParts, board: Mesh, checker: Box3): TavlaBoardSource {
	const empty = (name: string): Vec3 => {
		const node = parts.node(name);
		if (!node) throw new Error(`Table parts GLB contract: ${name} missing`);
		return {x: node.position.x, y: node.position.y, z: node.position.z};
	};
	const box = boundsOf(board.geometry);
	const size = checker.getSize(new Vector3());
	return {
		boardMin: box.min,
		boardMax: box.max,
		points: Array.from({length: 24}, (_, index) => empty(`tp_${String(index + 1).padStart(2, '0')}`)),
		bar: {white: empty('tp_bar_w'), black: empty('tp_bar_b')},
		off: {white: empty('tp_off_w'), black: empty('tp_off_b')},
		checker: {diameter: Math.max(size.x, size.z), height: size.y},
	};
}

const sameTarget = (a: TableDropTarget, b: TableDropTarget) =>
	a.kind === 'tavla_off'
		? b.kind === 'tavla_off'
		: a.kind === 'tavla_point' && b.kind === 'tavla_point' && a.point === b.point;

function drawBadge(count: number): SpriteMaterial {
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const context = canvas.getContext('2d');
	if (context) {
		context.fillStyle = 'rgba(24, 18, 14, 0.85)';
		context.beginPath();
		context.arc(32, 32, 30, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = '#ffffff';
		context.font = 'bold 34px sans-serif';
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(String(count), 32, 34);
	}
	const map = new CanvasTexture(canvas);
	map.colorSpace = SRGBColorSpace;
	return new SpriteMaterial({map, depthWrite: false});
}

// The tavla board in root-local space; root itself belongs to the host. White's edge is the board
// group's +Z; the group turns so my edge faces root +Z.
export const createTavlaTableModel: TableGame3DModelFactory = ({parts}) => {
	const root = new Group();
	const turned = new Group();
	turned.name = 'tavla-board-yaw';
	root.add(turned);

	const [boardPart] = meshesOf(parts, 'tavla_board');
	const [checkerPart] = meshesOf(parts, 'tavla_checker');
	const dieParts = meshesOf(parts, 'tavla_die'); // body + pips
	const checkerBox = boundsOf(checkerPart!.geometry);
	const g = tavlaBoardGeometry(boardSource(parts, boardPart!, checkerBox));
	const checkerFit = fitMatrix(checkerBox, g.checker.diameter, 'horizontal', 'base');
	const dieFit = fitMatrix(boundsOf(dieParts[0]!.geometry), SEAT_PIECE_SIZE_M.tavlaDie, 'all', 'centre');

	const board = new Mesh(boardPart!.geometry, boardPart!.material);
	board.name = 'tavla-board';
	board.userData.kind = 'board';
	board.scale.setScalar(g.scale);
	board.position.set(-g.origin.x * g.scale, -g.origin.y * g.scale, -g.origin.z * g.scale);
	turned.add(board);

	// Everything below is this model's own; the parts' geometries and materials are shared and never disposed.
	const checkerMaterial = checkerPart!.material as MeshBasicMaterial;
	const ghostMaterial = checkerMaterial.clone();
	ghostMaterial.transparent = true;
	ghostMaterial.opacity = GHOST_OPACITY;
	ghostMaterial.depthWrite = false;
	const tinted = (color: Color) => {
		const material = checkerMaterial.clone();
		material.color.copy(color);
		return material;
	};
	const proxyMaterials = {white: tinted(WHITE), black: tinted(BLACK)};
	const flat = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
	const highlightMaterial = new MeshBasicMaterial({transparent: true, opacity: 0.35, depthWrite: false});
	const zoneMaterial = new MeshBasicMaterial({visible: false});
	const blankBadge = new SpriteMaterial();
	const badgeMaterials = new Map<number, SpriteMaterial>();

	const instanced = (geometry: BufferGeometry, material: Material, capacity: number, kind: string) => {
		const mesh = new InstancedMesh(geometry, material, capacity);
		mesh.userData.kind = kind;
		mesh.frustumCulled = false; // instances move; a stale bounding sphere would cull them
		mesh.count = 0;
		mesh.visible = false;
		turned.add(mesh);
		return mesh;
	};
	// ≤ 2 draw calls per kind — all checkers in one InstancedMesh (+ one for ghosts), dice body + pips.
	const solids = instanced(checkerPart!.geometry, checkerMaterial, TAVLA_CHECKERS * 2, 'checkers');
	const ghosts = instanced(checkerPart!.geometry, ghostMaterial, MAX_GHOSTS, 'checkers');
	ghosts.userData.ghost = true;
	const dice = dieParts.map((part) => instanced(part.geometry, part.material as Material, 2, 'dice'));
	const highlights = instanced(flat, highlightMaterial, MAX_HIGHLIGHTS, 'highlights');

	const zones = Array.from({length: 25}, () => {
		const zone = new Mesh(flat, zoneMaterial);
		turned.add(zone);
		return zone;
	});
	// one proxy per point and bar, the visible copy of its top checker the host carries while
	// dragging; then that checker's instance is left out. At rest the proxy is hidden (no draw call); a press
	// anywhere on the point's area picks it up.
	const proxies = Array.from({length: BAR_BLACK + 1}, () => {
		const proxy = new Group();
		proxy.visible = false;
		proxy.userData.rest = new Vector3();
		const piece = new Mesh(checkerPart!.geometry, proxyMaterials.white);
		piece.matrixAutoUpdate = false;
		piece.matrix.copy(checkerFit);
		const area = new Mesh(flat, zoneMaterial);
		proxy.add(piece, area);
		turned.add(proxy);
		return {proxy, piece, area, active: false};
	});
	const carried = (spot: number) => {
		const proxy = proxies[spot]?.proxy;
		return proxy !== undefined && !proxy.position.equals(proxy.userData.rest);
	};
	const badges = Array.from({length: MAX_BADGES}, () => {
		const badge = new Sprite(blankBadge);
		badge.visible = false;
		badge.scale.setScalar(BADGE_SIZE_M);
		turned.add(badge);
		return badge;
	});

	let input: TableScene3DInput | null = null;
	let prevView: TableGameView | null = null;
	let stacks = tavlaStacks(null, []);
	let viewerWhite = true;
	let moverWhite = true;
	let replay: {plan: TavlaReplay; startMs: number} | null = null;
	let moving = false;
	const diceAnimation = new DiceAnimation();
	const matrix = new Matrix4();
	const at = new Vector3();
	const size = new Vector3();

	const finish = (mesh: InstancedMesh, count: number) => {
		mesh.count = count;
		mesh.visible = count > 0;
		mesh.instanceMatrix.needsUpdate = true;
		if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
	};

	const drawCheckers = (layout: TavlaLayout) => {
		const counts = {solid: 0, ghost: 0};
		for (const checker of layout.checkers) {
			if (checker.top && carried(checker.spot)) continue; // the host carries it: its proxy draws it
			const mesh = checker.ghost ? ghosts : solids;
			const index = checker.ghost ? counts.ghost++ : counts.solid++;
			const {x, y, z} = checker.position;
			matrix.compose(at.set(x, y, z), checker.standing ? STANDING : IDENTITY, ONE).multiply(checkerFit);
			mesh.setMatrixAt(index, matrix);
			mesh.setColorAt(index, checker.white ? WHITE : BLACK);
		}
		finish(solids, counts.solid);
		finish(ghosts, counts.ghost);
	};

	const drawPickables = (layout: TavlaLayout) => {
		for (const entry of proxies) entry.active = false;
		for (const pickable of layout.pickables) {
			const entry = proxies[pickable.spot]!;
			entry.active = true;
			entry.proxy.userData.source = pickable.source;
			if (!entry.proxy.position.equals(entry.proxy.userData.rest)) continue; // the host is carrying it
			const {x, y, z} = pickable.position;
			entry.proxy.position.set(x, y, z);
			entry.proxy.userData.rest.set(x, y, z);
			entry.proxy.visible = false;
			entry.piece.material = pickable.white ? proxyMaterials.white : proxyMaterials.black;
			const {center, width, depth} = pickable.area;
			entry.area.position.set(center.x - x, center.y - y, center.z - z);
			entry.area.scale.set(width, 1, depth);
		}
	};

	const drawBadges = (layout: TavlaLayout) => {
		badges.forEach((badge, index) => {
			const entry = layout.badges[index];
			badge.visible = entry !== undefined;
			if (!entry) return;
			let material = badgeMaterials.get(entry.count);
			if (!material) {
				material = drawBadge(entry.count);
				badgeMaterials.set(entry.count, material);
			}
			badge.material = material;
			badge.position.set(entry.position.x, entry.position.y, entry.position.z);
		});
	};

	const drawZonesAndHighlights = (layout: TavlaLayout) => {
		layout.zones.forEach((rect, index) => {
			const zone = zones[index]!;
			zone.userData.target = rect.target;
			zone.position.set(rect.center.x, rect.center.y, rect.center.z);
			zone.scale.set(rect.width, 1, rect.depth);
		});
		const lit: Array<{rect: TavlaRect; color: Color}> = [];
		for (const target of input?.targets ?? []) {
			const rect = layout.zones.find((zone) => sameTarget(zone.target, target));
			if (rect) lit.push({rect, color: TARGET});
		}
		const selection = input?.selection;
		if (selection?.kind === 'tavla_point') {
			const spot = selection.point === 'bar' ? (viewerWhite ? BAR_WHITE : BAR_BLACK) : selection.point - 1;
			const picked = layout.pickables.find((pickable) => pickable.spot === spot);
			if (picked) lit.push({rect: picked.area, color: SELECTED});
		}
		lit.forEach(({rect, color}, index) => {
			matrix.compose(
				at.set(rect.center.x, rect.center.y, rect.center.z),
				IDENTITY,
				size.set(rect.width, 1, rect.depth),
			);
			highlights.setMatrixAt(index, matrix);
			highlights.setColorAt(index, color);
		});
		finish(highlights, lit.length);
	};

	const drawDice = (nowMs: number) => {
		const rest = tavlaDiceRest(g, moverWhite);
		let count = 0;
		for (const index of [0, 1] as const) {
			const pose = diceAnimation.pose(index, nowMs);
			if (!pose) break;
			const spot = rest[index];
			matrix
				.compose(at.set(spot.x + pose.offset.x, spot.y + pose.offset.y, spot.z + pose.offset.z), pose.quaternion, ONE)
				.multiply(dieFit);
			for (const mesh of dice) mesh.setMatrixAt(index, matrix);
			count = index + 1;
		}
		for (const mesh of dice) finish(mesh, count);
	};

	const draw = (nowMs: number) => {
		const frame = replay ? sampleTavlaReplay(replay.plan, nowMs - replay.startMs) : null;
		if (!frame) replay = null;
		const layout = tavlaLayout(g, frame?.stacks ?? stacks, viewerWhite, frame?.moving);
		drawCheckers(layout);
		drawPickables(layout);
		drawBadges(layout);
		drawZonesAndHighlights(layout);
		drawDice(nowMs);
	};

	return {
		root,
		update(next) {
			const nowMs = performance.now();
			const view = next.view;
			const tavla = view.game_view?.game === 'tavla' ? view.game_view : null;
			const before = prevView?.game_view?.game === 'tavla' ? prevView.game_view : null;
			turned.rotation.y = tavlaBoardYaw(tavla?.white ?? null, next.perspective);
			viewerWhite = tavla ? (view.viewer_position ?? next.perspective) === tavla.white : true;
			if (tavla?.turn) moverWhite = tavla.turn === tavla.white;
			diceAnimation.update(prevView, view, nowMs);
			if (prevView !== null && view.summary.version !== prevView.summary.version) {
				// Someone else's turn landed: replay its steps (mine were on the board as ghosts already).
				const plan =
					tavla &&
					before &&
					before.turn !== view.viewer_position &&
					JSON.stringify(tavla.last_moves) !== JSON.stringify(before.last_moves)
						? planTavlaReplay(g, before, tavla)
						: null;
				replay = plan ? {plan, startMs: nowMs} : null;
			}
			stacks = tavlaStacks(tavla, next.pendingTavla);
			input = next;
			prevView = view;
			moving = diceAnimation.running(nowMs) || replay !== null;
			draw(nowMs);
		},
		pickables: () => proxies.filter((entry) => entry.active).map((entry) => entry.proxy),
		dropZones: () => zones,
		// The draw loop asks once per drawn frame, after drawing: this is the model's frame tick (a change made here
		// shows in the next frame). A tick that changed something — the settled pose at an animation's end, a proxy
		// picked up or put back — answers true once more so that frame gets drawn; after that, 0 frames.
		animating() {
			let lifted = false;
			for (const {proxy} of proxies) {
				const off = !proxy.position.equals(proxy.userData.rest);
				if (off !== proxy.visible) {
					proxy.visible = off;
					lifted = true;
				}
			}
			if (!moving && !lifted) return false;
			const nowMs = performance.now();
			draw(nowMs);
			moving = diceAnimation.running(nowMs) || replay !== null;
			return true;
		},
		dispose() {
			for (const mesh of [solids, ghosts, ...dice, highlights]) mesh.dispose();
			// The clones share the parts' textures: only the materials go, the textures stay.
			for (const material of [
				ghostMaterial,
				proxyMaterials.white,
				proxyMaterials.black,
				highlightMaterial,
				zoneMaterial,
			])
				material.dispose();
			blankBadge.dispose();
			for (const material of badgeMaterials.values()) {
				material.map?.dispose();
				material.dispose();
			}
			flat.dispose();
			root.clear();
		},
	};
};
