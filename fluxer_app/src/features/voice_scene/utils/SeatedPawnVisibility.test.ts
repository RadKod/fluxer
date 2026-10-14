// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {START_FEN} from '@app/features/table_game/state/TableGameTestViews';
import {createBoardTableModel} from '@app/features/voice_scene/scene/table/BoardTableModel';
import type {TablePartName, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {RoomLayout, RoomSeat, TableScene3DInput, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {
	READABILITY_MIN_PX,
	type ReadabilityItem,
	readability,
	seatedPose,
} from '@app/features/voice_scene/utils/SeatedView';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	BufferAttribute,
	BufferGeometry,
	Group,
	InstancedMesh,
	LatheGeometry,
	Matrix4,
	MeshBasicMaterial,
	PerspectiveCamera,
	Raycaster,
	Vector2,
	Vector3,
} from 'three';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// A centered 0.54 m eye keeps the board frame floor; the next centimetre does not. Removing the former 0.20 m
// lateral eye trades its all-piece half-silhouette guarantee for the straight view: actual GLB minimum 47.54% versus
// 54.68% with the lateral eye (1280x646, Gece Lounge). These approximate lathe profiles reach 42.98%; their regression
// floor is 42.5%, with >= 14 half-visible pawns. Piece silhouettes are measured separately. Watcher and readability thresholds stay intact.

// masa-parcalari rev2 chess parts as lathes: each part's cross-section radius at 25 evenly spaced heights (mm, base on
// y = 0; the exact triangle slices of the parts file). The knight, one-sided, is below.
const PART_PROFILES: Record<string, {height: number; radii: Array<number>}> = {
	piece_k: {
		height: 0.08,
		radii: [
			16.7, 19, 17, 14.6, 12.4, 11.7, 10.8, 10, 9.1, 8.3, 7.4, 6.7, 6.9, 7.1, 7.4, 7.6, 13.1, 13.3, 9.8, 7.7, 8, 3.2,
			7.2, 7.2, 2.8,
		],
	},
	piece_q: {
		height: 0.0735,
		radii: [
			16.7, 19, 17.1, 16.3, 12.5, 12, 11.1, 10.2, 9.3, 8.4, 7.5, 6.7, 6.9, 7.1, 7.3, 7.6, 13.1, 13.4, 10.6, 9.3, 10.3,
			11.8, 13, 12, 0.6,
		],
	},
	piece_r: {
		height: 0.057,
		radii: [
			16.6, 19, 18.3, 17, 15.7, 12.5, 12.2, 11, 9.7, 8.5, 7.3, 6.8, 7, 7.3, 7.5, 11.1, 13.5, 11.1, 11.3, 12.3, 13, 13,
			14.3, 14.3, 13.8,
		],
	},
	piece_b: {
		height: 0.071,
		radii: [
			16.6, 19, 17.2, 16.7, 12.5, 12, 10.9, 9.7, 8.5, 7.3, 6.8, 7, 7.3, 7.6, 13.1, 12.8, 8.3, 7, 7.9, 8.7, 9, 8.7, 7.7,
			5.8, 0.4,
		],
	},
	piece_p: {
		height: 0.0418,
		radii: [
			14, 16, 16, 15, 14.3, 14.1, 11.5, 10.5, 10.4, 8.7, 6.9, 5.6, 5.8, 6, 6.2, 7.5, 11.2, 10.4, 7.3, 7.7, 7.7, 7.3,
			6.4, 4.8, 0.3,
		],
	},
};

// T01 of the three rooms (rev 4 and rev 5 GLBs alike): table centre, seats 1–4, the first watch seat, the camera.
const ROOMS: Record<
	string,
	{
		top: number;
		table: Array<number>;
		seats: Array<Array<number>>;
		watch: Array<number>;
		target: Array<number>;
		home: Array<number>;
	}
> = {
	kahvehane: {
		top: 1.3,
		table: [-4.35, 0.795, 1.2],
		seats: [
			[-4.35, 1.1, 2.28],
			[-3.27, 1.1, 1.2],
			[-4.35, 1.1, 0.12],
			[-5.43, 1.1, 1.2],
		],
		watch: [-3.7617, 1.1, 2.8163],
		target: [-0.0598, 2.0281, -0.1644],
		home: [8.4907, 21.2103, 23.3279],
	},
	'gece-lounge': {
		top: 1.3,
		table: [-3.7, 1.26, -3.13],
		seats: [
			[-3.7, 1.54, -2.03],
			[-2.6, 1.54, -3.13],
			[-3.7, 1.54, -4.23],
			[-4.8, 1.54, -3.13],
		],
		watch: [-3.7, 1.6, -1.41],
		target: [-0.2607, 2.3444, -0.3929],
		home: [13.7393, 10.2444, 20.7071],
	},
	'oyun-odasi': {
		top: 1.4,
		table: [1.23, 0.8, -2.68],
		seats: [
			[1.23, 1.125, -1.54],
			[2.37, 1.125, -2.68],
			[1.23, 1.125, -3.82],
			[0.09, 1.125, -2.68],
		],
		watch: [1.9569, 1.36, -1.1212],
		target: [-0.2589, 2.1743, -0.3902],
		home: [13.7411, 10.4743, 20.7098],
	},
};

const WIDTH = 1280;
const HEIGHT = 720;
// Every 2nd pixel of a pawn's silhouette box is cast.
const STEP = 2;

const at = ([x, y, z]: Array<number>): Vec3 => ({x: x!, y: y!, z: z!});

function layoutOf(room: string): RoomLayout {
	const r = ROOMS[room]!;
	const seats: Array<RoomSeat> = r.seats.map((position, index) => ({
		name: `seat_T01_${index + 1}`,
		group: 'T01',
		position: at(position),
		table: {slot: 'T01', position: (index + 1) as 1 | 2 | 3 | 4},
		watch: null,
	}));
	seats.push({name: 'seat_T01_Y1', group: 'T01', position: at(r.watch), table: null, watch: {slot: 'T01', index: 1}});
	return {
		seats,
		stands: [],
		tables: [{slot: 'T01', center: at(r.table), topSize: r.top}],
		camTarget: at(r.target),
		camHome: at(r.home),
		camPan: {x: 0, z: 0},
		screen: null,
	};
}

// The knight's head reaches out one way only: at each of 25 heights its reach in 8 directions (0°, 45°, … from +x
// towards +z, mm), lofted as octagons.
const KNIGHT = {
	height: 0.0683,
	rings: [
		[17.1, 17.1, 17.1, 17.1, 17.1, 17.1, 17.1, 17.1],
		[19, 19, 19, 19, 19, 19, 19, 19],
		[19, 19, 19, 19, 19, 19, 19, 19],
		[16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.5],
		[14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2],
		[12.6, 12.6, 12.6, 12.6, 12.6, 12.6, 12.6, 12.6],
		[11.6, 11.6, 11.6, 11.6, 11.6, 11.6, 11.6, 11.6],
		[11.2, 11.2, 11.2, 11.2, 11.2, 11.2, 11.2, 11.2],
		[11.8, 11.8, 11.8, 11.8, 11.8, 11.8, 11.8, 11.8],
		[5.3, 0, 0, 0, 5.3, 10.2, 10, 10.2],
		[5.5, 6.4, 5.1, 6.4, 5.5, 10.3, 10, 10.3],
		[5.5, 7.6, 6.2, 7.6, 5.5, 10.3, 10, 10.3],
		[5.5, 6.9, 5.3, 6.9, 5.5, 10.3, 10, 10.3],
		[5.5, 6.3, 4.3, 6.3, 5.5, 10.3, 10, 10.3],
		[5.5, 5.6, 3.5, 5.6, 5.5, 10.3, 10, 10.3],
		[5.5, 5.8, 3.6, 5.8, 5.5, 9.7, 9.2, 9.7],
		[5.5, 15.2, 17.6, 15.2, 5.5, 9.1, 8.3, 9.1],
		[5.5, 17.6, 20.4, 17.6, 5.5, 8.5, 7.5, 8.5],
		[5.5, 17.8, 20.6, 17.8, 5.5, 8.2, 7.1, 8.2],
		[5.5, 15, 17.2, 15, 5.5, 8.4, 7.3, 8.4],
		[5.5, 11.4, 12, 11.4, 5.5, 8.5, 7.5, 8.5],
		[5.5, 9.1, 8.5, 9.1, 5.5, 8.7, 7.7, 8.7],
		[5.5, 7.4, 6.1, 7.4, 5.5, 8.8, 7.9, 8.8],
		[5.5, 1.6, 0, 1.6, 5.5, 8.2, 7.1, 8.2],
		[4.1, 0, 0, 0, 4.1, 6.4, 5, 6.4],
	],
};

function octagonLoft({height, rings}: {height: number; rings: Array<Array<number>>}): BufferGeometry {
	const positions: Array<number> = [];
	rings.forEach((ring, k) =>
		ring.forEach((reach, d) => {
			const angle = (d * Math.PI) / 4;
			positions.push(
				(reach / 1000) * Math.cos(angle),
				(height * k) / (rings.length - 1),
				(reach / 1000) * Math.sin(angle),
			);
		}),
	);
	const index: Array<number> = [];
	for (let k = 0; k + 1 < rings.length; k++)
		for (let d = 0; d < 8; d++) {
			const a = k * 8 + d;
			const b = k * 8 + ((d + 1) % 8);
			index.push(a, b, a + 8, b, b + 8, a + 8);
		}
	for (let d = 1; d + 1 < 8; d++) {
		index.push(0, d + 1, d);
		const top = (rings.length - 1) * 8;
		index.push(top, top + d, top + d + 1);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
	geometry.setIndex(index);
	return geometry;
}

function lathe({height, radii}: {height: number; radii: Array<number>}): BufferGeometry {
	const points = radii.map((radius, i) => new Vector2(radius / 1000, (height * i) / (radii.length - 1)));
	return new LatheGeometry([new Vector2(0, 0), ...points, new Vector2(0, height)], 16);
}

const parts: TableParts = (() => {
	const geometries = new Map(Object.entries(PART_PROFILES).map(([name, profile]) => [name, lathe(profile)]));
	geometries.set('piece_n', octagonLoft(KNIGHT));
	const material = new MeshBasicMaterial({name: 'piece'});
	return {
		geometry: (name: TablePartName) => {
			const geometry = geometries.get(name);
			if (!geometry) throw new Error(`no part ${name}`);
			return geometry;
		},
		material: () => material,
		node: () => null,
	};
})();

// Sampled visible area of every piece, rather than its bounding box or unoccluded nominal height.
function pieceShares(
	layout: RoomLayout,
	seat: RoomSeat,
	width = WIDTH,
	height = HEIGHT,
	white: 1 | 3 = 1,
): Array<{square: string; pawn: boolean; share: number; seenPx: number}> {
	const table = layout.tables[0]!;
	const edges = layout.seats.filter((entry) => entry.table !== null);
	const distance = (s: RoomSeat) => Math.hypot(s.position.x - seat.position.x, s.position.z - seat.position.z);
	const perspectiveSeat = seat.table
		? seat
		: edges.reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best));
	// As TableGame3DHost places it: the anchor on the table centre, +Z towards the perspective seat.
	const anchor = new Group();
	anchor.position.set(table.center.x, table.center.y, table.center.z);
	anchor.rotation.y = Math.atan2(
		perspectiveSeat.position.x - table.center.x,
		perspectiveSeat.position.z - table.center.z,
	);
	const model = createBoardTableModel({
		parts,
		table: {center: table.center, topSize: table.topSize},
		game: 'chess',
		requestRender() {},
	});
	anchor.add(model.root);
	model.update({
		view: {
			summary: {game: 'chess'},
			game_view: {
				game: 'chess',
				fen: START_FEN,
				white,
				clocks_ms: {white: 600_000, black: 600_000},
				turn_started_at: null,
				last_move: null,
				legal_moves: null,
				in_check: false,
			},
		},
		perspective: perspectiveSeat.table!.position,
		rack: [],
		stage: null,
		pendingTavla: [],
		selection: null,
		targets: [],
		interactive: false,
	} as unknown as TableScene3DInput);
	anchor.updateMatrixWorld(true);
	const pieces: Array<InstancedMesh> = [];
	model.root.traverse((object) => {
		if (object instanceof InstancedMesh && object.count > 0 && !object.material.transparent) pieces.push(object);
	});
	const pose = seatedPose({layout, seat, slot: 'T01', game: 'chess', aspect: width / height});
	const camera = new PerspectiveCamera(pose.fovDeg, width / height, 0.05, 100);
	camera.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
	camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
	camera.updateMatrixWorld();
	const raycaster = new Raycaster();
	const pawn = parts.geometry('piece_p');
	const shares: Array<{square: string; pawn: boolean; share: number; seenPx: number}> = [];
	const local = new Matrix4();
	for (const mesh of pieces) {
		mesh.geometry.computeBoundingBox();
		for (let id = 0; id < mesh.count; id++) {
			mesh.getMatrixAt(id, local);
			const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld.clone().multiply(local));
			const xs: Array<number> = [];
			const ys: Array<number> = [];
			for (const x of [box.min.x, box.max.x])
				for (const y of [box.min.y, box.max.y])
					for (const z of [box.min.z, box.max.z]) {
						const ndc = new Vector3(x, y, z).project(camera);
						xs.push(((ndc.x + 1) / 2) * width);
						ys.push(((1 - ndc.y) / 2) * height);
					}
			let whole = 0;
			let seen = 0;
			for (let py = Math.floor(Math.min(...ys)); py <= Math.max(...ys); py += STEP)
				for (let px = Math.floor(Math.min(...xs)); px <= Math.max(...xs); px += STEP) {
					raycaster.setFromCamera(new Vector2(((px + 0.5) / width) * 2 - 1, 1 - ((py + 0.5) / height) * 2), camera);
					const hits = raycaster.intersectObjects(pieces, false);
					if (!hits.some((hit) => hit.object === mesh && hit.instanceId === id)) continue;
					whole++;
					if (hits[0]!.object === mesh && hits[0]!.instanceId === id) seen++;
				}
			const position = new Vector3().setFromMatrixPosition(mesh.matrixWorld.clone().multiply(local));
			const proxy = model
				.pickables()
				.find((proxy) => proxy.getWorldPosition(new Vector3()).distanceTo(position) < 1e-5)!;
			shares.push({
				square: proxy.userData.source.square,
				pawn: mesh.geometry === pawn,
				share: whole ? seen / whole : 0,
				seenPx: seen * STEP * STEP,
			});
		}
	}
	model.dispose();
	return shares;
}

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
		() =>
			new Proxy({} as Record<string, unknown>, {
				get: (target, key: string) => (key in target ? target[key] : () => undefined),
				set: (target, key: string, value) => {
					target[key] = value;
					return true;
				},
			}) as never,
	);
});

