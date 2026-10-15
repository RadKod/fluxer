// SPDX-License-Identifier: AGPL-3.0-or-later

// Yönetim Ofisi: a corner executive office at sunset. Marble floor, walnut panelling with gold trim, built-in
// bookshelves either side of the TV, a dark wood desk with a leather chair, a Chesterfield set facing the TV, a
// conference table on the east side, a card table, and two tall windows on the west wall over the city at dusk.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	armchair,
	bookshelf,
	box,
	coffeeTable,
	cyl,
	door,
	floorLamp,
	frame,
	gameTable,
	lathe,
	plant,
	quad,
	rbox,
	reveal,
	rug,
	sofa,
	sphere,
	torus,
	tvBezel,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 13;
const D = 10;
const H = 3.4;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const GOLD = '#c9a24a';
const WALNUT = '#3a2214';
const LEATHER = '#5a2418';
const LEATHER_LIGHT = '#6e3020';
const WINDOWS = [-2.2, 1.6];
const WIN = {w: 2.4, h: 2.4, y0: 0.5};

// A swivel chair in leather: five-star base, a column, seat, back and arms; the sitter faces +Z.
function officeChair(room, {back = 0.75, leather = LEATHER} = {}) {
	for (let i = 0; i < 5; i++) room.add(box(0.3, 0.03, 0.05, 0.15, 0.06, 0).rotateY((i * Math.PI * 2) / 5), '#1a1a1c');
	room.add(cyl(0.025, 0.03, 0.34, 0, 0.06, 0, 8), '#2a2a2c');
	room.add(rbox(0.54, 0.1, 0.5, 0.04, 0, 0.45, 0.02), leather);
	room.add(rbox(0.5, back, 0.1, 0.05, 0, 0.5 + back / 2, -0.24).rotateX(0), leather);
	for (const s of [-1, 1]) {
		room.add(rbox(0.06, 0.04, 0.36, 0.015, s * 0.29, 0.66, 0.02), leather);
		room.add(box(0.03, 0.18, 0.03, s * 0.29, 0.56, -0.04), GOLD);
	}
	return [0, 0.5 + 0.64, 0.04];
}

function desk(room) {
	room.add(rbox(1.9, 0.05, 0.9, 0.01, 0, 0.75, 0), WALNUT);
	for (const s of [-1, 1]) {
		room.add(box(0.5, 0.7, 0.8, s * 0.68, 0.37, 0), '#2e1a0e');
		for (let i = 0; i < 3; i++) {
			room.add(box(0.44, 0.19, 0.01, s * 0.68, 0.14 + i * 0.22, -0.405), '#4a2c18');
			room.add(box(0.1, 0.012, 0.012, s * 0.68, 0.18 + i * 0.22, -0.415), GOLD);
		}
	}
	room.add(box(0.86, 0.5, 0.03, 0, 0.45, 0.38), '#2e1a0e');
	room.add(box(1.92, 0.02, 0.02, 0, 0.78, 0.45), GOLD);
	// leather blotter, banker's lamp, a pen stand, a laptop
	room.add(box(0.7, 0.006, 0.45, 0, 0.778, -0.05), '#1e2a20');
	room.at(-0.65, 0.775, -0.2, 0, () => {
		room.add(cyl(0.06, 0.07, 0.02, 0, 0, 0, 12), GOLD);
		room.add(cyl(0.01, 0.01, 0.3, 0, 0.02, 0, 6), GOLD);
		room.add(
			lathe(
				[
					[0.16, 0],
					[0.12, 0.06],
					[0.0, 0.08],
				],
				0,
				0.28,
				0.02,
				12,
			)
				.scale(1, 1, 0.5)
				.translate(0, 0, 0.0),
			'#1e5a3a',
		);
		room.add(box(0.26, 0.01, 0.05, 0, 0.28, 0.02), '#ffe0a0', {emissive: 1.2, cast: false});
		room.light(0, 0.25, 0.1, {color: '#ffd090', intensity: 0.45, range: 1.2, radius: 0.05});
	});
	room.add(box(0.36, 0.015, 0.24, 0.45, 0.785, -0.05), '#2a2a2e');
	room.add(box(0.36, 0.22, 0.012, 0.45, 0.9, -0.17).rotateX(0), '#2a2a2e');
	room.add(cyl(0.035, 0.035, 0.1, 0.8, 0.775, -0.25, 10), GOLD);
}

