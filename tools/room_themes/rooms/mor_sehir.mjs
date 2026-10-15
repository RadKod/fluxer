// SPDX-License-Identifier: AGPL-3.0-or-later

// Mor Şehir: a high-floor lounge at night. The whole north wall is glass over a purple city skyline; an L sofa in
// front of the TV on the west wall, two sofas facing over a long low table by the glass, lounge chairs in the
// south-east corner and a game table in the middle.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	armchair,
	box,
	coffeeTable,
	cyl,
	door,
	floorLamp,
	frame,
	gameTable,
	neonStrip,
	pendant,
	plant,
	quad,
	rbox,
	reveal,
	rug,
	sofa,
	sphere,
	tvBezel,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 14;
const D = 10;
const H = 3.4;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const GLASS = {u: 0, y0: 0.12, w: 11.4, h: 3.0};
const PANES = 6;
const WARM = '#ffd29a';
const LILAC = '#b07aff';

// The city behind the glass wall (local −Z is outside): a three-band sky, a far row and a near row of towers with
// lit windows, red beacons on the tallest, a moon.
function skyline(room, random) {
	const {w, h, y0} = GLASS;
	const bands = [
		[0.0, 0.3, '#7a2f86'],
		[0.3, 0.6, '#45206e'],
		[0.6, 1.0, '#1e1040'],
	];
	for (const [a, b, color] of bands)
		room.add(quad(w, h * (b - a), 0, y0 + h * ((a + b) / 2), -1.05), color, {emissive: 1, cast: false});
	room.add(sphere(0.16, 3.2, y0 + h * 0.82, -1.0, 14, 9), '#f6e8ff', {emissive: 1.2, cast: false});
	const row = (z, minH, maxH, body, lit, beacon) => {
		let x = -w / 2;
		while (x < w / 2 - 0.05) {
			const bw = Math.min(0.3 + random() * 0.45, w / 2 - x);
			const bh = minH + random() * (maxH - minH);
			room.add(box(bw, bh, 0.04, x + bw / 2, y0 + bh / 2, z), body, {emissive: 1, cast: false});
			for (let wy = y0 + 0.12; wy < y0 + bh - 0.1; wy += 0.13)
				for (let wx = x + 0.06; wx < x + bw - 0.05; wx += 0.08)
					if (random() < lit)
						room.add(
							quad(0.035, 0.05, wx, wy, z + 0.025),
							['#ffd27a', '#ff8ad8', '#c49aff', '#8ad8ff'][Math.floor(random() * 4)],
							{
								emissive: 1.15,
								cast: false,
							},
						);
			if (beacon && bh > maxH * 0.8)
				room.add(sphere(0.025, x + bw / 2, y0 + bh + 0.04, z, 6, 4), '#ff3040', {emissive: 1.4, cast: false});
			x += bw + 0.02 + random() * 0.08;
		}
	};
	row(-0.85, 1.2, 2.6, '#2a1a48', 0.12, true);
	row(-0.55, 0.5, 1.6, '#120a24', 0.28, false);
	reveal(room, {w, h, y0, depth: 1.1, color: '#0c0818'});
}

