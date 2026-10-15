// SPDX-License-Identifier: AGPL-3.0-or-later

// Neon Salon: a dark club lounge. Magenta and cyan strip lights on the walls and the ceiling, a U of sofas in front
// of the TV on the north wall, a long back-lit bar on the west wall, a booth corner and a game table on the east side.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	armchair,
	bottle,
	box,
	coffeeTable,
	cyl,
	cylZ,
	door,
	gameTable,
	neonStrip,
	pendant,
	plant,
	rbox,
	rug,
	slab,
	sofa,
	sphere,
	stool,
	torus,
	tvBezel,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 13;
const D = 10;
const H = 3.3;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const MAGENTA = '#ff2fb0';
const CYAN = '#2ee6ff';
const VIOLET = '#8a4dff';

// A neon tube along a polyline in the wall plane (x, y), `z` off the wall.
function neonPath(room, points, color, {z = 0.05, thickness = 0.025, intensity = 1.6} = {}) {
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i];
		const length = Math.hypot(x1 - x0, y1 - y0);
		const g = box(length + thickness, thickness, thickness)
			.rotateZ(Math.atan2(y1 - y0, x1 - x0))
			.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
		room.add(g, color, {emissive: intensity, cast: false});
	}
}

function bar(room, length, random) {
	// counter: black front with a magenta underglow, a pale top
	room.add(box(length, 1.05, 0.6, 0, 0.525, 0.9), '#121019');
	for (let i = 0; i < Math.floor(length / 0.3); i++)
		room.add(box(0.02, 0.9, 0.02, -length / 2 + 0.15 + i * 0.3, 0.55, 1.21), VIOLET, {emissive: 0.5, cast: false});
	room.add(rbox(length + 0.1, 0.05, 0.72, 0.012, 0, 1.075, 0.92), '#e6e1f0');
	neonStrip(room, {length, color: MAGENTA, x: 0, y: 0.05, z: 1.22, intensity: 1.6});
	neonStrip(room, {length, color: CYAN, x: 0, y: 1.045, z: 1.25, thickness: 0.015, intensity: 1.3});
	// back bar: lit shelves of bottles
	room.add(box(length, 0.9, 0.45, 0, 0.45, 0.24), '#0f0d15');
	room.add(rbox(length, 0.04, 0.5, 0.01, 0, 0.92, 0.25), '#24202e');
	room.add(box(length - 0.2, 1.3, 0.02, 0, 1.75, 0.02), '#3a1a5a', {emissive: 0.9, cast: false});
	const glass = ['#2fd0ff', '#ff4fc0', '#c9a24a', '#7a5aff', '#e8e0d0', '#3fbf7a'];
	for (const y of [1.2, 1.65, 2.1]) {
		room.add(box(length - 0.2, 0.03, 0.22, 0, y, 0.13), '#24202e', {cast: false});
		neonStrip(room, {length: length - 0.3, color: CYAN, x: 0, y: y - 0.025, z: 0.23, thickness: 0.012, intensity: 1.0});
		for (let x = -length / 2 + 0.25; x < length / 2 - 0.2; x += 0.14 + random() * 0.07)
			bottle(room, {
				x,
				y: y + 0.015,
				z: 0.13,
				color: glass[Math.floor(random() * glass.length)],
				h: 0.22 + random() * 0.1,
			});
	}
	room.add(box(length, 0.08, 0.32, 0, 2.5, 0.16), '#0f0d15');
	neonStrip(room, {length: length - 0.1, color: MAGENTA, x: 0, y: 2.46, z: 0.33, intensity: 1.6});
	for (let i = 0; i < 7; i++)
		room.add(cyl(0.035, 0.03, 0.12, -length / 2 + 0.4 + i * 0.52, 1.1, 1.0 + (i % 2) * 0.1, 10), '#d8e8ff', {
			glass: true,
		});
}