function globe(room) {
	room.add(cyl(0.2, 0.22, 0.03, 0, 0, 0, 14), WALNUT);
	room.add(cyl(0.025, 0.03, 0.7, 0, 0.03, 0, 8), WALNUT);
	room.add(sphere(0.24, 0, 0.98, 0, 16, 12), '#5a7a8a');
	room.add(torus(0.27, 0.012, 0, 0.98, 0, 4, 28).rotateY(0.4), GOLD);
}

// The city at dusk behind a west window (local −Z is outside).
function dusk(room, random) {
	const {w, h, y0} = WIN;
	const bands = [
		[0.0, 0.3, '#f0a050'],
		[0.3, 0.55, '#c0605a'],
		[0.55, 0.8, '#6a3a6a'],
		[0.8, 1.0, '#2e2450'],
	];
	for (const [a, b, color] of bands)
		room.add(quad(w, h * (b - a), 0, y0 + h * ((a + b) / 2), -0.5), color, {emissive: 1, cast: false});
	room.add(sphere(0.12, -0.5, y0 + 0.55, -0.48, 12, 8), '#ffe0a0', {emissive: 1.3, cast: false});
	let x = -w / 2;
	while (x < w / 2 - 0.05) {
		const bw = Math.min(0.2 + random() * 0.35, w / 2 - x);
		const bh = 0.3 + random() * 1.1;
		const z = -0.3 - random() * 0.12;
		room.add(box(bw, bh, 0.03, x + bw / 2, y0 + bh / 2, z), '#2a1e28', {emissive: 1, cast: false});
		for (let wy = y0 + 0.08; wy < y0 + bh - 0.08; wy += 0.11)
			for (let wx = x + 0.05; wx < x + bw - 0.04; wx += 0.07)
				if (random() < 0.25) room.add(quad(0.03, 0.04, wx, wy, z + 0.02), '#ffc870', {emissive: 1.1, cast: false});
		x += bw + 0.03;
	}
	reveal(room, {w, h, y0, depth: 0.55, color: '#1a1410'});
}

