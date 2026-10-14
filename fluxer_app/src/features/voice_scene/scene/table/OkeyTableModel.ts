// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createOkeyTileAtlas,
	OKEY_ATLAS_COLUMNS,
	OKEY_ATLAS_ROWS,
	okeyCellOffset,
} from '@app/features/voice_scene/scene/table/OkeyTileAtlas';
import {
	type OkeyTilePlacement,
	type OkeyTileSize,
	type OkeyZonePlacement,
	okeyTableLayout,
} from '@app/features/voice_scene/scene/table/okeyTableLayout';
import type {TableGame3DModelFactory} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {TableDragSource, TableDropTarget} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_PIECE_SIZE_M} from '@app/features/voice_scene/utils/SeatedView';
import {
	BoxGeometry,
	type BufferGeometry,
	Color,
	Euler,
	Group,
	InstancedBufferAttribute,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Quaternion,
	Vector3,
} from 'three';

// Every okey/101 tile on the table: two instanced draws (faces + bodies) whatever the state.
const TILE_CAPACITY = 106;
const RACKS = 4;
const TARGET_CAPACITY = 128;
// A selected (or dragged) tile floats this far up its own axis.
const SELECT_LIFT_M = 0.012;
const WHITE = new Color(1, 1, 1);
// The real okey wears a gold body, like the 2D tile's gold ring; staged 101 tiles are cool ghosts.
const WILD_BODY = new Color('#f0c24a');
const GHOST = new Color('#9cc3ff');

const keyOfSource = (source: TableDragSource): string =>
	source.kind === 'rack_tile'
		? `r:${source.tile}`
		: source.kind === 'discard_top'
			? `d:${source.position}`
			: source.kind;
const keyOfTarget = (target: TableDropTarget): string =>
	target.kind === 'rack_cell'
		? `c:${target.cell}`
		: target.kind === 'meld_end'
			? `m:${target.meldId}:${target.at}`
			: target.kind;

function boxOf(geometry: BufferGeometry) {
	if (!geometry.boundingBox) geometry.computeBoundingBox();
	return geometry.boundingBox!;
}

// The atlas cell of each instance reaches the face shader as a per-instance UV offset (one material, one draw).
function faceMaterial(map: MeshBasicMaterial['map']): MeshBasicMaterial {
	const material = new MeshBasicMaterial({map});
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec2 okeyCell;')
			.replace(
				'#include <uv_vertex>',
				`#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = vMapUv * vec2(${1 / OKEY_ATLAS_COLUMNS}, ${1 / OKEY_ATLAS_ROWS}) + okeyCell;\n#endif`,
			);
	};
	material.customProgramCacheKey = () => 'micup-okey-face-atlas';
	return material;
}

