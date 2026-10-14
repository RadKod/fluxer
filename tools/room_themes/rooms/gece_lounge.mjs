// SPDX-License-Identifier: AGPL-3.0-or-later

// Gece Lounge: a night lounge. Dark navy walls with neon trim, a city skyline through the west windows, a back-lit
// bar with stools on the north wall, a sectional in front of the TV, a club-chair game table, a booth corner.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	armchair,
	bottle,
	box,
	coffeeTable,
	cyl,
	door,
	extrude,
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
	slab,
	sofa,
	sphere,
	stool,
	tvBezel,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 13;
const D = 10;
const H = 3.3;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const MAGENTA = '#ff3fa4';
const CYAN = '#33e0ff';
const AMBER = '#ffb45a';

function crescent(r, thickness) {
	const pts = [];
	const n = 20;
	for (let i = 0; i <= n; i++) {
		const a = Math.PI * 0.25 + (i / n) * Math.PI * 1.5;
		pts.push([Math.cos(a) * r, Math.sin(a) * r]);
	}
	for (let i = n; i >= 0; i--) {
		const a = Math.PI * 0.32 + (i / n) * Math.PI * 1.36;
		pts.push([Math.cos(a) * (r - thickness) + thickness * 0.55, Math.sin(a) * (r - thickness)]);
	}
	return pts;
}

function star(r) {
	const pts = [];
	for (let i = 0; i < 10; i++) {
		const a = Math.PI / 2 + (i / 10) * Math.PI * 2;
		const rr = i % 2 ? r * 0.42 : r;
		pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
	}
	return pts;
}

function bar(room, length, random) {
	// counter: dark front with vertical ribs, a lit underside strip, a stone top
	room.add(box(length, 1.05, 0.6, 0, 0.525, 0.9), '#1a1a22');
	for (let i = 0; i < Math.floor(length / 0.12); i++)
		room.add(box(0.05, 0.95, 0.03, -length / 2 + 0.08 + i * 0.12, 0.52, 1.21), '#2a2633');
	room.add(rbox(length + 0.1, 0.05, 0.72, 0.012, 0, 1.075, 0.92), '#d9d3c7');
	neonStrip(room, {length, color: CYAN, x: 0, y: 0.06, z: 1.23, intensity: 1.4});
	// back bar: shelves of bottles in front of a lit panel
	room.add(box(length, 0.9, 0.45, 0, 0.45, 0.24), '#15151b');
	room.add(rbox(length, 0.04, 0.5, 0.01, 0, 0.92, 0.25), '#2b2b33');
	room.add(box(length - 0.2, 1.1, 0.02, 0, 1.75, 0.02), '#ffb070', {emissive: 0.75, cast: false});
	const glass = ['#2f6b3a', '#7a3a1a', '#c9a24a', '#3a4a7a', '#8a2a4a', '#d8d0c0'];
	for (const y of [1.25, 1.75]) {
		room.add(box(length - 0.2, 0.03, 0.22, 0, y, 0.13), '#2b2b33', {cast: false});
		for (let x = -length / 2 + 0.25; x < length / 2 - 0.2; x += 0.13 + random() * 0.06)
			bottle(room, {
				x,
				y: y + 0.015,
				z: 0.13,
				color: glass[Math.floor(random() * glass.length)],
				h: 0.24 + random() * 0.1,
			});
	}
	room.add(box(length, 0.06, 0.3, 0, 2.3, 0.15), '#15151b');
	neonStrip(room, {length: length - 0.1, color: MAGENTA, x: 0, y: 2.27, z: 0.31, intensity: 1.5});
	// glasses and a shaker on the counter
	for (let i = 0; i < 6; i++)
		room.add(cyl(0.035, 0.03, 0.1, -length / 2 + 0.5 + i * 0.5, 1.1, 1.0 + (i % 2) * 0.08, 10), '#cfe3ff', {
			glass: true,
		});
}

