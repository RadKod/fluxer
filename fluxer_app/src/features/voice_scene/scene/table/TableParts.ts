// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {TablePartName, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {VOICE_ROOM_PARTS_MANIFEST} from '@fluxer/constants/src/VoiceRoomPartsManifest';
import {type BufferGeometry, type Material, Mesh, type Object3D} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const logger = new Logger('TableParts');

// GLB contract rev 3: the names a 3D table model may ask for.
export const TABLE_PART_NAMES: ReadonlyArray<TablePartName> = [
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
];

export class TablePartsContractError extends Error {
	constructor(message: string) {
		super(`Table parts GLB contract: ${message}`);
		this.name = 'TablePartsContractError';
	}
}

// only the hashed name from the generated manifest, under the static CDN; null = no parts file yet.
export function tablePartsUrl(): string | null {
	return VOICE_ROOM_PARTS_MANIFEST
		? `${RuntimeConfig.staticCdnEndpoint}/rooms/${VOICE_ROOM_PARTS_MANIFEST.file}`
		: null;
}

function firstMesh(object: Object3D | undefined): Mesh | null {
	if (!object) return null;
	if (object instanceof Mesh) return object;
	return (object.children.find((child) => child instanceof Mesh) as Mesh | undefined) ?? null;
}

// A part with several primitives (tavla_die: body + pips) answers geometry() with its first; node() has them all.
export function createTableParts(root: Object3D): TableParts {
	const nodes = new Map<string, Object3D>();
	const materials = new Map<string, Material>();
	root.traverse((object) => {
		if (object.name && !nodes.has(object.name)) nodes.set(object.name, object);
		if (object instanceof Mesh)
			for (const material of [object.material].flat() as Array<Material>) materials.set(material.name, material);
	});
	// every part, okey_face and okey_body included, is its own named node.
	const meshOf = (name: TablePartName): Mesh | null => firstMesh(nodes.get(name));
	const geometries = new Map<TablePartName, BufferGeometry>();
	const missing: Array<string> = [];
	for (const name of TABLE_PART_NAMES) {
		const mesh = meshOf(name);
		if (mesh) geometries.set(name, mesh.geometry);
		else missing.push(name);
	}
	if (missing.length > 0) throw new TablePartsContractError(`${missing.join(', ')} missing`);
	return {
		geometry(name) {
			const geometry = geometries.get(name);
			if (!geometry) throw new TablePartsContractError(`${name} is not a part`);
			return geometry;
		},
		material(name) {
			const material = materials.get(name);
			if (!material) throw new TablePartsContractError(`material ${name} missing`);
			return material;
		},
		node: (name) => nodes.get(name) ?? null,
	};
}

let pending: Promise<TableParts> | null = null;
let failed = false;

// Fetched once per room and only when a 3D table first opens. null: no parts file, or it already failed once —
// a broken file then costs every client one request, not one per table opened (the 2D table top stays).
export function loadTableParts(): Promise<TableParts> | null {
	const url = tablePartsUrl();
	if (!url || failed) return null;
	const request = (pending ??= fetch(url)
		.then((response) => {
			if (!response.ok) throw new Error(`Table parts request failed with ${response.status}`);
			return response.arrayBuffer();
		})
		.then((buffer) => new GLTFLoader().parseAsync(buffer, ''))
		.then((gltf) => createTableParts(gltf.scene))
		.catch((error: unknown) => {
			if (pending === request) failed = true;
			logger.warn('3D table parts failed to load, keeping the 2D table top', error);
			throw error;
		}));
	return request;
}

// The room's WebGLRenderer leaves its 'dispose' listeners on every part it drew, and the parts hold ~22 MB of decoded
// textures: kept past the room, they keep every closed room's renderer and canvas alive. The next room loads afresh.
export function releaseTableParts(): void {
	pending = null;
}