export const createOkeyTableModel: TableGame3DModelFactory = ({parts, table}) => {
	const root = new Group();
	const faceGeometry = parts.geometry('okey_face');
	const bodyGeometry = parts.geometry('okey_body');
	const bodyMaterial = parts.material('okey_body');

	// the GLB tile is normalised so its face is SEAT_PIECE_SIZE_M.okeyFace tall; the rack scales with it.
	const faceBox = boxOf(faceGeometry);
	const bodyBox = boxOf(bodyGeometry);
	const scale = SEAT_PIECE_SIZE_M.okeyFace / (faceBox.max.y - faceBox.min.y);
	const tile: OkeyTileSize = {
		width: (bodyBox.max.x - bodyBox.min.x) * scale,
		height: SEAT_PIECE_SIZE_M.okeyFace,
		thickness: (bodyBox.max.z - bodyBox.min.z) * scale,
		zMin: bodyBox.min.z * scale,
		zMax: bodyBox.max.z * scale,
	};

	const atlas = createOkeyTileAtlas();
	const instancedFace = faceGeometry.clone();
	const cells = new InstancedBufferAttribute(new Float32Array(TILE_CAPACITY * 2), 2);
	instancedFace.setAttribute('okeyCell', cells);
	const tileFaceMaterial = faceMaterial(atlas);
	const faces = new InstancedMesh(instancedFace, tileFaceMaterial, TILE_CAPACITY);
	const bodies = new InstancedMesh(bodyGeometry, bodyMaterial, TILE_CAPACITY);
	faces.name = 'okey_face';
	bodies.name = 'okey_body';
	const racks = new InstancedMesh(parts.geometry('okey_rack'), parts.material('wood'), RACKS);
	racks.name = 'okey_rack';
	const plane = new PlaneGeometry(1, 1);
	const highlightMaterial = new MeshBasicMaterial({
		color: '#ffd25a',
		transparent: true,
		opacity: 0.4,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
	});
	const highlights = new InstancedMesh(plane, highlightMaterial, TARGET_CAPACITY);
	highlights.name = 'okey_targets';
	for (const mesh of [faces, bodies, racks, highlights]) {
		// The instances move every update; one table never needs culling.
		mesh.frustumCulled = false;
		mesh.count = 0;
		root.add(mesh);
	}
	for (let index = 0; index < TILE_CAPACITY; index++) {
		faces.setColorAt(index, WHITE);
		bodies.setColorAt(index, WHITE);
	}

	// Picking: an invisible box per draggable tile. The one the host drags (or, failing that, the selected
	// one) carries a visible stand-in while its instanced copy is left out, so a real-looking tile follows the pointer.
	const hidden = new MeshBasicMaterial({visible: false});
	const hitBox = new BoxGeometry(tile.width * 1.05, tile.height * 1.05, Math.max(tile.thickness, 0.02)).translate(
		0,
		tile.height / 2,
		(tile.zMin + tile.zMax) / 2,
	);
	let placed: ReadonlyArray<OkeyTilePlacement> = [];
	let selected: string | null = null;
	// The host moves a pickable between updates; the renderer refreshes world matrices before every draw, so that is
	// where a move is seen and the stand-in swapped in for the same frame.
	class TilePickable extends Group {
		readonly home = new Vector3();
		placement: OkeyTilePlacement | null = null;
		moved = false;
		override updateMatrixWorld(force?: boolean): void {
			const moved = !this.position.equals(this.home);
			if (moved !== this.moved) {
				this.moved = moved;
				carry();
			}
			super.updateMatrixWorld(force);
		}
	}
	const pickables = new Map<string, TilePickable>();
	const spare: Array<TilePickable> = [];
	const proxyMap = atlas.clone();
	proxyMap.repeat.set(1 / OKEY_ATLAS_COLUMNS, 1 / OKEY_ATLAS_ROWS);
	// The stand-in draws in the last pass, after the target highlights; while dragged it skips the depth test, so my
	// rack's front never hides the tile under the pointer.
	const proxyFaceMaterial = new MeshBasicMaterial({map: proxyMap, transparent: true});
	const proxyBodyMaterial = bodyMaterial.clone() as MeshBasicMaterial;
	proxyBodyMaterial.transparent = true;
	const proxyFace = new Mesh(faceGeometry, proxyFaceMaterial);
	const proxyBody = new Mesh(bodyGeometry, proxyBodyMaterial);
	proxyBody.renderOrder = 1;
	proxyFace.renderOrder = 2;
	const proxy = new Group();
	proxy.add(proxyFace, proxyBody);
	proxy.scale.setScalar(scale);
	proxy.position.y = SELECT_LIFT_M;

	const zonePool: Array<Mesh> = [];
	let zones: Array<Mesh> = [];
	// My rack cells face me (+Z): this moves a cell's plane from the tile's face to its middle.
	const behindFace = new Matrix4().makeTranslation(0, 0, (tile.zMin - tile.zMax) / 2);

	const matrix = new Matrix4();
	const quaternion = new Quaternion();
	const euler = new Euler(0, 0, 0, 'YXZ');
	const position = new Vector3();
	const size = new Vector3();
	const poseQuaternion = (yaw: number, pitch: number) => quaternion.setFromEuler(euler.set(pitch, yaw, 0, 'YXZ'));

	const writeTile = (index: number, placement: OkeyTilePlacement): void => {
		matrix.compose(
			position.set(placement.x, placement.y, placement.z),
			poseQuaternion(placement.yaw, placement.pitch),
			size.setScalar(scale),
		);
		faces.setMatrixAt(index, matrix);
		bodies.setMatrixAt(index, matrix);
		const offset = okeyCellOffset(placement.cell);
		cells.setXY(index, offset.u, offset.v);
		faces.setColorAt(index, placement.tint === 'ghost' ? GHOST : WHITE);
		bodies.setColorAt(index, placement.tint === 'ghost' ? GHOST : placement.tint === 'wild' ? WILD_BODY : WHITE);
	};

	const pickableFor = (key: string, placement: OkeyTilePlacement, source: TableDragSource): void => {
		let group = pickables.get(key);
		if (!group) {
			group = spare.pop() ?? new TilePickable().add(new Mesh(hitBox, hidden));
			pickables.set(key, group);
			root.add(group);
		}
		group.placement = placement;
		group.home.set(placement.x, placement.y, placement.z);
		group.position.copy(group.home);
		group.moved = false;
		group.quaternion.copy(poseQuaternion(placement.yaw, placement.pitch));
		group.userData.source = source;
	};

	// Every tile but the carried one into the two instanced meshes; the stand-in into the carrier.
	const carry = (): void => {
		const carrier =
			[...pickables.values()].find((group) => group.moved) ?? (selected ? (pickables.get(selected) ?? null) : null);
		let count = 0;
		for (const placement of placed) {
			if (carrier && placement === carrier.placement) continue;
			if (count < TILE_CAPACITY) writeTile(count++, placement);
		}
		faces.count = count;
		bodies.count = count;
		for (const attribute of [
			faces.instanceMatrix,
			bodies.instanceMatrix,
			faces.instanceColor,
			bodies.instanceColor,
			cells,
		])
			if (attribute) attribute.needsUpdate = true;
		proxy.removeFromParent();
		const carried = carrier?.placement;
		if (!carrier || !carried) return;
		const offset = okeyCellOffset(carried.cell);
		proxyMap.offset.set(offset.u, offset.v);
		proxyFaceMaterial.color.copy(carried.tint === 'ghost' ? GHOST : WHITE);
		proxyBodyMaterial.color.copy(carried.tint === 'wild' ? WILD_BODY : WHITE);
		proxyFaceMaterial.depthTest = !carrier.moved;
		proxyBodyMaterial.depthTest = !carrier.moved;
		carrier.add(proxy);
	};

	const placeZones = (placements: ReadonlyArray<OkeyZonePlacement>): void => {
		for (const mesh of zones) root.remove(mesh);
		zones = placements.map((placement, index) => {
			const mesh = zonePool[index] ?? (zonePool[index] = new Mesh(plane, hidden));
			mesh.position.set(placement.x, placement.y, placement.z);
			mesh.quaternion.copy(poseQuaternion(placement.yaw, placement.pitch));
			mesh.scale.set(placement.width, placement.height, 1);
			mesh.updateMatrix();
			mesh.userData.target = placement.target;
			root.add(mesh);
			return mesh;
		});
	};

	return {
		root,
		update(input) {
			const layout = okeyTableLayout({
				view: input.view,
				perspective: input.perspective,
				rack: input.rack,
				stage: input.stage,
				topSize: table.topSize,
				tile,
			});
			selected = input.selection ? keyOfSource(input.selection) : null;
			placed = layout.tiles;

			layout.racks.forEach((rack, index) => {
				matrix.compose(position.set(rack.x, 0, rack.z), poseQuaternion(rack.yaw, 0), size.setScalar(scale));
				racks.setMatrixAt(index, matrix);
			});
			racks.count = layout.racks.length;
			racks.instanceMatrix.needsUpdate = true;

			// Pickables of tiles that left go spare first, so a new draggable tile reuses one.
			const live = new Set(
				layout.tiles.flatMap((placement) => (placement.source ? [keyOfSource(placement.source)] : [])),
			);
			for (const [key, group] of pickables) {
				if (live.has(key)) continue;
				pickables.delete(key);
				root.remove(group);
				spare.push(group);
			}
			for (const placement of layout.tiles)
				if (placement.source) pickableFor(keyOfSource(placement.source), placement, placement.source);
			carry();

			placeZones(layout.zones);
			const lit = new Set(input.targets.map(keyOfTarget));
			let shown = 0;
			for (const mesh of zones) {
				const target = mesh.userData.target as TableDropTarget;
				if (shown >= TARGET_CAPACITY || !lit.has(keyOfTarget(target))) continue;
				// A lit rack cell glows through its tile's middle: round an empty slot, never over a digit.
				highlights.setMatrixAt(
					shown++,
					target.kind === 'rack_cell' ? matrix.multiplyMatrices(behindFace, mesh.matrix) : mesh.matrix,
				);
			}
			highlights.count = shown;
			highlights.instanceMatrix.needsUpdate = true;
		},
		pickables: () => [...pickables.values()],
		dropZones: () => zones,
		// No tile animation: a new view lands at once, so the table draws only on change.
		animating: () => false,
		dispose() {
			root.removeFromParent();
			for (const mesh of [faces, bodies, racks, highlights]) mesh.dispose();
			for (const disposable of [
				instancedFace,
				plane,
				hitBox,
				atlas,
				proxyMap,
				tileFaceMaterial,
				proxyFaceMaterial,
				proxyBodyMaterial,
				hidden,
				highlightMaterial,
			])
				disposable.dispose();
		},
	};
};