export function buildGeceLounge() {
	const room = new Room({
		ambient: '#2a2d48',
		sky: '#454a80',
		ground: '#1c1824',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		lights: [{direction: [0.6, -0.35, 0.2], color: '#6d7bd6', intensity: 0.22, shadow: true}],
		seed: 23,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#232838'},
		baseboard: '#101018',
		ceiling: '#15161f',
		base: '#14131a',
		openings: {
			W: [
				{u: -1.9, y0: 0.45, w: 2.2, h: 2.35},
				{u: 1.1, y0: 0.45, w: 2.2, h: 2.35},
			],
			E: [{u: 3.4, y0: 0, w: 1.1, h: 2.3}],
		},
		floor(r) {
			const pw = 0.22;
			for (let row = 0; row < D / pw; row++) {
				const z = -D / 2 + pw * (row + 0.5);
				let x = -W / 2 - random() * 1.2;
				while (x < W / 2) {
					const len = 1.2 + random() * 0.6;
					const a = Math.max(x, -W / 2);
					const b = Math.min(x + len, W / 2);
					const v = random() * 0.05;
					r.add(
						box(b - a - 0.006, 0.02, pw - 0.006, (a + b) / 2, -0.01, z, [Math.max(1, Math.round((b - a) / 0.5)), 1, 1]),
						rgb(0.3 + v, 0.21 + v * 0.8, 0.16 + v * 0.5),
					);
					x += len;
				}
			}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#0a0a0e');
		},
	};
	buildShell(room, shell);

	// ceiling: a dropped dark slab with a recessed neon cove around the room
	room.useBucket('ceiling');
	room.add(slab(W - 2.4, 0.12, D - 2.4, 0, H - 0.18, 0, 0.8), '#1b1c28');
	neonStrip(room, {length: W - 2.4, color: MAGENTA, x: 0, y: H - 0.26, z: -(D - 2.4) / 2, intensity: 1.3});
	neonStrip(room, {length: W - 2.4, color: MAGENTA, x: 0, y: H - 0.26, z: (D - 2.4) / 2, intensity: 1.3});
	neonStrip(room, {length: D - 2.4, color: MAGENTA, x: -(W - 2.4) / 2, y: H - 0.26, z: 0, axis: 'z', intensity: 1.3});
	neonStrip(room, {length: D - 2.4, color: MAGENTA, x: (W - 2.4) / 2, y: H - 0.26, z: 0, axis: 'z', intensity: 1.3});
	room.useBucket('room');

	// wall trim: a cyan line along the north and west walls at 2.6 m, vertical ribs on the north wall
	for (const side of ['N', 'W', 'E', 'S'])
		onWall(room, shell, side, 0, () => {
			const length = side === 'N' || side === 'S' ? W : D;
			room.add(box(length, 0.05, 0.05, 0, 2.62, 0.025), '#0e0e14');
			neonStrip(room, {length, color: CYAN, x: 0, y: 2.6, z: 0.055, thickness: 0.02, intensity: 1.2});
		});
	onWall(room, shell, 'N', -2.9, () => {
		for (let i = 0; i < 20; i++) room.add(box(0.06, 2.5, 0.05, -3.4 + i * 0.27, 1.25, 0.025), '#1a1e2c');
		tvBezel(room, {w: 2.6, h: (2.6 * 9) / 16, y: 1.65});
		room.add(box(3.2, 0.3, 0.42, 0, 0.15, 0.21), '#15151b');
		neonStrip(room, {length: 3.1, color: MAGENTA, x: 0, y: 0.31, z: 0.43, thickness: 0.02, intensity: 1.2});
		room.light(0, 0.5, 0.6, {color: MAGENTA, intensity: 0.35, range: 1.6, shadow: false});
	});
	screen(room, shell, 'N', -2.9, {width: 2.6, y: 1.65});

	// --- north wall right: the bar and group C stools
	room.at(3.3, 0, -D / 2 + 0.02, 0, () => {
		bar(room, 4.4, random);
		room.light(0, 1.6, 0.6, {color: AMBER, intensity: 0.6, range: 1.8});
		room.light(0, 0.2, 1.5, {color: CYAN, intensity: 0.45, range: 1.4, shadow: false});
		for (const x of [-1.5, 0, 1.5])
			room.at(x, 0, 0.92, 0, () =>
				pendant(room, {ceiling: H, drop: 1.1, kind: 'globe', glow: '#ffc27a', intensity: 0.9, range: 1.7}),
			);
	});
	[-1.35, -0.45, 0.45, 1.35].forEach((x, i) =>
		room.at(3.3 + x, 0, -D / 2 + 1.75, Math.PI, () => {
			const [hx, hy, hz] = stool(room, {height: 0.74, seat: '#5a2a4a', metal: '#0e0e12'});
			room.empty(`seat_C_${String(i + 1).padStart(2, '0')}`, hx, hy, hz);
		}),
	);
	// neon sign: a crescent and a star by the bar
	onWall(room, shell, 'N', 0.0, () => {
		room.add(extrude(crescent(0.42, 0.08), 0.03, -0.1, 1.85, 0.05), MAGENTA, {emissive: 1.6, cast: false});
		room.add(extrude(star(0.14), 0.03, 0.28, 2.05, 0.05), CYAN, {emissive: 1.6, cast: false});
		room.light(0, 1.8, 0.4, {color: MAGENTA, intensity: 0.7, range: 1.6, shadow: false});
	});

	// --- west wall: floor-to-ceiling windows over the night city
	for (const u of [-1.9, 1.1])
		onWall(room, shell, 'W', u, () => {
			room.add(box(2.3, 0.08, 0.12, 0, 0.42, 0.02), '#0e0e14');
			room.add(box(2.3, 0.08, 0.12, 0, 2.84, 0.02), '#0e0e14');
			for (const s of [-1, 0, 1]) room.add(box(0.06, 2.35, 0.1, s * 1.13, 1.625, 0.02), '#0e0e14');
			room.add(quad(2.2, 2.35, 0, 1.625, -0.04), '#9db6ff', {glass: true, cast: false});
			skyline(room, random);
		});

	// --- group A: a 4 + 4 sectional in front of the TV
	const seatHeads = [];
	room.at(-3.1, 0, -1.05, Math.PI, () => {
		for (const h of sofa(room, {
			width: 3.0,
			seats: 4,
			frame: '#2a2440',
			cushion: '#3b3260',
			legs: '#0b0b10',
			pillows: [MAGENTA, CYAN],
		}))
			seatHeads.push(room.worldPoint(...h));
	});
	room.at(-5.85, 0, -3.0, Math.PI / 2, () => {
		for (const h of sofa(room, {
			width: 3.0,
			seats: 4,
			frame: '#2a2440',
			cushion: '#3b3260',
			legs: '#0b0b10',
			pillows: ['#e8c26a'],
		}))
			seatHeads.push(room.worldPoint(...h));
	});
	seatHeads
		.sort((a, b) => a.x - b.x || a.z - b.z)
		.forEach((p, i) =>
			room.empties.push({name: `seat_A_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
		);
	room.at(-3.6, 0, -2.85, 0, () => {
		rug(room, {w: 4.2, d: 3.4, color: '#1f3a4a', border: '#3a2a4a'});
		coffeeTable(room, {w: 1.4, d: 0.7, top: '#121218', legs: '#c9a24a'});
		room.add(cyl(0.08, 0.06, 0.12, 0.3, 0.4, 0.1, 10), '#c9a24a');
		room.add(sphere(0.06, -0.35, 0.46, -0.05, 10, 6), CYAN, {emissive: 1.1, cast: false});
	});
	room.at(-6.0, 0, -0.9, 0, () => floorLamp(room, {shade: '#e8d6b0', glow: '#ffc27a', intensity: 0.9, range: 2}));
	room.at(-6.1, 0, -4.5, 0, () => plant(room, {random, pot: '#1a1a22', leaf: '#2e5a3a', height: 1.5}));

	// --- group B: a three-seat sofa in the south-west corner, facing the windows' corner
	room.at(-4.6, 0, 3.0, Math.PI / 2 + 0.35, () => {
		const heads = sofa(room, {
			width: 2.3,
			seats: 3,
			frame: '#3a1f33',
			cushion: '#5a2a4a',
			legs: '#0b0b10',
			pillows: [CYAN],
		});
		heads.forEach((h, i) => room.empty(`seat_B_${String(i + 1).padStart(2, '0')}`, ...h));
	});
	room.at(-3.3, 0, 3.4, 0, () => {
		room.add(cyl(0.4, 0.4, 0.04, 0, 0.42, 0, 20), '#121218');
		room.add(cyl(0.05, 0.08, 0.42, 0, 0, 0, 10), '#c9a24a');
		room.add(cyl(0.035, 0.03, 0.12, 0.12, 0.46, 0, 10), '#cfe3ff', {glass: true});
	});
	room.at(-6.1, 0, 4.4, 0, () => floorLamp(room, {shade: '#e8d6b0', glow: '#ffc27a', intensity: 0.9, range: 2}));

	// --- group D: booth corner on the east side, a 3-seat sofa and two armchairs round a low table
	const dHeads = [];
	room.at(5.85, 0, 1.9, -Math.PI / 2, () => {
		for (const h of sofa(room, {
			width: 2.3,
			seats: 3,
			frame: '#1f2c3a',
			cushion: '#2f4a5a',
			legs: '#0b0b10',
			pillows: [AMBER, MAGENTA],
		}))
			dHeads.push(room.worldPoint(...h));
	});
	for (const [x, z, yaw] of [
		[4.3, 0.6, Math.atan2(0.4, 1.3)],
		[4.3, 3.2, Math.atan2(0.4, -1.3)],
	])
		room.at(x, 0, z, yaw, () =>
			dHeads.push(room.worldPoint(...armchair(room, {color: '#2a2440', cushion: '#3b3260', legs: '#0b0b10'})[0])),
		);
	dHeads.forEach((p, i) =>
		room.empties.push({name: `seat_D_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
	);
	room.at(4.7, 0, 1.9, 0, () => {
		room.add(cyl(0.45, 0.45, 0.05, 0, 0.38, 0, 22), '#121218');
		room.add(cyl(0.3, 0.35, 0.38, 0, 0, 0, 16), '#c9a24a');
		room.add(sphere(0.07, 0.1, 0.5, 0, 10, 6), MAGENTA, {emissive: 1.2, cast: false});
	});
	room.at(4.7, 0, 1.9, 0, () =>
		pendant(room, {
			ceiling: H,
			drop: 1.25,
			kind: 'cone',
			shade: '#c9a24a',
			glow: '#ffc27a',
			intensity: 1.0,
			range: 1.9,
		}),
	);
	room.at(6.0, 0, 4.4, 0, () => plant(room, {random, pot: '#1a1a22', leaf: '#2e5a3a', height: 1.4}));
	onWall(room, shell, 'E', 3.4, () => door(room, {w: 1.1, h: 2.3, casing: '#0e0e14', leaf: '#1d1f2c'}));
	onWall(room, shell, 'E', -1.9, () =>
		frame(room, {w: 1.4, h: 0.9, y: 1.75, color: '#0e0e14', art: [MAGENTA, '#3b3260', CYAN, '#e8c26a']}),
	);

	// --- the game table, club armchairs, poufs for the watchers
	room.at(0.9, 0, 1.4, 0, () => {
		rug(room, {w: 3.6, d: 3.6, color: '#2a2440', border: '#14131a'});
		gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#24504a', wood: '#1b1418', pedestal: true});
		const seatsXZ = tableContract(room, 'T01', {...TABLE, watch: [1, 2, 3, 4]});
		for (const [sx, sz] of seatsXZ) {
			const d = Math.hypot(sx, sz);
			room.at((sx / d) * (d + 0.06), 0, (sz / d) * (d + 0.06), Math.atan2(-sx, -sz), () =>
				armchair(room, {color: '#4a2a1f', cushion: '#6b3b2a', legs: '#0b0b10', width: 0.82}),
			);
		}
		[
			[0, 1],
			[1, 0],
			[0, -1],
			[-1, 0],
		].forEach(([dx, dz]) => {
			const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
			room.at(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7, 0, () => {
				room.add(rbox(0.46, 0.46, 0.46, 0.12, 0, 0.23, 0), '#3b3260');
				room.add(rbox(0.38, 0.04, 0.38, 0.02, 0, 0.47, 0), '#5a4a8a');
			});
		});
		pendant(room, {ceiling: H, drop: 1.0, kind: 'dome', shade: '#c9a24a', glow: '#ffd59a', intensity: 1.6, range: 2.2});
	});

	room.light(0, 2.9, 0, {color: '#8a7ae0', intensity: 0.7, range: 7, shadow: false});
	room.light(-3.5, 2.6, -3, {color: '#7a6ad0', intensity: 0.2, range: 4, shadow: false});

	stands(room, [
		[-1.0, -3.6],
		[0.4, -2.6],
		[1.2, -3.1],
		[2.6, -2.2],
		[4.4, -2.4],
		[3.2, 3.9],
		[1.0, 4.3],
		[-1.3, 3.8],
		[-1.6, 0.6],
		[3.0, -0.6],
		[-0.6, -1.4],
		[5.6, -1.0],
	]);
	camera(room, shell, {azimuthDeg: 34, elevationDeg: 34, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

// The city behind a west window (local −Z is outside): a gradient sky, towers with lit windows, a moon.
function skyline(room, random) {
	const w = 2.2;
	const y0 = 0.45;
	const h = 2.35;
	room.add(quad(w, h * 0.55, 0, y0 + h * 0.725, -0.4), '#1a1f4a', {emissive: 1, cast: false});
	room.add(quad(w, h * 0.45, 0, y0 + h * 0.225, -0.4), '#3a2350', {emissive: 1, cast: false});
	let x = -w / 2;
	while (x < w / 2 - 0.1) {
		const bw = Math.min(0.18 + random() * 0.3, w / 2 - x);
		const bh = 0.6 + random() * 1.3;
		const z = -0.25 - random() * 0.1;
		room.add(box(bw, bh, 0.03, x + bw / 2, y0 + bh / 2, z), '#0b0d1a', {emissive: 1, cast: false});
		for (let wy = y0 + 0.1; wy < y0 + bh - 0.1; wy += 0.12)
			for (let wx = x + 0.05; wx < x + bw - 0.04; wx += 0.07)
				if (random() < 0.32)
					room.add(box(0.03, 0.04, 0.01, wx, wy, z + 0.02), random() < 0.5 ? '#ffd27a' : '#9fd8ff', {
						emissive: 1.1,
						cast: false,
					});
		x += bw + 0.03;
	}
	room.add(sphere(0.09, 0.6, 2.45, -0.38, 12, 8), '#f4ecd0', {emissive: 1.2, cast: false});
	reveal(room, {w, h, y0, depth: 0.44});
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