export function buildNeonSalon() {
	const room = new Room({
		ambient: '#3a2c5c',
		sky: '#5a4890',
		ground: '#22183a',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		lights: [{direction: [0.3, -0.8, 0.4], color: '#7a5ad6', intensity: 0.18, shadow: true}],
		seed: 41,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#2a2540'},
		baseboard: '#0b0a10',
		ceiling: '#0e0d15',
		base: '#0f0d14',
		openings: {E: [{u: -3.4, y0: 0, w: 1.1, h: 2.3}]},
		floor(r) {
			// large dark tiles, alternate ones a touch lighter
			const tile = 0.65;
			for (let ix = 0; ix < Math.ceil(W / tile); ix++)
				for (let iz = 0; iz < Math.ceil(D / tile); iz++) {
					const x0 = -W / 2 + ix * tile;
					const z0 = -D / 2 + iz * tile;
					const w = Math.min(tile, W / 2 - x0);
					const d = Math.min(tile, D / 2 - z0);
					const v = (ix + iz) % 2 ? 0.16 : 0.21;
					const j = random() * 0.015;
					r.add(
						box(w - 0.008, 0.02, d - 0.008, x0 + w / 2, -0.01, z0 + d / 2, [2, 1, 2]),
						rgb(v + j, v * 0.9 + j, v * 1.25 + j),
					);
				}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#050408');
		},
	};
	buildShell(room, shell);

	// ceiling: a dropped panel with a cyan cove, two magenta bars over the lounge
	room.useBucket('ceiling');
	room.add(slab(W - 2.2, 0.12, D - 2.2, 0, H - 0.18, 0, 0.8), '#14121e');
	for (const s of [-1, 1]) {
		neonStrip(room, {length: W - 2.2, color: CYAN, x: 0, y: H - 0.26, z: (s * (D - 2.2)) / 2, intensity: 1.3});
		neonStrip(room, {
			length: D - 2.2,
			color: CYAN,
			x: (s * (W - 2.2)) / 2,
			y: H - 0.26,
			z: 0,
			axis: 'z',
			intensity: 1.3,
		});
	}
	for (const x of [-3.0, -1.4])
		neonStrip(room, {length: 4.2, color: MAGENTA, x, y: H - 0.26, z: -2.4, axis: 'z', intensity: 1.5});
	room.useBucket('room');

	// floor-level glow along every wall, vertical tubes on the north wall
	for (const side of ['N', 'W', 'E', 'S'])
		onWall(room, shell, side, 0, () => {
			const length = side === 'N' || side === 'S' ? W : D;
			neonStrip(room, {
				length,
				color: side === 'N' || side === 'S' ? MAGENTA : CYAN,
				x: 0,
				y: 0.13,
				z: 0.03,
				thickness: 0.02,
				intensity: 1.2,
			});
			room.add(box(length, 0.04, 0.05, 0, 2.9, 0.025), '#0b0a10');
			neonStrip(room, {length, color: VIOLET, x: 0, y: 2.88, z: 0.055, thickness: 0.02, intensity: 1.2});
		});
	onWall(room, shell, 'N', 0, () => {
		for (const [u, color] of [
			[-5.6, CYAN],
			[-5.3, MAGENTA],
			[0.0, MAGENTA],
			[0.3, CYAN],
			[6.0, CYAN],
		])
			neonStrip(room, {length: 2.5, color, x: u, y: 1.45, z: 0.04, axis: 'y', thickness: 0.03, intensity: 1.5});
		room.light(-5.45, 1.4, 0.5, {color: VIOLET, intensity: 0.4, range: 1.6, shadow: false});
		room.light(0.15, 1.4, 0.5, {color: VIOLET, intensity: 0.4, range: 1.6, shadow: false});
	});

	// --- TV on the north wall, a low console with an underglow
	onWall(room, shell, 'N', -2.2, () => {
		tvBezel(room, {w: 2.6, h: (2.6 * 9) / 16, y: 1.7});
		room.add(box(3.4, 0.36, 0.45, 0, 0.22, 0.24), '#121019');
		neonStrip(room, {length: 3.3, color: CYAN, x: 0, y: 0.04, z: 0.47, thickness: 0.02, intensity: 1.4});
		neonStrip(room, {length: 3.3, color: MAGENTA, x: 0, y: 0.41, z: 0.47, thickness: 0.015, intensity: 1.2});
		for (const s of [-1, 1]) {
			room.add(box(0.3, 1.0, 0.3, s * 1.4, 0.9, 0.2), '#0f0d15');
			room.add(cylZ(0.09, 0.02, s * 1.4, 1.1, 0.36, 14), '#2a2638');
		}
		room.light(0, 0.6, 0.8, {color: CYAN, intensity: 0.35, range: 1.6, shadow: false});
	});
	screen(room, shell, 'N', -2.2, {width: 2.6, y: 1.7});

	// --- group A: a U of sofas round a low table, facing the TV
	const heads = [];
	const lounge = (x, z, yaw, width, seats, pillows) =>
		room.at(x, 0, z, yaw, () => {
			for (const h of sofa(room, {width, seats, frame: '#231c36', cushion: '#35285a', legs: '#08080c', pillows}))
				heads.push(room.worldPoint(...h));
			neonStrip(room, {length: width - 0.1, color: MAGENTA, x: 0, y: 0.04, z: -0.47, thickness: 0.015, intensity: 1.0});
		});
	lounge(-2.2, -0.6, Math.PI, 3.0, 4, [CYAN, MAGENTA]);
	lounge(-4.45, -2.45, Math.PI / 2, 2.3, 3, [MAGENTA]);
	lounge(0.05, -2.45, -Math.PI / 2, 2.3, 3, [CYAN]);
	heads
		.sort((a, b) => a.x - b.x || a.z - b.z)
		.forEach((p, i) =>
			room.empties.push({name: `seat_A_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
		);
	room.at(-2.2, 0, -2.45, 0, () => {
		rug(room, {w: 4.0, d: 3.0, color: '#1c1430', border: '#2a1f48'});
		coffeeTable(room, {w: 1.5, d: 0.75, top: '#0c0b12', legs: '#3a2f5a'});
		neonStrip(room, {length: 1.4, color: CYAN, x: 0, y: 0.36, z: 0.37, thickness: 0.012, intensity: 1.2});
		room.add(sphere(0.07, 0.35, 0.47, -0.05, 10, 6), MAGENTA, {emissive: 1.2, cast: false});
		room.add(cyl(0.035, 0.03, 0.12, -0.3, 0.4, 0.1, 10), '#d8e8ff', {glass: true});
	});
	room.light(-2.2, 2.6, -2.4, {color: MAGENTA, intensity: 0.45, range: 2.6, shadow: false});

	// --- west wall: the bar, group C stools
	room.at(-W / 2 + 0.02, 0, 2.5, Math.PI / 2, () => {
		bar(room, 4.0, random);
		room.light(0, 1.7, 0.6, {color: VIOLET, intensity: 0.6, range: 1.8, shadow: false});
		room.light(0, 0.25, 1.6, {color: MAGENTA, intensity: 0.5, range: 1.4, shadow: false});
		for (const x of [-1.3, 0, 1.3])
			room.at(x, 0, 0.92, 0, () =>
				pendant(room, {ceiling: H, drop: 1.0, kind: 'globe', glow: '#ff9ad8', intensity: 0.7, range: 1.6}),
			);
		[-1.6, -0.8, 0, 0.8, 1.6].forEach((x, i) =>
			room.at(x, 0, 1.75, Math.PI, () => {
				const [hx, hy, hz] = stool(room, {height: 0.74, seat: '#ff2fb0', metal: '#0b0a10'});
				room.empty(`seat_C_${String(i + 1).padStart(2, '0')}`, hx, hy, hz);
			}),
		);
	});

	// --- group B: a booth in the north-east corner, two small sofas facing over a table
	const booth = [];
	for (const [z, yaw] of [
		[-4.3, 0],
		[-1.95, Math.PI],
	])
		room.at(4.6, 0, z, yaw, () => {
			for (const h of sofa(room, {
				width: 1.8,
				seats: 2,
				frame: '#13283a',
				cushion: '#1e4a63',
				legs: '#08080c',
				backHeight: 1.05,
			}))
				booth.push(room.worldPoint(...h));
		});
	booth.forEach((p, i) =>
		room.empties.push({name: `seat_B_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
	);
	room.at(4.6, 0, -3.12, 0, () => {
		room.add(rbox(1.3, 0.05, 0.7, 0.02, 0, 0.72, 0), '#0c0b12');
		room.add(cyl(0.05, 0.07, 0.7, 0, 0, 0, 10), '#2a2638');
		room.add(cyl(0.25, 0.28, 0.03, 0, 0, 0, 14), '#2a2638');
		neonStrip(room, {length: 1.25, color: CYAN, x: 0, y: 0.69, z: 0.35, thickness: 0.012, intensity: 1.2});
		for (const x of [-0.3, 0.25]) room.add(cyl(0.035, 0.03, 0.12, x, 0.745, 0.05, 10), '#d8e8ff', {glass: true});
		pendant(room, {
			ceiling: H,
			drop: 1.25,
			kind: 'cone',
			shade: '#1a1824',
			glow: '#9fe8ff',
			intensity: 0.9,
			range: 1.8,
		});
	});
	// neon sign over the booth: a ring and a wave
	onWall(room, shell, 'N', 1.9, () => {
		room.add(torus(0.42, 0.022, 0, 1.95, 0.06, 6, 40), MAGENTA, {emissive: 1.7, cast: false});
		neonPath(
			room,
			Array.from({length: 9}, (_, i) => [-0.6 + i * 0.15, 1.95 + (i % 2 ? 0.12 : -0.12)]),
			CYAN,
			{z: 0.08, intensity: 1.7},
		);
		room.light(0, 1.9, 0.5, {color: MAGENTA, intensity: 0.6, range: 1.7, shadow: false});
	});

	// --- the game table with club armchairs and poufs for the watchers
	room.at(2.0, 0, 2.0, 0, () => {
		rug(room, {w: 3.6, d: 3.6, color: '#16122a', border: '#2a1f48'});
		gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#1f3f5a', wood: '#121019', pedestal: true});
		neonStrip(room, {length: 1.36, color: CYAN, x: 0, y: 0.7, z: 0.72, thickness: 0.012, intensity: 1.1});
		const seatsXZ = tableContract(room, 'T01', {...TABLE, watch: [1, 2, 3, 4]});
		for (const [sx, sz] of seatsXZ) {
			const d = Math.hypot(sx, sz);
			room.at((sx / d) * (d + 0.06), 0, (sz / d) * (d + 0.06), Math.atan2(-sx, -sz), () =>
				armchair(room, {color: '#2a1f48', cushion: '#4a2a6a', legs: '#08080c', width: 0.82}),
			);
		}
		for (const [dx, dz] of [
			[0, 1],
			[1, 0],
			[0, -1],
			[-1, 0],
		]) {
			const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
			room.at(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7, 0, () => {
				room.add(rbox(0.46, 0.46, 0.46, 0.12, 0, 0.23, 0), '#35285a');
				room.add(rbox(0.38, 0.04, 0.38, 0.02, 0, 0.47, 0), MAGENTA, {emissive: 0.35, cast: false});
			});
		}
		pendant(room, {ceiling: H, drop: 1.0, kind: 'dome', shade: '#1a1824', glow: '#ffd2f0', intensity: 1.5, range: 2.2});
	});

	onWall(room, shell, 'E', -3.4, () => door(room, {w: 1.1, h: 2.3, casing: '#0b0a10', leaf: '#171522', handle: CYAN}));
	for (const [x, z] of [
		[-6.0, -4.5],
		[6.0, -0.9],
		[-6.0, 4.5],
		[6.0, 4.5],
	])
		room.at(x, 0, z, random() * 6, () => plant(room, {random, pot: '#121019', leaf: '#2a5a4a', height: 1.4}));

	room.light(0, 2.9, 0, {color: '#8a6af0', intensity: 0.9, range: 7, shadow: false});
	room.light(-3.5, 2.7, 2.5, {color: '#ff5ac8', intensity: 0.35, range: 4, shadow: false});
	room.light(3.5, 2.6, 2.5, {color: '#5a6ae0', intensity: 0.25, range: 4, shadow: false});

	stands(room, [
		[-2.2, 0.9],
		[-1.0, 1.6],
		[-3.0, 2.4],
		[-2.0, 4.0],
		[0.0, 4.2],
		[4.4, 4.3],
		[5.6, 1.2],
		[4.4, 0.0],
		[2.2, -0.6],
		[1.0, -1.2],
		[-3.4, 0.9],
		[1.4, -4.0],
	]);
	camera(room, shell, {azimuthDeg: 34, elevationDeg: 34, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
