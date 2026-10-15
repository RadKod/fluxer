// SPDX-License-Identifier: AGPL-3.0-or-later

// Mahalle Kahvesi: an old neighbourhood coffeehouse late in the evening. Faded mint walls over dark wood panelling,
// bare tungsten bulbs, a kilim on the west wall over a wooden bench, a tea stove counter in the north-east corner,
// an old radio on a shelf, the TV in a wooden cabinet frame, two okey tables and a row of small tea tables.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	box,
	cafeChair,
	cyl,
	cylX,
	cylZ,
	door,
	frame,
	gameTable,
	lathe,
	plant,
	quad,
	rbox,
	sphere,
	squareTable,
	stool,
	wallClock,
	windowUnit,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 13;
const D = 10;
const H = 3.3;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const BULB = '#ffb35c';
const WOOD = '#5a3820';
const DARK = '#3a2414';

function teaGlass(room, x, y, z) {
	room.add(cyl(0.045, 0.045, 0.006, x, y, z, 10), '#e0d4b8');
	room.add(
		lathe(
			[
				[0, 0.007],
				[0.018, 0.007],
				[0.024, 0.03],
				[0.016, 0.052],
				[0.024, 0.08],
				[0, 0.08],
			],
			x,
			y,
			z,
			8,
		),
		'#8a2008',
	);
}

// Two stacked teapots on a burner, the Turkish çaydanlık.
function caydanlik(room, x, y, z) {
	room.add(cyl(0.14, 0.15, 0.08, x, y, z, 14), '#2a2420');
	const pot = (py, r, color) =>
		room.add(
			lathe(
				[
					[0, 0],
					[r * 0.85, 0],
					[r, r * 0.6],
					[r * 0.8, r * 1.15],
					[r * 0.35, r * 1.3],
					[0, r * 1.3],
				],
				x,
				py,
				z,
				14,
			),
			color,
		);
	pot(y + 0.08, 0.14, '#c8ccd0');
	pot(y + 0.08 + 0.18, 0.09, '#d8dce0');
	room.add(cylZ(0.012, 0.12, x, y + 0.16, z + 0.15, 6), '#c8ccd0');
	room.add(sphere(0.06, x, y + 0.04, z + 0.1, 8, 5), '#ff7a30', {emissive: 0.9, cast: false});
}

function radio(room, y) {
	room.add(box(0.9, 0.04, 0.3, 0, y, 0.15), WOOD);
	for (const s of [-1, 1]) room.add(box(0.04, 0.18, 0.04, s * 0.35, y - 0.11, 0.04), DARK);
	room.add(rbox(0.56, 0.34, 0.22, 0.04, -0.08, y + 0.19, 0.13), '#6e4024');
	room.add(box(0.3, 0.22, 0.01, -0.16, y + 0.19, 0.245), '#c9b48a');
	for (let i = 0; i < 6; i++) room.add(box(0.29, 0.008, 0.004, -0.16, y + 0.1 + i * 0.035, 0.252), '#8a6a44');
	room.add(box(0.13, 0.05, 0.01, 0.07, y + 0.27, 0.245), '#ffc070', {emissive: 0.9, cast: false});
	for (const kx of [0.03, 0.12]) room.add(cylZ(0.022, 0.03, kx, y + 0.12, 0.255, 10), '#2a1a10');
	room.add(
		cylX(0.004, 0.5, -0.1, y + 0.6, 0.13, 4)
			.rotateZ(0.5)
			.translate(0.25, -0.12, 0),
		'#8a8a8a',
	);
}

