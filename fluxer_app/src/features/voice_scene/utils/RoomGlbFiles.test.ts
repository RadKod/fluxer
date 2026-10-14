// SPDX-License-Identifier: AGPL-3.0-or-later

// The shipped room and table parts files (fluxer_static/rooms, named by the generated manifests), loaded through the
// client's own GLTFLoader path and contract parsers: a file that passes build_manifest.mjs but that the client would
// reject or frame badly fails here.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createTableParts, TABLE_PART_NAMES} from '@app/features/voice_scene/scene/table/TableParts';
import {tavlaBoardGeometry} from '@app/features/voice_scene/scene/table/tavlaLayout';
import {collectContractNodes} from '@app/features/voice_scene/scene/VoiceSceneRenderer';
import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {parseRoomLayout} from '@app/features/voice_scene/utils/GlbRoomContract';
import {
	READABILITY_MIN_PX,
	type ReadabilityItem,
	readability,
	seatedPose,
} from '@app/features/voice_scene/utils/SeatedView';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import {VOICE_ROOM_PARTS_MANIFEST} from '@fluxer/constants/src/VoiceRoomPartsManifest';
import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Box3, type BufferAttribute, Mesh, type Object3D} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {beforeAll, describe, expect, it, vi} from 'vitest';

vi.mock('three-mesh-bvh', () => ({acceleratedRaycast: vi.fn(), disposeBoundsTree: vi.fn(), MeshBVH: class {}}));

