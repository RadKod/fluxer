// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera} from 'three';
import {type GLTF, GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

const manifest = vi.hoisted(() => ({value: null as {file: string; bytes: number} | null}));
vi.mock('@fluxer/constants/src/VoiceRoomPartsManifest', () => ({
	get VOICE_ROOM_PARTS_MANIFEST() {
		return manifest.value;
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));

const {createTableParts, TABLE_PART_NAMES, TablePartsContractError, tablePartsUrl, loadTableParts} = await import(
	'@app/features/voice_scene/scene/table/TableParts'
);
const {mountTableGame3D} = await import('@app/features/voice_scene/scene/TableGame3DHost');

function material(name: string): MeshBasicMaterial {
	const result = new MeshBasicMaterial();
	result.name = name;
	return result;
}

function mesh(name: string, materialName: string): Mesh {
	const result = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), material(materialName));
	result.name = name;
	return result;
}

// The shape GLTFLoader gives the parts file: one mesh per named node (okey_face and okey_body are two
// nodes); a multi-primitive mesh (tavla_die: body + pips) arrives as a group of meshes.
function partsScene(skip: ReadonlyArray<string> = []): Group {
	const root = new Group();
	for (const name of ['piece_k', 'piece_q', 'piece_r', 'piece_b', 'piece_n', 'piece_p', 'piece_dm', 'piece_dk'])
		if (!skip.includes(name)) root.add(mesh(name, 'piece'));
	const board = mesh('tavla_board', 'board');
	const point = new Object3D();
	point.name = 'tp_01';
	board.add(point);
	root.add(board, mesh('tavla_checker', 'checker'), mesh('okey_rack', 'wood'));
	const die = new Group();
	die.name = 'tavla_die';
	die.add(mesh('Cube.016', 'die'), mesh('Cube.016_1', 'pip'));
	root.add(die);
	for (const name of ['okey_body', 'okey_face']) if (!skip.includes(name)) root.add(mesh(name, name));
	return root;
}

afterEach(() => {
	manifest.value = null;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('TableParts', () => {
	it('a released request failing after the next room loads keeps the next request cached', async () => {
		vi.resetModules();
		const {loadTableParts, releaseTableParts} = await import('@app/features/voice_scene/scene/table/TableParts');
		manifest.value = {file: 'masa-parcalari.0123456789ab.glb', bytes: 1};
		let rejectFirst!: (error: Error) => void;
		const firstResponse = new Promise<Response>((_resolve, reject) => {
			rejectFirst = reject;
		});
		const fetchSpy = vi
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(0),
			});
		vi.stubGlobal('fetch', fetchSpy);
		vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockResolvedValue({scene: partsScene()} as GLTF);
		const first = loadTableParts();
		expect(first).not.toBeNull();
		releaseTableParts();
		const second = loadTableParts();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
		await second;
		const error = new Error('released request failed');
		const rejection = expect(first).rejects.toBe(error);
		rejectFirst(error);
		await rejection;
		expect(loadTableParts()).toBe(second);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('a current request failure prevents further requests for the session', async () => {
		vi.resetModules();
		const {loadTableParts, releaseTableParts} = await import('@app/features/voice_scene/scene/table/TableParts');
		manifest.value = {file: 'masa-parcalari.0123456789ab.glb', bytes: 1};
		const error = new Error('current request failed');
		const fetchSpy = vi.fn().mockRejectedValue(error);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(loadTableParts()).rejects.toBe(error);
		expect(loadTableParts()).toBeNull();
		releaseTableParts();
		expect(loadTableParts()).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('all M21 part names resolve; a missing name throws a contract error', () => {
		const root = partsScene();
		const parts = createTableParts(root);
		expect(TABLE_PART_NAMES).toHaveLength(14);
		for (const name of TABLE_PART_NAMES) expect(parts.geometry(name)).toBeDefined();
		const byName = (name: string) => root.getObjectByName(name) as Mesh;
		expect(parts.geometry('piece_n')).toBe(byName('piece_n').geometry);
		expect(parts.geometry('okey_face')).toBe(byName('okey_face').geometry);
		expect(parts.geometry('okey_body')).toBe(byName('okey_body').geometry);
		expect(parts.geometry('tavla_die')).toBe(byName('Cube.016').geometry);
		expect(parts.material('piece').name).toBe('piece');
		expect(parts.material('pip').name).toBe('pip');
		expect(parts.node('tp_01')?.name).toBe('tp_01');
		expect(parts.node('tp_99')).toBeNull();
		expect(() => parts.material('gold')).toThrow(TablePartsContractError);

		expect(() => createTableParts(partsScene(['piece_n']))).toThrow(/piece_n missing/);
		expect(() => createTableParts(partsScene(['okey_face']))).toThrow(TablePartsContractError);
	});

	it('VOICE_ROOM_PARTS_MANIFEST null → mountTableGame returns null', () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		manifest.value = null;
		expect(tablePartsUrl()).toBeNull();
		expect(loadTableParts()).toBeNull();
		const layout: RoomLayout = {
			seats: [],
			stands: [],
			tables: [{slot: 'T01', center: {x: 0, y: 0.8, z: 0}, topSize: 1.3}],
			camTarget: {x: 0, y: 2, z: 0},
			camHome: {x: 10, y: 10, z: 10},
			camPan: {x: 0, z: 0},
			screen: null,
		};
		const parent = new Group();
		const mounted = mountTableGame3D({
			parent,
			camera: new PerspectiveCamera(),
			dom: {addEventListener: vi.fn(), removeEventListener: vi.fn()} as unknown as HTMLElement,
			layout,
			slot: 'T01',
			game: 'chess',
			factoryFor: vi.fn(),
			requestRender: vi.fn(),
		});
		expect(mounted).toBeNull();
		expect(parent.children).toHaveLength(0);
		expect(fetchSpy).not.toHaveBeenCalled();

		// With a manifest entry the URL is the hashed name under the static CDN, nothing else.
		manifest.value = {file: 'masa-parcalari.0123456789ab.glb', bytes: 1};
		expect(tablePartsUrl()).toBe('https://static.example/rooms/masa-parcalari.0123456789ab.glb');
	});
});
