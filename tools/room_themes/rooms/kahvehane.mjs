// SPDX-License-Identifier: AGPL-3.0-or-later

// Kahvehane: a Turkish coffeehouse in the evening. Three green-felt game tables under enamel pendants, a sedir under
// the west windows, a tea counter with a samovar on the north wall, the TV high on that wall for the match.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	box,
	cafeChair,
	cyl,
	cylZ,
	frame,
	gameTable,
	lathe,
	pendant,
	plant,
	quad,
	rbox,
	rug,
	squareTable,
	stool,
	torus,
	tvBezel,
	wallClock,
	windowUnit,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 14;
const D = 10;
const H = 3.4;
const TABLE = {top: 1.3, topY: 0.76, seatOut: 1.08, headY: 1.08};
const TABLE_X = [-2.4, 1.2, 4.8];
const TABLE_Z = 0.9;

function teaGlass(room, x, y, z) {
	room.add(cyl(0.05, 0.05, 0.008, x, y, z, 12), '#d9c7a0');
	room.add(
		lathe(
			[
				[0.02, 0.008],
				[0.026, 0.03],
				[0.018, 0.055],
				[0.027, 0.095],
				[0.028, 0.1],
			],
			x,
			y,
			z,
			10,
		),
		'#e8d2b0',
		{glass: true},
	);
	room.add(
		lathe(
			[
				[0, 0.009],
				[0.019, 0.009],
				[0.024, 0.03],
				[0.017, 0.055],
				[0.024, 0.082],
				[0, 0.082],
			],
			x,
			y,
			z,
			10,
		),
		'#8a1e08',
	);
}

function samovar(room, x, y, z) {
	const brass = '#b8862e';
	room.add(
		lathe(
			[
				[0, 0],
				[0.16, 0],
				[0.17, 0.03],
				[0.1, 0.06],
				[0.08, 0.1],
				[0.17, 0.14],
				[0.2, 0.3],
				[0.18, 0.42],
				[0.1, 0.46],
				[0, 0.46],
			],
			x,
			y,
			z,
			18,
		),
		brass,
	);
	room.add(
		lathe(
			[
				[0, 0],
				[0.11, 0],
				[0.13, 0.08],
				[0.11, 0.16],
				[0.05, 0.2],
				[0.03, 0.24],
				[0, 0.24],
			],
			x,
			y + 0.46,
			z,
			16,
		),
		'#c99a3e',
	);
	room.add(cylZ(0.015, 0.14, x, y + 0.2, z + 0.24, 6), brass);
	room.add(sphereKnob(x, y + 0.71, z), brass);
	for (const s of [-1, 1]) room.add(torus(0.05, 0.01, x + s * 0.21, y + 0.32, z, 4, 10, Math.PI).rotateZ(0), '#3a2a1c');
}

function sphereKnob(x, y, z) {
	return lathe(
		[
			[0, 0],
			[0.02, 0.005],
			[0.022, 0.02],
			[0, 0.035],
		],
		x,
		y,
		z,
		8,
	);
}

function copperTray(room, x, y, r) {
	room.add(cylZ(r, 0.02, x, y, 0.012, 22), '#b0603a');
	room.add(cylZ(r * 0.82, 0.004, x, y, 0.024, 22), '#c9784c');
}

// A sedir: a built-in bench along a wall (its back on z = 0), kilim cushions, bolsters against the wall.
function sedir(room, length, seats) {
	room.add(box(length, 0.32, 0.72, 0, 0.16, 0.36), '#6b4428');
	room.add(box(length, 0.03, 0.04, 0, 0.3, 0.73), '#4a2f1d');
	const kilim = ['#9c2f2a', '#c27a2c', '#2f5d6b', '#9c2f2a', '#6b2f5d', '#c27a2c'];
	const heads = [];
	for (let i = 0; i < seats; i++) {
		const x = -length / 2 + (length / seats) * (i + 0.5);
		room.add(rbox(length / seats - 0.02, 0.12, 0.66, 0.04, x, 0.38, 0.38), kilim[i % kilim.length]);
		room.add(rbox(length / seats - 0.06, 0.42, 0.16, 0.06, x, 0.65, 0.1).rotateX(-0.12), kilim[(i + 3) % kilim.length]);
		room.add(rbox(length / seats - 0.3, 0.08, 0.6, 0.03, x, 0.445, 0.38), '#d8c39a');
		heads.push([x, 0.44 + 0.64, 0.42]);
	}
	return heads;
}