// A kilim hung on a wall: border, field, a row of diamonds.
function kilim(room, w, h, y) {
	room.add(box(w, h, 0.015, 0, y, 0.0075), '#7a1e1a');
	room.add(box(w - 0.16, h - 0.16, 0.004, 0, y, 0.017), '#b8402a');
	for (const s of [-1, 1]) room.add(box(w - 0.3, 0.05, 0.003, 0, y + s * (h / 2 - 0.2), 0.02), '#e8c070');
	const n = 4;
	for (let i = 0; i < n; i++) {
		const x = -w / 2 + 0.3 + ((w - 0.6) * (i + 0.5)) / n;
		room.add(
			box(0.32, 0.32, 0.003, x, y, 0.021)
				.rotateZ(Math.PI / 4)
				.translate(0, 0, 0),
			'#2a3a6a',
		);
		room.add(box(0.18, 0.18, 0.003, x, y, 0.024), '#e8c070');
		room.add(box(0.08, 0.08, 0.003, x, y, 0.027), '#7a1e1a');
	}
	for (let i = 0; i < Math.round(w / 0.05); i++)
		for (const s of [-1, 1])
			room.add(box(0.012, 0.06, 0.004, -w / 2 + 0.03 + i * 0.05, y + s * (h / 2 + 0.03), 0.01), '#d8c8a0');
}

// The peyke: a plain wooden bench along a wall (back on z = 0) with thin cushions; returns the head points.
function peyke(room, length, seats) {
	room.add(box(length, 0.06, 0.6, 0, 0.4, 0.32), WOOD);
	room.add(box(length, 0.34, 0.04, 0, 0.2, 0.6), DARK);
	for (const s of [-1, 1]) room.add(box(0.06, 0.4, 0.6, s * (length / 2 - 0.03), 0.2, 0.32), DARK);
	room.add(box(length, 0.5, 0.04, 0, 0.72, 0.03), WOOD);
	const colors = ['#2a4a6a', '#7a2a24', '#2a4a6a', '#7a2a24', '#2a4a6a'];
	const heads = [];
	for (let i = 0; i < seats; i++) {
		const x = -length / 2 + (length / seats) * (i + 0.5);
		room.add(rbox(length / seats - 0.03, 0.07, 0.54, 0.03, x, 0.465, 0.33), colors[i % colors.length]);
		room.add(rbox(length / seats - 0.08, 0.36, 0.1, 0.04, x, 0.72, 0.1).rotateX(-0.1), colors[(i + 1) % colors.length]);
		heads.push([x, 0.5 + 0.64, 0.38]);
	}
	return heads;
}

function bulb(room, x, z, drop, intensity = 0.9, range = 2.2) {
	room.at(x, 0, z, 0, () => {
		const y = H - drop;
		room.add(cyl(0.004, 0.004, drop, 0, y, 0, 4), '#151515', {cast: false});
		room.add(cyl(0.025, 0.025, 0.05, 0, y - 0.05, 0, 8), '#2a2420', {cast: false});
		room.add(sphere(0.055, 0, y - 0.1, 0, 10, 7), '#ffd9a0', {emissive: 1.3, cast: false});
		room.light(0, y - 0.15, 0, {color: BULB, intensity, range, radius: 0.06});
	});
}