describe('seat-view chess opening visibility', () => {
	for (const room of Object.keys(ROOMS))
		it(`${room}: centered players see all 32 approximate pieces >= 42.5% and >= 14 pawns at least half; a watcher sees >= 12 pawns`, () => {
			const layout = layoutOf(room);
			for (const white of [1, 3] as const)
				for (const name of ['seat_T01_1', 'seat_T01_3', 'seat_T01_Y1'])
					for (const [width, height] of [
						[1280, 720],
						[1440, 900],
						[1280, 646],
						[1440, 826],
					]) {
						const seat = layout.seats.find((entry) => entry.name === name)!;
						const shares = pieceShares(layout, seat, width, height, white);
						expect(shares).toHaveLength(32);
						if (seat.table) {
							for (const piece of shares)
								expect(
									piece.share,
									`${room} ${name} white ${white} ${width} ${piece.square} ${piece.seenPx} visible px`,
								).toBeGreaterThanOrEqual(0.425);
							expect(shares.filter((piece) => piece.pawn && piece.share >= 0.5).length).toBeGreaterThanOrEqual(14);
						} else expect(shares.filter((piece) => piece.pawn && piece.share >= 0.5).length).toBeGreaterThanOrEqual(12);
					}
		}, 60000);

	it('the raised eye keeps every game readable from every seat', () => {
		const games: Array<TableGameKind> = ['chess', 'dama', 'dama_normal', 'tavla', 'okey', 'okey101'];
		for (const room of Object.keys(ROOMS)) {
			const layout = layoutOf(room);
			for (const seat of layout.seats)
				for (const game of games)
					for (const [width, height] of [
						[1440, 900],
						[1280, 720],
					] as const) {
						const pose = seatedPose({layout, seat, slot: 'T01', game, aspect: width / height});
						const report = readability({pose, viewport: {width, height}, layout, slot: 'T01', game});
						for (const [item, px] of Object.entries(report))
							expect(px, `${room} ${seat.name} ${game} ${width} ${item}`).toBeGreaterThanOrEqual(
								READABILITY_MIN_PX[item as ReadabilityItem],
							);
					}
		}
	});
});