function counter(room, length) {
	room.add(box(length, 1.0, 0.62, 0, 0.5, 0.31), '#5a3420');
	for (let i = 0; i < Math.floor(length / 0.6); i++)
		room.add(box(0.5, 0.7, 0.01, -length / 2 + 0.3 + i * 0.6, 0.48, 0.625), '#6e4128');
	room.add(rbox(length + 0.06, 0.05, 0.7, 0.01, 0, 1.025, 0.33), '#8a5a36');
	room.add(box(length, 0.06, 0.04, 0, 0.06, 0.64), '#2a1a10');
}

export function buildKahvehane() {
	const room = new Room({
		ambient: '#3a2a1a',
		sky: '#7a6550',
		ground: '#3a2a1c',
		ao: {distance: 0.7, strength: 0.7, rays: 12},
		seed: 11,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#e6d6b4'},
		wainscot: {color: '#6e4428', height: 1.1, cap: '#4a2c18'},
		baseboard: '#3a2414',
		crown: '#b08a5a',
		ceiling: '#d8c8a6',
		base: '#3a2a20',
		openings: {
			W: [
				{u: -2.4, y0: 0.95, w: 1.5, h: 1.7},
				{u: 1.6, y0: 0.95, w: 1.5, h: 1.7},
			],
			E: [{u: 3.2, y0: 0, w: 1.2, h: 2.3}],
		},
		floor(r) {
			const tile = 0.5;
			for (let ix = 0; ix < W / tile; ix++)
				for (let iz = 0; iz < D / tile; iz++) {
					const x = -W / 2 + tile * (ix + 0.5);
					const z = -D / 2 + tile * (iz + 0.5);
					const dark = (ix + iz) % 2 === 0;
					const jitter = (random() - 0.5) * 0.06;
					const base = dark ? [0.55 + jitter, 0.3 + jitter * 0.5, 0.2] : [0.72 + jitter, 0.56 + jitter, 0.4];
					r.add(box(tile - 0.01, 0.02, tile - 0.01, x, -0.01, z, [2, 1, 2]), rgbHex(base));
				}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#2a2018');
		},
	};
	buildShell(room, shell);

	// ceiling beams
	room.useBucket('ceiling');
	for (let i = 0; i < 6; i++) room.add(box(0.18, 0.2, D, -W / 2 + 1.2 + i * 2.3, H - 0.1, 0), '#4a2e1a');
	room.useBucket('room');

	// --- north wall: counter, samovar, shelves, TV, clock
	room.at(3.4, 0, -D / 2 + 0.02, 0, () => {
		counter(room, 3.8);
		samovar(room, 1.1, 1.05, 0.3);
		teaGlass(room, -0.4, 1.05, 0.45);
		teaGlass(room, -0.25, 1.05, 0.5);
		teaGlass(room, -0.1, 1.05, 0.42);
		room.add(cyl(0.16, 0.17, 0.015, -0.25, 1.05, 0.45, 18), '#b0603a');
		room.add(
			lathe(
				[
					[0, 0],
					[0.06, 0],
					[0.07, 0.06],
					[0.05, 0.08],
					[0, 0.09],
				],
				0.4,
				1.05,
				0.4,
				10,
			),
			'#f2efe8',
		);
	});
	onWall(room, shell, 'N', 3.4, () => {
		for (const [i, y] of [1.55, 1.95].entries()) {
			room.add(box(3.4, 0.04, 0.26, 0, y, 0.13), '#5a3420');
			for (let k = 0; k < 14; k++) {
				const x = -1.6 + k * 0.24 + (i ? 0.1 : 0);
				if (i === 0) teaGlass(room, x, y + 0.02, 0.12);
				else
					room.add(
						lathe(
							[
								[0, 0],
								[0.06, 0],
								[0.065, 0.16],
								[0.04, 0.2],
								[0.045, 0.22],
								[0, 0.22],
							],
							x,
							y + 0.02,
							0.12,
							10,
						),
						['#c27a2c', '#7a2e2e', '#3d6b45', '#d8c39a'][k % 4],
						{glass: k % 3 === 0},
					);
			}
		}
		copperTray(room, -1.3, 2.6, 0.26);
		copperTray(room, -0.6, 2.75, 0.2);
		copperTray(room, 1.4, 2.6, 0.24);
		wallClock(room, {y: 2.65, r: 0.24});
	});
	screen(room, shell, 'N', -2.4, {width: 2.2, y: 2.15});
	onWall(room, shell, 'N', -2.4, () => {
		tvBezel(room, {w: 2.2, h: (2.2 * 9) / 16, y: 2.15});
		frame(room, {w: 0.6, h: 0.8, y: 1.8, art: ['#7a2e2e', '#c27a2c']});
	});
	onWall(room, shell, 'N', -5.6, () => {
		frame(room, {w: 0.9, h: 0.65, y: 1.75, color: '#3a2414', art: ['#2f5d7a', '#3d6b45', '#e8c26a', '#7a2e2e']});
	});

	// --- west wall: windows over the sedir (group A)
	for (const u of [-2.4, 1.6])
		onWall(room, shell, 'W', u, () =>
			windowUnit(room, {
				w: 1.5,
				h: 1.7,
				sill: 0.95,
				frame: '#5a3420',
				backdropFn: ({w, h, y0}) => {
					room.add(quad(w, h * 0.55, 0, y0 + h * 0.725, -0.35), '#e8a060', {emissive: 0.9, cast: false});
					room.add(quad(w, h * 0.45, 0, y0 + h * 0.225, -0.36), '#6a4a70', {emissive: 0.8, cast: false});
					for (let i = 0; i < 4; i++)
						room.add(
							box(
								0.2 + random() * 0.15,
								0.3 + random() * 0.6,
								0.02,
								-w / 2 + 0.2 + i * 0.36,
								y0 + 0.15 + random() * 0.2,
								-0.33,
							),
							'#2a1e2e',
							{emissive: 1, cast: false},
						);
				},
			}),
		);
	const seatsA = [];
	room.at(-W / 2 + 0.01, 0, -0.4, Math.PI / 2, () => {
		const heads = sedir(room, 6.2, 6);
		for (const [i, [x, y, z]] of heads.entries())
			seatsA.push(room.empty(`seat_A_${String(i + 1).padStart(2, '0')}`, x, y, z));
		for (const x of [-2.07, 0, 2.07])
			room.at(x, 0, 1.15, 0, () => {
				squareTable(room, {size: 0.5, height: 0.45, top: '#8a5a36'});
				teaGlass(room, -0.1, 0.45, 0);
				teaGlass(room, 0.1, 0.45, 0.06);
			});
	});
	onWall(room, shell, 'W', -0.4, () => {
		room.add(box(0.05, 0.5, 0.04, 0, 2.95, 0.02), '#4a2c18');
	});

	// --- east wall: door, coat hooks, a frame
	onWall(room, shell, 'E', 3.2, () => {
		room.add(box(1.36, 0.1, 0.12, 0, 2.35, 0.03), '#4a2c18');
		for (const s of [-1, 1]) room.add(box(0.08, 2.3, 0.12, s * 0.64, 1.15, 0.03), '#4a2c18');
		room.add(box(1.2, 2.3, 0.05, 0, 1.15, -0.1), '#6e4128');
		for (let i = 0; i < 3; i++)
			room.add(
				box(0.9, 0.5, 0.02, 0, 0.5 + i * 0.65, -0.07),
				i === 2 ? '#cfe3ff' : '#5a3420',
				i === 2 ? {glass: true} : {},
			);
	});
	onWall(room, shell, 'E', -0.5, () => {
		room.add(box(1.4, 0.06, 0.04, 0, 1.75, 0.02), '#4a2c18');
		for (let i = 0; i < 5; i++)
			room.add(cyl(0.012, 0.012, 0.1, -0.56 + i * 0.28, 1.75, 0.06, 6).rotateX(Math.PI / 2.4), '#b8862e');
		frame(room, {w: 1.1, h: 0.7, y: 2.4, art: ['#2f5d7a', '#e8c26a', '#c94f3d']});
	});
	onWall(room, shell, 'E', -3.6, () => wallClock(room, {y: 2.3, r: 0.2, face: '#efe2c2'}));
	onWall(room, shell, 'S', 0, () => {
		for (const u of [-4, 0, 4])
			room.at(u, 0, 0, 0, () =>
				windowUnit(room, {w: 1.3, h: 1.5, sill: 1.0, frame: '#5a3420', backdrop: '#e09a5a', glow: 0.75}),
			);
	});

	// --- game tables T01..T03 with café chairs, a stool for each watch seat and a pendant above
	TABLE_X.forEach((x, i) => {
		const slot = `T0${i + 1}`;
		room.at(x, 0, TABLE_Z, 0, () => {
			gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#2f6a48', wood: '#5a3420'});
			const seatsXZ = tableContract(room, slot, {...TABLE, watch: [1, 2]});
			for (const [sx, sz] of seatsXZ) {
				const d = Math.hypot(sx, sz);
				room.at((sx / d) * (d + 0.03), 0, (sz / d) * (d + 0.03), Math.atan2(-sx, -sz), () =>
					cafeChair(room, {height: 0.44}),
				);
			}
			for (const index of [1, 2]) {
				const [dx, dz] = [
					[0, 1],
					[1, 0],
				][index - 1];
				const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
				room.at(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7, 0, () =>
					stool(room, {height: 1.13 - 0.64 - 0.08, seat: '#7a2e2e', metal: '#3a2414', radius: 0.17}),
				);
			}
			pendant(room, {
				ceiling: H,
				drop: 1.15,
				kind: 'dome',
				shade: '#2f5d3a',
				glow: '#ffd59a',
				intensity: 1.7,
				range: 2.3,
			});
		});
	});

	// --- group B: two small tables by the south windows
	const seatsB = [];
	[-4.6, 4.9].forEach((x, t) =>
		room.at(x, 0, 3.6, 0, () => {
			squareTable(room, {size: 0.7, height: 0.74, top: '#8a5a36'});
			teaGlass(room, 0.1, 0.74, 0.05);
			teaGlass(room, -0.12, 0.74, -0.08);
			for (const [k, s] of [-1, 1].entries()) {
				room.at(s * 0.62, 0, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2, () => {
					const [hx, hy, hz] = cafeChair(room, {height: 0.44});
					seatsB.push(room.empty(`seat_B_${String(t * 2 + k + 1).padStart(2, '0')}`, hx, hy, hz));
				});
			}
			pendant(room, {
				ceiling: H,
				drop: 1.3,
				kind: 'cone',
				shade: '#2f5d3a',
				glow: '#ffd59a',
				intensity: 1.1,
				range: 1.8,
			});
		}),
	);

	// --- group C: two stools at the counter
	[2.6, 3.6].forEach((x, i) =>
		room.at(x, 0, -D / 2 + 1.05, Math.PI, () => {
			const [hx, hy, hz] = stool(room, {height: 0.72, seat: '#7a2e2e', metal: '#3a2414'});
			room.empty(`seat_C_${String(i + 1).padStart(2, '0')}`, hx, hy, hz);
		}),
	);

	// --- rugs, plants, lights
	room.at(-5.3, 0, -0.4, 0, () => rug(room, {w: 1.8, d: 6, color: '#8a2a24', border: '#d8b06a', inner: '#2f4a6b'}));
	for (const [x, z] of [
		[-6.4, 4.4],
		[6.4, 4.4],
		[6.4, -4.4],
		[-0.6, -4.5],
		[-6.4, 3.9],
	])
		room.at(x, 0, z, random() * 6, () => plant(room, {random, pot: '#a0583a', height: 1.2}));
	room.at(3.4, 0, -D / 2 + 1.2, 0, () =>
		pendant(room, {ceiling: H, drop: 1.0, kind: 'globe', glow: '#ffe1b0', intensity: 1.1, range: 2.4}),
	);
	room.at(-5.6, 0, -0.4, 0, () =>
		pendant(room, {ceiling: H, drop: 0.9, kind: 'globe', glow: '#ffe1b0', intensity: 0.9, range: 3}),
	);
	room.at(-2.4, 0, -3.4, 0, () =>
		pendant(room, {ceiling: H, drop: 0.9, kind: 'globe', glow: '#ffe1b0', intensity: 0.8, range: 2.6}),
	);
	room.light(0, 3.0, 0, {color: '#ffd9a8', intensity: 0.55, range: 7, shadow: false});

	stands(room, [
		[-0.6, -1.6],
		[0.9, -2.0],
		[2.6, -2.4],
		[4.6, -2.0],
		[6.0, 1.0],
		[6.0, 2.6],
		[3.0, 3.4],
		[1.2, 3.8],
		[-0.6, 3.4],
		[-2.6, 3.6],
		[-4.2, -2.6],
		[-0.6, 0.9],
	]);
	camera(room, shell, {azimuthDeg: 30, elevationDeg: 36, targetY: 2.05, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

function rgbHex([r, g, b]) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}