const staticFile = (file: string): ArrayBuffer => {
	const bytes = readFileSync(fileURLToPath(new URL(`../../../../../fluxer_static/rooms/${file}`, import.meta.url)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

// The same GLB without its texture references: decoding a PNG needs a browser, and no contract reads the pixels.
function withoutTextures(glb: ArrayBuffer): ArrayBuffer {
	const view = new DataView(glb);
	const jsonLength = view.getUint32(12, true);
	const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
	for (const material of json.materials ?? []) delete material.pbrMetallicRoughness?.baseColorTexture;
	delete json.textures;
	delete json.images;
	delete json.samplers;
	let text = new TextEncoder().encode(JSON.stringify(json));
	const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
	padded.set(text);
	text = padded;
	const bin = new Uint8Array(glb, 20 + jsonLength);
	const out = new Uint8Array(20 + text.length + bin.length);
	const header = new DataView(out.buffer);
	out.set(new Uint8Array(glb, 0, 12));
	header.setUint32(8, out.length, true);
	header.setUint32(12, text.length, true);
	header.setUint32(16, 0x4e4f534a, true);
	out.set(text, 20);
	out.set(bin, 20 + text.length);
	return out.buffer;
}

async function load(file: string): Promise<Object3D> {
	const gltf = await new GLTFLoader().parseAsync(withoutTextures(staticFile(file)), '');
	return gltf.scene;
}

const GAMES: Array<TableGameKind> = ['okey', 'okey101', 'chess', 'dama', 'dama_normal', 'tavla'];
const VIEWPORTS = [
	{width: 1280, height: 720},
	{width: 1920, height: 1080},
];

describe.each(Object.entries(VOICE_ROOM_THEME_MANIFEST))('room file %s', (_id, entry) => {
	let layout: RoomLayout;
	let scene: Object3D;
	beforeAll(async () => {
		scene = await load(entry.file);
		layout = parseRoomLayout(collectContractNodes(scene));
	});

	it('has the manifest seats, tables and stands', () => {
		const names = new Set(layout.seats.map((seat) => seat.name));
		for (const seat of [...entry.seats, ...entry.watch_seats]) expect(names).toContain(seat);
		expect(layout.tables.map((table) => table.slot)).toEqual(entry.tables.map((table) => table.slot));
		expect(layout.stands).toHaveLength(entry.stands);
	});

	it('keeps every seat and stand inside the walls, above the floor', () => {
		const walls = layout.cutaway!.walls;
		for (const point of [...layout.seats.map((seat) => seat.position), ...layout.stands]) {
			for (const {point: p, normal: n} of walls)
				expect((point.x - p.x) * n.x + (point.z - p.z) * n.z).toBeLessThan(-0.3);
			expect(point.y).toBeGreaterThan(0.8);
			expect(point.y).toBeLessThan(layout.cutaway!.ceiling.y - 1);
		}
	});

	it('hangs a level 16:9 TV facing into the room, the camera home outside it', () => {
		const screen = layout.screen!;
		expect(screen.width / screen.height).toBeCloseTo(16 / 9, 2);
		expect(Math.abs(screen.normal.y)).toBeLessThan(1e-3);
		const towardsCentre =
			(layout.camTarget.x - screen.center.x) * screen.normal.x +
			(layout.camTarget.z - screen.center.z) * screen.normal.z;
		expect(towardsCentre).toBeGreaterThan(1);
		expect(layout.camTarget.y).toBeGreaterThanOrEqual(2);
		expect(layout.camHome.y).toBeGreaterThan(layout.cutaway!.ceiling.y);
	});

	it('puts four table seats round each table and watch seats clear of them', () => {
		for (const table of layout.tables) {
			const players = layout.seats.filter((seat) => seat.table?.slot === table.slot);
			expect(players).toHaveLength(4);
			for (const seat of players) {
				expect(Math.hypot(seat.position.x - table.center.x, seat.position.z - table.center.z)).toBeGreaterThan(
					table.topSize / 2,
				);
				expect(seat.position.y - table.center.y).toBeGreaterThanOrEqual(0.24);
			}
			for (const watch of layout.seats.filter((seat) => seat.watch?.slot === table.slot))
				for (const seat of players)
					expect(
						Math.hypot(watch.position.x - seat.position.x, watch.position.z - seat.position.z),
					).toBeGreaterThanOrEqual(0.45);
		}
	});

	it('meets the seat view readability floors for every game, seat and viewport', () => {
		for (const table of layout.tables)
			for (const game of GAMES) {
				const positions: ReadonlyArray<number> = TABLE_GAME_POSITIONS[game];
				const seats = layout.seats.filter(
					(seat) =>
						(seat.table?.slot === table.slot && positions.includes(seat.table.position)) ||
						seat.watch?.slot === table.slot,
				);
				for (const seat of seats)
					for (const viewport of VIEWPORTS) {
						const pose = seatedPose({layout, seat, slot: table.slot, game, aspect: viewport.width / viewport.height});
						const report = readability({pose, viewport, layout, slot: table.slot, game});
						for (const [item, px] of Object.entries(report))
							expect(px, `${seat.name} ${game} ${item}`).toBeGreaterThanOrEqual(
								READABILITY_MIN_PX[item as ReadabilityItem],
							);
					}
			}
	});

	it('draws unlit, with baked vertex colours', () => {
		scene.traverse((object) => {
			if (!(object instanceof Mesh)) return;
			expect(object.material.type).toBe('MeshBasicMaterial');
			expect(object.geometry.getAttribute('color')).toBeDefined();
		});
	});
});

describe('table parts file', () => {
	it('loads into every part the 3D table models ask for, with their materials', async () => {
		expect(VOICE_ROOM_PARTS_MANIFEST).not.toBeNull();
		const root = await load(VOICE_ROOM_PARTS_MANIFEST!.file);
		const parts = createTableParts(root);
		for (const name of TABLE_PART_NAMES) expect(parts.geometry(name).getAttribute('position').count).toBeGreaterThan(0);
		for (const material of ['piece', 'okey_body', 'wood'])
			expect(parts.material(material).type).toBe('MeshBasicMaterial');
		const meshes: Array<Mesh> = [];
		parts.node('tavla_die')!.traverse((object) => {
			if (object instanceof Mesh) meshes.push(object);
		});
		expect(meshes).toHaveLength(2);
	});

	it('lays the tavla board out at the readable size, its spots on the board', async () => {
		const root = await load(VOICE_ROOM_PARTS_MANIFEST!.file);
		const parts = createTableParts(root);
		const empty = (name: string) => {
			const {x, y, z} = parts.node(name)!.position;
			return {x, y, z};
		};
		const bounds = (name: Parameters<typeof parts.geometry>[0]) =>
			new Box3().setFromBufferAttribute(parts.geometry(name).getAttribute('position') as BufferAttribute);
		const board = bounds('tavla_board');
		const checker = bounds('tavla_checker');
		const g = tavlaBoardGeometry({
			boardMin: board.min,
			boardMax: board.max,
			points: Array.from({length: 24}, (_, i) => empty(`tp_${String(i + 1).padStart(2, '0')}`)),
			bar: {white: empty('tp_bar_w'), black: empty('tp_bar_b')},
			off: {white: empty('tp_off_w'), black: empty('tp_off_b')},
			checker: {diameter: checker.max.x - checker.min.x, height: checker.max.y - checker.min.y},
		});
		expect(g.scale).toBeGreaterThan(1.3);
		// white's home (1–6) at +X on white's edge (+Z), 13–24 across
		expect(g.points[0]!.x).toBeGreaterThan(0);
		expect(g.points[0]!.z).toBeGreaterThan(0);
		expect(g.points[23]!.x).toBeCloseTo(g.points[0]!.x, 5);
		expect(g.points[23]!.z).toBeCloseTo(-g.points[0]!.z, 5);
		expect(g.pointWidth).toBeGreaterThanOrEqual(g.checker.diameter);
	});
});