export function buildMorSehir() {
	const room = new Room({
		ambient: '#2e2650',
		sky: '#4e3e84',
		ground: '#1e1834',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		lights: [{direction: [0.15, -0.35, 1], color: '#9a6ae0', intensity: 0.3, shadow: true}],
		seed: 53,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#3a3550'},
		baseboard: '#1a1726',
		ceiling: '#24212f',
		base: '#15121e',
		openings: {N: [GLASS], E: [{u: 3.6, y0: 0, w: 1.1, h: 2.3}]},
		floor(r) {
			// polished stone slabs, 1.2 × 0.6 m, running bond
			const lw = 1.2;
			const lz = 0.6;
			for (let iz = 0; iz < Math.ceil(D / lz); iz++) {
				const z0 = -D / 2 + iz * lz;
				const d = Math.min(lz, D / 2 - z0);
				let x = -W / 2 - (iz % 2 ? lw / 2 : 0);
				while (x < W / 2) {
					const a = Math.max(x, -W / 2);
					const b = Math.min(x + lw, W / 2);
					const v = 0.3 + random() * 0.04;
					r.add(
						box(b - a - 0.006, 0.02, d - 0.006, (a + b) / 2, -0.01, z0 + d / 2, [3, 1, 2]),
						rgb(v, v * 0.95, v * 1.1),
					);
					x += lw;
				}
			}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#0e0c14');
		},
	};
	buildShell(room, shell);

	// ceiling: three linear light slots running north–south
	room.useBucket('ceiling');
	for (const x of [-4.2, 0, 4.2]) {
		room.add(box(0.2, 0.06, D - 1.6, x, H - 0.03, 0), '#16141e');
		room.add(box(0.12, 0.01, D - 1.7, x, H - 0.065, 0), '#fff0d8', {emissive: 1.0, cast: false});
	}
	room.useBucket('room');

	// --- the glass wall: mullions, a header and a sill, the city behind
	onWall(room, shell, 'N', 0, () => {
		const {w, h, y0} = GLASS;
		room.add(box(w + 0.12, 0.1, 0.14, 0, y0 - 0.05, 0.02), '#15121e');
		room.add(box(w + 0.12, 0.1, 0.14, 0, y0 + h + 0.05, 0.02), '#15121e');
		for (let i = 0; i <= PANES; i++)
			room.add(box(0.06, h, 0.12, -w / 2 + (w * i) / PANES, y0 + h / 2, 0.02), '#15121e');
		room.add(quad(w, h, 0, y0 + h / 2, -0.03), '#b9a0ff', {glass: true, cast: false});
		skyline(room, random);
		for (const x of [-4.5, -1.5, 1.5, 4.5])
			room.light(x, 1.7, 0.6, {color: '#a066e8', intensity: 0.55, range: 2.6, shadow: false});
	});

	// --- west wall: TV over a long low media unit, art either side
	onWall(room, shell, 'W', 0, () => {
		tvBezel(room, {w: 2.6, h: (2.6 * 9) / 16, y: 1.7});
		room.add(rbox(3.6, 0.42, 0.45, 0.02, 0, 0.27, 0.23), '#1e1a2a');
		for (const s of [-1, 0, 1]) room.add(box(1.1, 0.3, 0.005, s * 1.18, 0.28, 0.455), '#2c2740');
		room.add(box(3.6, 0.06, 0.45, 0, 0.03, 0.23), '#0e0c14');
		neonStrip(room, {length: 3.5, color: LILAC, x: 0, y: 0.06, z: 0.46, thickness: 0.012, intensity: 1.0});
	});
	for (const u of [-2.9, 2.9])
		onWall(room, shell, 'W', u, () =>
			frame(room, {w: 0.9, h: 1.2, y: 1.6, color: '#15121e', art: ['#7a2f86', '#c49aff', '#45206e']}),
		);
	screen(room, shell, 'W', 0, {width: 2.6, y: 1.7});

	// --- group A: an L sofa facing the TV
	const heads = [];
	const lounge = (x, z, yaw, width, seats, pillows) =>
		room.at(x, 0, z, yaw, () => {
			for (const h of sofa(room, {
				width,
				seats,
				frame: '#4a4458',
				cushion: '#6a6280',
				legs: '#0e0c14',
				pillows,
				armWidth: 0.16,
				backHeight: 0.8,
			}))
				heads.push(room.worldPoint(...h));
		});
	lounge(-2.4, -0.2, -Math.PI / 2, 3.0, 4, [LILAC, '#e8c0e0']);
	lounge(-4.0, 2.05, Math.PI, 2.3, 3, ['#e8c0e0']);
	heads
		.sort((a, b) => a.z - b.z || a.x - b.x)
		.forEach((p, i) =>
			room.empties.push({name: `seat_A_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
		);
	room.at(-4.3, 0, -0.1, 0, () => {
		rug(room, {w: 3.4, d: 4.0, color: '#2a2240', border: '#4a3a6a'});
		coffeeTable(room, {w: 0.8, d: 1.6, h: 0.36, top: '#e8e2ee', legs: '#15121e'});
		room.add(cyl(0.12, 0.1, 0.06, 0, 0.36, 0.3, 14), '#2c2740');
		room.add(sphere(0.05, 0, 0.42, -0.35, 10, 6), WARM, {emissive: 1.1, cast: false});
	});
	room.at(-6.2, 0, 2.9, 0, () =>
		floorLamp(room, {shade: '#efe6f4', metal: '#15121e', glow: WARM, intensity: 0.9, range: 2.2}),
	);

	// --- group B: two sofas facing each other over a long table, by the glass
	const b = [];
	for (const [x, yaw] of [
		[1.25, Math.PI / 2],
		[4.35, -Math.PI / 2],
	])
		room.at(x, 0, -3.25, yaw, () => {
			for (const h of sofa(room, {
				width: 2.3,
				seats: 3,
				frame: '#2c2740',
				cushion: '#4a3d6e',
				legs: '#0e0c14',
				pillows: [LILAC],
				armWidth: 0.16,
				backHeight: 0.8,
			}))
				b.push(room.worldPoint(...h));
		});
	b.sort((p, q) => p.x - q.x || p.z - q.z).forEach((p, i) =>
		room.empties.push({name: `seat_B_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
	);
	room.at(2.8, 0, -3.25, 0, () => {
		coffeeTable(room, {w: 0.8, d: 1.9, h: 0.36, top: '#15121e', legs: '#8a7aa0'});
		for (const z of [-0.5, 0.1, 0.55])
			room.add(cyl(0.035, 0.03, 0.12, (random() - 0.5) * 0.3, 0.36, z, 10), '#e0d8ff', {glass: true});
		room.add(sphere(0.06, 0.1, 0.42, -0.1, 10, 6), WARM, {emissive: 1.1, cast: false});
	});
	room.at(2.8, 0, -3.25, 0, () =>
		pendant(room, {ceiling: H, drop: 1.3, kind: 'globe', glow: WARM, intensity: 0.8, range: 2.0}),
	);

	// --- group C: four lounge chairs round a low drum table
	const c = [];
	room.at(5.0, 0, 2.7, 0, () => {
		rug(room, {w: 2.8, d: 2.8, color: '#3a2f52', border: '#2a2240'});
		room.add(cyl(0.38, 0.38, 0.42, 0, 0, 0, 20), '#e8e2ee');
		room.add(sphere(0.05, 0.1, 0.47, 0, 10, 6), LILAC, {emissive: 1.2, cast: false});
		for (let i = 0; i < 4; i++) {
			const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
			room.at(Math.sin(a) * 1.0, 0, Math.cos(a) * 1.0, a + Math.PI, () =>
				c.push(
					room.worldPoint(...armchair(room, {color: '#5a4a72', cushion: '#7a68a0', legs: '#0e0c14', width: 0.8})[0]),
				),
			);
		}
		pendant(room, {ceiling: H, drop: 1.2, kind: 'cone', shade: '#d8d0e8', glow: WARM, intensity: 0.9, range: 2.0});
	});
	c.forEach((p, i) =>
		room.empties.push({name: `seat_C_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
	);

	// --- the game table
	room.at(0.6, 0, 2.2, 0, () => {
		gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#3a2a5a', wood: '#15121e', pedestal: true});
		const seatsXZ = tableContract(room, 'T01', {...TABLE, watch: [1, 2, 3, 4]});
		for (const [sx, sz] of seatsXZ) {
			const d = Math.hypot(sx, sz);
			room.at((sx / d) * (d + 0.06), 0, (sz / d) * (d + 0.06), Math.atan2(-sx, -sz), () =>
				armchair(room, {color: '#2c2740', cushion: '#4a3d6e', legs: '#0e0c14', width: 0.8}),
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
				room.add(cyl(0.22, 0.22, 0.42, 0, 0, 0, 14), '#6a6280');
				room.add(cyl(0.2, 0.2, 0.04, 0, 0.42, 0, 14), '#8a80a8');
			});
		}
		pendant(room, {ceiling: H, drop: 1.05, kind: 'dome', shade: '#1e1a2a', glow: WARM, intensity: 1.5, range: 2.2});
	});

	// --- east wall: door, a bar cart, a plant
	onWall(room, shell, 'E', 3.6, () =>
		door(room, {w: 1.1, h: 2.3, casing: '#15121e', leaf: '#2c2740', handle: '#c9a24a'}),
	);
	onWall(room, shell, 'E', 0.6, () =>
		frame(room, {w: 1.6, h: 1.0, y: 1.7, color: '#15121e', art: ['#45206e', '#ff8ad8', '#7a2f86', '#c49aff']}),
	);
	room.at(6.55, 0, -0.9, -Math.PI / 2, () => {
		for (const y of [0.25, 0.8]) room.add(rbox(0.8, 0.03, 0.42, 0.01, 0, y, 0), '#c9a24a');
		for (const sx of [-1, 1])
			for (const sz of [-1, 1]) room.add(cyl(0.012, 0.012, 0.85, sx * 0.38, 0, sz * 0.19, 6), '#c9a24a');
		for (let i = 0; i < 5; i++)
			room.add(
				cyl(0.035, 0.035, 0.26, -0.3 + i * 0.15, 0.815, 0, 8),
				['#7a2f86', '#e8e0d0', '#2f6b3a', '#c9a24a', '#8a2a4a'][i],
			);
	});
	for (const [x, z, height] of [
		[-6.4, -4.4, 1.6],
		[6.4, -4.4, 1.5],
		[6.4, 4.5, 1.3],
		[-6.4, 4.5, 1.4],
	])
		room.at(x, 0, z, random() * 6, () => plant(room, {random, pot: '#e8e2ee', leaf: '#2e5a3a', height}));

	room.light(0, 3.0, 0, {color: '#ffe0c0', intensity: 0.55, range: 7, shadow: false});
	room.light(-4.2, 3.0, 0, {color: '#ffe0c0', intensity: 0.3, range: 4, shadow: false});
	room.light(4.2, 3.0, 0, {color: '#ffe0c0', intensity: 0.3, range: 4, shadow: false});

	stands(room, [
		[-1.0, -3.6],
		[-3.4, -3.6],
		[-5.6, -3.4],
		[0.0, -1.4],
		[2.8, -1.0],
		[5.6, -0.9],
		[3.0, 4.3],
		[0.9, 4.4],
		[-1.7, 4.3],
		[-4.6, 4.1],
		[-0.9, 0.2],
		[6.0, 0.9],
	]);
	camera(room, shell, {azimuthDeg: 32, elevationDeg: 33, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