export function buildYonetimOfisi() {
	const room = new Room({
		ambient: '#3a2e26',
		sky: '#76604c',
		ground: '#3a2e24',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		lights: [{direction: [1, -0.3, 0.15], color: '#ffa860', intensity: 0.45, shadow: true}],
		seed: 79,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#5a3a26'},
		wainscot: {color: '#2e1a0e', height: 1.05, cap: GOLD},
		baseboard: '#1e120a',
		crown: GOLD,
		ceiling: '#e6dccb',
		base: '#2a2420',
		openings: {
			W: WINDOWS.map((u) => ({u, ...WIN})),
			E: [{u: 3.6, y0: 0, w: 1.1, h: 2.3}],
		},
		floor(r) {
			// marble tiles with a few veins
			const tile = 0.8;
			for (let ix = 0; ix < Math.ceil(W / tile); ix++)
				for (let iz = 0; iz < Math.ceil(D / tile); iz++) {
					const x0 = -W / 2 + ix * tile;
					const z0 = -D / 2 + iz * tile;
					const w = Math.min(tile, W / 2 - x0);
					const d = Math.min(tile, D / 2 - z0);
					const v = (ix + iz) % 2 ? 0.86 : 0.8;
					const j = random() * 0.03;
					r.add(
						box(w - 0.006, 0.02, d - 0.006, x0 + w / 2, -0.01, z0 + d / 2, [2, 1, 2]),
						rgb(v + j, v * 0.96 + j, v * 0.9 + j),
					);
					if (random() < 0.45)
						r.add(
							box(Math.min(w, d) * (0.5 + random() * 0.6), 0.002, 0.012)
								.rotateY(random() * Math.PI)
								.translate(x0 + w / 2, 0.001, z0 + d / 2),
							'#9a9288',
							{cast: false},
						);
				}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#4a4038');
		},
	};
	buildShell(room, shell);

	// ceiling: coffers in walnut, a warm cove in the middle
	room.useBucket('ceiling');
	for (let i = 1; i < 5; i++) room.add(box(0.14, 0.16, D, -W / 2 + (i * W) / 5, H - 0.08, 0), WALNUT);
	for (let i = 1; i < 4; i++) room.add(box(W, 0.16, 0.14, 0, H - 0.08, -D / 2 + (i * D) / 4), WALNUT);
	room.add(box(4.0, 0.02, 2.0, -0.5, H - 0.17, -0.6), '#ffe8c8', {emissive: 0.9, cast: false});
	room.useBucket('room');

	// panelling: vertical gold-edged panels above the wainscot on N and E walls
	for (const [side, length] of [
		['N', W],
		['E', D],
	])
		onWall(room, shell, side, 0, () => {
			for (let u = -length / 2 + 0.6; u < length / 2 - 0.4; u += 1.2)
				room.add(box(0.02, 1.9, 0.02, u, 2.05, 0.01), '#4a2c18');
		});

	// --- north wall: TV between two built-in bookshelves
	onWall(room, shell, 'N', -0.5, () => {
		tvBezel(room, {w: 2.4, h: (2.4 * 9) / 16, y: 1.75});
		room.add(box(2.8, 0.45, 0.45, 0, 0.225, 0.225), WALNUT);
		room.add(box(2.82, 0.02, 0.46, 0, 0.45, 0.23), GOLD);
		for (const s of [-1, 1]) room.add(box(0.03, 0.3, 0.005, s * 0.45, 0.24, 0.452), GOLD);
	});
	screen(room, shell, 'N', -0.5, {width: 2.4, y: 1.75});
	for (const u of [-4.2, 3.4])
		onWall(room, shell, 'N', u, () => {
			bookshelf(room, {
				w: 2.4,
				h: 2.6,
				d: 0.36,
				wood: WALNUT,
				random,
				palette: ['#5a1e18', '#1e3a2a', '#2a2a4a', '#c9a24a', '#d8cbb0', '#3a2414'],
			});
			room.add(box(2.46, 0.06, 0.4, 0, 2.63, 0.2), GOLD);
		});

	// --- group A: the desk, its chair and two guest chairs
	room.at(-4.2, 0, -3.2, 0, () => {
		desk(room);
		room.at(0, 0, -0.85, 0, () => room.empty('seat_A_01', ...officeChair(room, {back: 0.85})));
		for (const [i, x] of [-0.42, 0.42].entries())
			room.at(x, 0, 0.95, Math.PI, () =>
				room.empty(
					`seat_A_${String(i + 2).padStart(2, '0')}`,
					...officeChair(room, {back: 0.5, leather: LEATHER_LIGHT}),
				),
			);
	});
	room.at(-5.9, 0, -4.3, 0, () => globe(room));

	// --- west wall: two tall windows
	for (const u of WINDOWS)
		onWall(room, shell, 'W', u, () => {
			const {w, h, y0} = WIN;
			room.add(box(w + 0.12, 0.08, 0.12, 0, y0 - 0.04, 0.03), WALNUT);
			room.add(box(w + 0.12, 0.08, 0.12, 0, y0 + h + 0.04, 0.03), WALNUT);
			for (const s of [-1, 0, 1]) room.add(box(0.05, h, 0.1, (s * w) / 2, y0 + h / 2, 0.02), WALNUT);
			room.add(box(w, 0.04, 0.08, 0, y0 + h * 0.7, 0.02), WALNUT);
			room.add(quad(w, h, 0, y0 + h / 2, -0.03), '#fff0d8', {glass: true, cast: false});
			for (const s of [-1, 1])
				room.add(box(0.35, h + 0.3, 0.08, s * (w / 2 + 0.25), y0 + (h + 0.3) / 2, 0.06), '#6a2a20');
			dusk(room, random);
			room.light(0, 1.6, 0.8, {color: '#ffb070', intensity: 0.4, range: 2.4, shadow: false});
		});

	// --- group B: a Chesterfield sofa and two club chairs round a low table, facing the TV
	const b = [];
	room.at(-0.5, 0, -0.4, Math.PI, () => {
		for (const h of sofa(room, {
			width: 2.4,
			seats: 3,
			frame: LEATHER,
			cushion: LEATHER_LIGHT,
			legs: GOLD,
			armWidth: 0.24,
			backHeight: 0.8,
		}))
			b.push(room.worldPoint(...h));
	});
	for (const [x, yaw] of [
		[-2.35, Math.PI / 2],
		[1.35, -Math.PI / 2],
	])
		room.at(x, 0, -1.9, yaw, () =>
			b.push(room.worldPoint(...armchair(room, {color: LEATHER, cushion: LEATHER_LIGHT, legs: GOLD})[0])),
		);
	b.sort((p, q) => p.x - q.x || p.z - q.z).forEach((p, i) =>
		room.empties.push({name: `seat_B_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
	);
	room.at(-0.5, 0, -1.9, 0, () => {
		rug(room, {w: 4.6, d: 3.4, color: '#6a2420', border: '#2a2a4a', inner: '#c9a24a'});
		coffeeTable(room, {w: 1.3, d: 0.7, top: '#1e120a', legs: GOLD});
		room.add(
			lathe(
				[
					[0, 0],
					[0.06, 0],
					[0.07, 0.12],
					[0.03, 0.2],
					[0.03, 0.24],
					[0, 0.24],
				],
				0.35,
				0.4,
				0,
				10,
			),
			'#e8d0a0',
			{glass: true},
		);
		room.add(box(0.3, 0.04, 0.22, -0.3, 0.42, 0.05), '#2a2a4a');
	});

	// --- group C: the conference table with seven chairs
	room.at(4.3, 0, 1.1, 0, () => {
		room.add(rbox(1.2, 0.06, 3.4, 0.02, 0, 0.74, 0), WALNUT);
		room.add(box(1.22, 0.015, 3.42, 0, 0.71, 0), GOLD);
		for (const s of [-1, 1]) room.add(box(0.8, 0.7, 0.12, 0, 0.36, s * 1.2), '#2e1a0e');
		room.add(box(0.1, 0.1, 2.3, 0, 0.3, 0), '#2e1a0e');
		const c = [];
		for (const z of [-1.0, 0, 1.0])
			for (const [sx, yaw] of [
				[-0.95, Math.PI / 2],
				[0.95, -Math.PI / 2],
			])
				room.at(sx, 0, z, yaw, () => c.push(room.worldPoint(...officeChair(room, {back: 0.6}))));
		room.at(0, 0, 2.15, Math.PI, () => c.push(room.worldPoint(...officeChair(room, {back: 0.85}))));
		c.sort((p, q) => p.z - q.z || p.x - q.x).forEach((p, i) =>
			room.empties.push({name: `seat_C_${String(i + 1).padStart(2, '0')}`, translation: [p.x, p.y, p.z]}),
		);
		for (const z of [-0.9, 0.3]) room.add(box(0.3, 0.01, 0.22, -0.2, 0.775, z), '#f2ece0');
		for (const z of [-1.1, 0.0, 1.1])
			room.at(0, 0, z, 0, () => {
				room.add(cyl(0.004, 0.004, 1.0, 0, H - 1.0, 0, 4), '#151515', {cast: false});
				room.add(cyl(0.16, 0.16, 0.03, 0, H - 1.03, 0, 16), GOLD, {cast: false});
				room.add(cyl(0.14, 0.14, 0.005, 0, H - 1.035, 0, 16), '#ffe0b0', {emissive: 1.2, cast: false});
				room.light(0, H - 1.1, 0, {color: '#ffd8a0', intensity: 0.75, range: 1.8, radius: 0.08, down: 0.6});
			});
	});

	// --- the card table with leather chairs and two ottomans for the watchers
	room.at(-2.0, 0, 2.6, 0, () => {
		rug(room, {w: 3.4, d: 3.4, color: '#2a2a4a', border: '#c9a24a'});
		gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#1e4a30', wood: WALNUT});
		const seatsXZ = tableContract(room, 'T01', {...TABLE, watch: [1, 2]});
		for (const [sx, sz] of seatsXZ) {
			const d = Math.hypot(sx, sz);
			room.at((sx / d) * (d + 0.06), 0, (sz / d) * (d + 0.06), Math.atan2(-sx, -sz), () =>
				armchair(room, {color: LEATHER, cushion: LEATHER_LIGHT, legs: GOLD, width: 0.8}),
			);
		}
		for (const [dx, dz] of [
			[0, 1],
			[1, 0],
		]) {
			const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
			room.at(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7, 0, () => {
				room.add(rbox(0.5, 0.42, 0.5, 0.08, 0, 0.21, 0), LEATHER);
				for (const sx of [-1, 1])
					for (const sz of [-1, 1]) room.add(cyl(0.02, 0.02, 0.04, sx * 0.2, 0, sz * 0.2, 6), GOLD);
			});
		}
		room.add(cyl(0.004, 0.004, 1.1, 0, H - 1.1, 0, 4), '#151515', {cast: false});
		room.add(
			lathe(
				[
					[0.28, 0],
					[0.24, 0.08],
					[0.06, 0.2],
					[0, 0.2],
				],
				0,
				H - 1.3,
				0,
				16,
			),
			'#1e4a30',
			{cast: false},
		);
		room.add(cyl(0.25, 0.25, 0.005, 0, H - 1.3, 0, 16), '#ffe0a0', {emissive: 1.25, cast: false});
		room.light(0, H - 1.38, 0, {color: '#ffd59a', intensity: 1.5, range: 2.2, radius: 0.1, down: 0.6});
	});

	// --- east wall: the door, a drinks cabinet, art; floor lamps and plants
	onWall(room, shell, 'E', 3.6, () => door(room, {w: 1.1, h: 2.3, casing: GOLD, leaf: WALNUT, handle: GOLD}));
	onWall(room, shell, 'E', 0.0, () =>
		frame(room, {w: 1.8, h: 1.1, y: 2.05, color: GOLD, art: ['#2a2a4a', '#6a2420', '#c9a24a', '#1e4a30']}),
	);
	room.at(5.2, 0, -4.7, 0, () => {
		room.add(box(1.1, 0.95, 0.45, 0, 0.475, 0), WALNUT);
		room.add(box(1.12, 0.02, 0.47, 0, 0.96, 0), GOLD);
		for (const [i, c] of ['#c87a2a', '#e8d0a0', '#7a2a1a'].entries())
			room.add(
				lathe(
					[
						[0, 0],
						[0.06, 0],
						[0.065, 0.14],
						[0.02, 0.22],
						[0.02, 0.27],
						[0, 0.27],
					],
					-0.3 + i * 0.25,
					0.97,
					0,
					10,
				),
				c,
				{glass: i === 1},
			);
	});
	for (const [x, z] of [
		[-6.0, 4.3],
		[2.0, -4.3],
		[-6.0, 0.0],
	])
		room.at(x, 0, z, 0, () =>
			floorLamp(room, {shade: '#f2e2c0', metal: GOLD, glow: '#ffcf8a', intensity: 0.9, range: 2.2}),
		);
	for (const [x, z] of [
		[6.0, 4.5],
		[-2.45, -4.5],
	])
		room.at(x, 0, z, random() * 6, () => plant(room, {random, pot: '#1e1a18', leaf: '#3a6a3a', height: 1.5}));

	room.light(-0.5, 3.0, -0.6, {color: '#ffe0b8', intensity: 0.6, range: 7, shadow: false});
	room.light(3.0, 3.0, 2.5, {color: '#ffe0b8', intensity: 0.3, range: 4, shadow: false});

	stands(room, [
		[0.6, 3.8],
		[1.9, 1.6],
		[0.9, 0.3],
		[-4.6, 0.4],
		[-5.4, -0.9],
		[-1.8, -3.6],
		[0.9, -3.4],
		[2.6, -2.4],
		[5.6, -2.0],
		[2.6, 4.2],
		[5.8, 4.4],
		[-4.4, 4.2],
	]);
	camera(room, shell, {azimuthDeg: 32, elevationDeg: 34, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