export function buildMahalleKahvesi() {
	const room = new Room({
		ambient: '#3a2616',
		sky: '#6a4c30',
		ground: '#2e1e12',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		seed: 67,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#8fb39a'},
		wainscot: {color: '#4e301a', height: 1.2, cap: '#2e1c0e'},
		baseboard: '#24160c',
		crown: '#7a5a3a',
		ceiling: '#c8bc9c',
		base: '#2e2018',
		openings: {
			W: [{u: -3.3, y0: 1.0, w: 1.3, h: 1.5}],
			E: [{u: -3.0, y0: 0, w: 1.1, h: 2.3}],
		},
		floor(r) {
			const pw = 0.18;
			for (let row = 0; row < D / pw; row++) {
				const z = -D / 2 + pw * (row + 0.5);
				let x = -W / 2 - random() * 1.5;
				while (x < W / 2) {
					const len = 1.4 + random() * 0.8;
					const a = Math.max(x, -W / 2);
					const b = Math.min(x + len, W / 2);
					const v = random() * 0.06;
					r.add(
						box(b - a - 0.006, 0.02, pw - 0.006, (a + b) / 2, -0.01, z, [Math.max(1, Math.round((b - a) / 0.5)), 1, 1]),
						rgb(0.36 + v, 0.23 + v * 0.7, 0.14 + v * 0.4),
					);
					x += len;
				}
			}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#1e140c');
		},
	};
	buildShell(room, shell);

	// ceiling: plain boards and a slow fan
	room.useBucket('ceiling');
	for (let i = 0; i < 7; i++) room.add(box(0.1, 0.06, D, -W / 2 + 0.9 + i * 1.9, H - 0.03, 0), '#9a8a68');
	room.useBucket('room');
	room.at(0.4, 0, -1.2, 0, () => {
		room.add(cyl(0.012, 0.012, 0.5, 0, H - 0.5, 0, 6), '#2a2420', {cast: false});
		room.add(cyl(0.11, 0.09, 0.12, 0, H - 0.62, 0, 12), '#3a3028');
		for (let i = 0; i < 4; i++)
			room.add(
				box(0.62, 0.012, 0.12, 0.42, 0, 0)
					.rotateY((i * Math.PI) / 2 + 0.3)
					.translate(0, H - 0.58, 0),
				'#5a3820',
				{cast: false},
			);
	});

	// --- north wall: the TV in a wooden cabinet frame, the radio shelf, a calendar and a clock
	onWall(room, shell, 'N', -1.0, () => {
		const w = 2.0;
		const h = (w * 9) / 16;
		room.add(rbox(w + 0.5, h + 0.3, 0.12, 0.05, 0.12, 2.2, 0.06), '#6e4024');
		room.add(box(w + 0.06, h + 0.06, 0.02, 0, 2.2, 0.125), '#1a1410');
		for (const ky of [2.45, 2.25]) room.add(cylZ(0.045, 0.04, w / 2 + 0.23, ky, 0.13, 12), '#c9a24a');
		for (let i = 0; i < 5; i++) room.add(box(0.14, 0.008, 0.004, w / 2 + 0.23, 1.92 + i * 0.03, 0.124), '#2a1a10');
		room.add(box(1.2, 0.04, 0.4, 0, 1.55, 0.2), WOOD);
		for (const s of [-1, 1]) room.add(box(0.04, 0.25, 0.3, s * 0.5, 1.42, 0.15), DARK);
	});
	screen(room, shell, 'N', -1.0, {width: 2.0, y: 2.2});
	onWall(room, shell, 'N', -4.4, () => {
		radio(room, 1.6);
		frame(room, {w: 0.5, h: 0.65, y: 2.35, color: DARK, art: ['#8a7a5a', '#5a4a3a']});
	});
	onWall(room, shell, 'N', 1.9, () => {
		wallClock(room, {y: 2.55, r: 0.2, face: '#f2e6c8', rim: DARK});
		room.add(box(0.4, 0.55, 0.01, 0, 1.75, 0.005), '#f2ece0');
		room.add(box(0.4, 0.12, 0.012, 0, 1.97, 0.008), '#b02a20');
		for (let i = 0; i < 5; i++) room.add(box(0.3, 0.012, 0.003, 0, 1.85 - i * 0.07, 0.012), '#7a7064');
	});

	// --- north-east: the tea stove counter, shelves of glasses, group C stools
	room.at(4.6, 0, -D / 2 + 0.02, 0, () => {
		room.add(box(3.2, 0.98, 0.62, 0, 0.49, 0.31), WOOD);
		for (let i = 0; i < 5; i++) room.add(box(0.56, 0.66, 0.01, -1.28 + i * 0.64, 0.46, 0.625), '#6e4428');
		room.add(rbox(3.26, 0.04, 0.68, 0.01, 0, 1.0, 0.33), '#d8d0c0');
		caydanlik(room, 0.9, 1.02, 0.3);
		caydanlik(room, 0.35, 1.02, 0.25);
		room.add(cyl(0.16, 0.17, 0.012, -0.6, 1.02, 0.4, 16), '#b8862e');
		for (const [x, z] of [
			[-0.7, 0.35],
			[-0.55, 0.45],
			[-0.62, 0.3],
			[-0.48, 0.34],
		])
			teaGlass(room, x, 1.032, z);
		for (const [i, y] of [1.6, 2.0].entries()) {
			room.add(box(3.0, 0.035, 0.24, 0, y, 0.12), WOOD);
			for (let k = 0; k < 16; k++) teaGlass(room, -1.4 + k * 0.185 + (i ? 0.09 : 0), y + 0.018, 0.12);
		}
		room.add(box(1.0, 0.3, 0.02, -0.9, 2.55, 0.01), '#e8dcc0');
		room.add(box(0.9, 0.08, 0.004, -0.9, 2.55, 0.022), '#7a1e1a');
		room.light(0.6, 1.5, 0.5, {color: '#ff8a40', intensity: 0.35, range: 1.2, shadow: false});
	});
	[3.6, 4.6, 5.6].forEach((x, i) =>
		room.at(x, 0, -D / 2 + 1.05, Math.PI, () => {
			const [hx, hy, hz] = stool(room, {height: 0.7, seat: '#6e4024', metal: '#2a1a10'});
			room.empty(`seat_C_${String(i + 1).padStart(2, '0')}`, hx, hy, hz);
		}),
	);
	bulb(room, 4.6, -3.9, 1.0, 0.8, 1.8);

	// --- west wall: a street window, the kilim over the peyke (group B) and its low table
	onWall(room, shell, 'W', -3.3, () =>
		windowUnit(room, {
			w: 1.3,
			h: 1.5,
			sill: 1.0,
			frame: '#4e301a',
			backdropFn: ({w, h, y0}) => {
				room.add(quad(w, h * 0.5, 0, y0 + h * 0.75, -0.35), '#2a2a52', {emissive: 1, cast: false});
				room.add(quad(w, h * 0.5, 0, y0 + h * 0.25, -0.36), '#5a3a4a', {emissive: 1, cast: false});
				room.add(box(0.5, 0.9, 0.02, -0.3, y0 + 0.45, -0.33), '#1a1420', {emissive: 1, cast: false});
				room.add(box(0.12, 0.14, 0.01, -0.3, y0 + 0.5, -0.32), '#ffc070', {emissive: 1.1, cast: false});
				room.add(sphere(0.05, 0.4, y0 + 1.0, -0.33, 8, 5), '#ffe0a0', {emissive: 1.3, cast: false});
			},
		}),
	);
	onWall(room, shell, 'W', 0.5, () => kilim(room, 2.6, 1.3, 1.95));
	room.at(-W / 2 + 0.01, 0, 0.5, Math.PI / 2, () => {
		peyke(room, 3.2, 4).forEach((h, i) => room.empty(`seat_B_${String(i + 1).padStart(2, '0')}`, ...h));
		room.at(0, 0, 1.05, 0, () => {
			squareTable(room, {size: 0.5, height: 0.42, top: '#7a4e2e', legs: DARK});
			teaGlass(room, -0.1, 0.42, 0);
			teaGlass(room, 0.1, 0.42, 0.06);
			room.add(cyl(0.06, 0.05, 0.03, 0.02, 0.42, -0.12, 10), '#e8e4dc');
		});
	});
	bulb(room, -5.3, 0.5, 1.1, 0.9, 2.4);

	// --- the okey tables T01 and T02 with café chairs, stools for the watchers, a bare bulb above each
	[-2.4, 1.4].forEach((x, i) => {
		const slot = `T0${i + 1}`;
		room.at(x, 0, 1.2, 0, () => {
			gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#3a6a4a', wood: WOOD});
			const seatsXZ = tableContract(room, slot, {...TABLE, watch: [1, 2]});
			for (const [sx, sz] of seatsXZ) {
				const d = Math.hypot(sx, sz);
				room.at((sx / d) * (d + 0.03), 0, (sz / d) * (d + 0.03), Math.atan2(-sx, -sz), () =>
					cafeChair(room, {height: 0.44, wood: '#4a2c16', seat: '#6e4024'}),
				);
			}
			for (const [dx, dz] of [
				[0, 1],
				[1, 0],
			]) {
				const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
				room.at(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7, 0, () =>
					stool(room, {height: 1.13 - 0.64 - 0.08, seat: '#6e4024', metal: '#2a1a10', radius: 0.16}),
				);
			}
		});
		bulb(room, x, 1.2, 1.25, 1.5, 2.3);
	});

	// --- group A: four small tea tables along the south wall, two café chairs each
	[-4.9, -1.9, 1.1, 4.1].forEach((x, t) =>
		room.at(x, 0, 4.0, 0, () => {
			squareTable(room, {size: 0.6, height: 0.72, top: '#7a4e2e', legs: DARK});
			teaGlass(room, -0.1, 0.72, 0.05);
			teaGlass(room, 0.12, 0.72, -0.06);
			[-1, 1].forEach((s, k) =>
				room.at(s * 0.6, 0, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2, () => {
					const [hx, hy, hz] = cafeChair(room, {height: 0.44, wood: '#4a2c16', seat: '#6e4024'});
					room.empty(`seat_A_${String(t * 2 + k + 1).padStart(2, '0')}`, hx, hy, hz);
				}),
			);
			bulb(room, 0, 0, 1.35, 0.8, 1.8);
		}),
	);

	// --- east wall: the door, a drinks cooler, a mirror, coat hooks
	onWall(room, shell, 'E', -3.0, () =>
		door(room, {w: 1.1, h: 2.3, casing: DARK, leaf: '#6e4428', handle: '#c9a24a', glass: true}),
	);
	onWall(room, shell, 'E', 0.3, () => {
		room.add(box(0.7, 1.8, 0.6, 0, 0.9, 0.3), '#c83a2a');
		room.add(box(0.56, 1.3, 0.01, 0, 1.0, 0.605), '#e8f4ff', {emissive: 0.7, cast: false});
		for (let i = 0; i < 4; i++)
			for (let k = 0; k < 4; k++)
				room.add(
					cyl(0.03, 0.03, 0.2, -0.2 + k * 0.13, 0.45 + i * 0.32, 0.5, 6),
					['#3a7a3a', '#c8a020', '#7a2a1a', '#e8e0d0'][(i + k) % 4],
				);
		room.add(box(0.7, 0.25, 0.02, 0, 1.92, 0.6), '#f2ece0');
	});
	onWall(room, shell, 'E', 2.0, () => {
		room.add(rbox(0.7, 0.9, 0.04, 0.03, 0, 1.75, 0.02), DARK);
		room.add(box(0.6, 0.8, 0.005, 0, 1.75, 0.045), '#a8b8c0');
		room.add(box(1.2, 0.06, 0.04, 0, 1.15, 0.02), DARK);
		for (let i = 0; i < 4; i++)
			room.add(cyl(0.012, 0.012, 0.1, -0.45 + i * 0.3, 1.15, 0.06, 6).rotateX(Math.PI / 2.4), '#b8862e');
	});
	for (const [x, z] of [
		[-6.0, -4.5],
		[6.0, 4.5],
		[-6.0, 4.5],
	])
		room.at(x, 0, z, random() * 6, () => plant(room, {random, pot: '#a0583a', height: 1.1}));

	room.light(0, 3.0, 0.5, {color: '#ffc88a', intensity: 0.45, range: 7, shadow: false});

	stands(room, [
		[-4.0, -1.6],
		[-2.4, -2.4],
		[-0.2, -2.2],
		[1.8, -2.4],
		[3.4, -2.2],
		[5.6, -1.6],
		[5.6, 0.6],
		[4.4, 1.8],
		[5.4, 2.8],
		[3.4, 2.6],
		[-0.5, -0.6],
		[-0.3, 3.3],
	]);
	camera(room, shell, {azimuthDeg: 30, elevationDeg: 35, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
