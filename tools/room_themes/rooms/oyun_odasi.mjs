// SPDX-License-Identifier: AGPL-3.0-or-later

// Oyun Odası: a game room. Gaming desks with glowing monitors along the west wall, bean bags and a couch in front of a
// big TV, two game tables, arcade cabinets in the corner, posters and LED trim.

import {camera, screen, stands, tableContract} from '../lib/contract.mjs';
import {
	bookshelf,
	box,
	cyl,
	cylZ,
	door,
	extrude,
	frame,
	gameTable,
	neonStrip,
	pendant,
	plant,
	quad,
	rbox,
	rug,
	sofa,
	sphere,
	tvBezel,
	windowUnit,
} from '../lib/furniture.mjs';
import {Room} from '../lib/scene.mjs';
import {buildShell, onWall} from '../lib/shell.mjs';

const W = 13;
const D = 10;
const H = 3.2;
const TABLE = {top: 1.4, topY: 0.8, seatOut: 1.14, headY: 1.125};
const TABLES = [
	[0.9, -2.3],
	[4.5, -2.3],
];
const LED = ['#36e0ff', '#ff4fd8', '#7dff6a', '#ffb43a'];

function gamingChair(room, accent) {
	const h = 0.48;
	for (let i = 0; i < 5; i++) {
		const a = (i / 5) * Math.PI * 2;
		room.add(
			box(0.05, 0.04, 0.3)
				.rotateY(a)
				.translate(Math.sin(a) * 0.15, 0.06, Math.cos(a) * 0.15),
			'#151519',
		);
		room.add(sphere(0.03, Math.sin(a) * 0.3, 0.03, Math.cos(a) * 0.3, 6, 4), '#0c0c0f');
	}
	room.add(cyl(0.03, 0.03, h - 0.1, 0, 0.06, 0, 8), '#2a2a30');
	room.add(rbox(0.52, 0.1, 0.5, 0.04, 0, h - 0.03, 0.02), '#1d1d24');
	room.add(rbox(0.34, 0.03, 0.42, 0.01, 0, h + 0.025, 0.02), accent);
	// the back stops under the sitter's head point, so it never hides the avatar drawn there from behind
	const back = rbox(0.5, 0.56, 0.12, 0.05)
		.rotateX(-0.12)
		.translate(0, h + 0.32, -0.23);
	room.add(back, '#1d1d24');
	room.add(
		rbox(0.16, 0.46, 0.02, 0.008)
			.rotateX(-0.12)
			.translate(0, h + 0.31, -0.165),
		accent,
	);
	room.add(
		rbox(0.32, 0.1, 0.08, 0.04)
			.rotateX(-0.12)
			.translate(0, h + 0.52, -0.21),
		accent,
	);
	for (const s of [-1, 1]) {
		room.add(box(0.04, 0.22, 0.04, s * 0.27, h + 0.1, 0.0), '#2a2a30');
		room.add(rbox(0.08, 0.04, 0.26, 0.015, s * 0.27, h + 0.22, 0.02), '#1d1d24');
	}
	return [0, h + 0.64, 0.02];
}

function gamingDesk(room, accent, random) {
	room.add(rbox(1.3, 0.04, 0.68, 0.01, 0, 0.74, 0), '#1b1b22');
	for (const s of [-1, 1]) room.add(box(0.06, 0.72, 0.6, s * 0.6, 0.36, 0), '#111116');
	neonStrip(room, {length: 1.24, color: accent, x: 0, y: 0.71, z: 0.33, thickness: 0.015, intensity: 1.5});
	// monitor
	room.add(box(0.2, 0.02, 0.16, 0, 0.77, -0.18), '#111116');
	room.add(box(0.04, 0.25, 0.03, 0, 0.88, -0.2), '#111116');
	room.add(rbox(0.86, 0.46, 0.04, 0.01, 0, 1.18, -0.17), '#0b0b0e');
	const tint = ['#3a6bd8', '#2fae7a', '#c94fb0', '#d88a3a'][Math.floor(random() * 4)];
	room.add(quad(0.82, 0.42, 0, 1.18, -0.148), tint, {emissive: 0.85, cast: false});
	room.add(quad(0.82, 0.12, 0, 1.06, -0.147), '#16182a', {emissive: 1, cast: false});
	room.light(0, 1.15, 0.15, {color: tint, intensity: 0.35, range: 0.9, shadow: false});
	// keyboard, mouse, speakers, a can
	room.add(box(0.44, 0.02, 0.14, -0.05, 0.77, 0.12), '#141418');
	room.add(box(0.42, 0.005, 0.12, -0.05, 0.782, 0.12), accent, {emissive: 0.5, cast: false});
	room.add(rbox(0.06, 0.03, 0.1, 0.012, 0.3, 0.775, 0.12), '#141418');
	for (const s of [-1, 1]) room.add(box(0.1, 0.18, 0.1, s * 0.52, 0.85, -0.18), '#141418');
	room.add(cyl(0.032, 0.032, 0.12, 0.45, 0.76, 0.05, 10), ['#d83a3a', '#3ad87a', '#e8c23a'][Math.floor(random() * 3)]);
}

function beanBag(room, color) {
	room.add(sphere(0.46, 0, 0, 0, 14, 9).scale(1, 0.55, 1).translate(0, 0.25, 0), color);
	room.add(sphere(0.38, 0, 0, 0, 12, 8).scale(1, 0.8, 0.55).rotateX(-0.35).translate(0, 0.5, -0.24), color);
	return [0, 0.98, 0.05];
}

function arcade(room, accent, screenTint) {
	const side = [
		[-0.4, 0],
		[0.38, 0],
		[0.38, 0.95],
		[0.18, 1.1],
		[0.24, 1.62],
		[0.34, 1.86],
		[-0.4, 1.86],
	];
	for (const s of [-1, 1])
		room.add(
			extrude(side, 0.03)
				.rotateY(-Math.PI / 2)
				.translate(s * 0.33, 0, 0),
			'#151519',
		);
	room.add(box(0.63, 0.95, 0.02, 0, 0.475, 0.37), '#202028');
	room.add(box(0.63, 1.86, 0.02, 0, 0.93, -0.39), '#151519');
	room.add(box(0.63, 0.04, 0.32, 0, 1.0, 0.26).rotateX(0), '#202028');
	const panel = box(0.63, 0.03, 0.28, 0, 0, 0).rotateX(-0.3).translate(0, 1.03, 0.28);
	room.add(panel, accent);
	for (let i = 0; i < 6; i++)
		room.add(
			cyl(0.018, 0.018, 0.02, -0.05 + (i % 3) * 0.07, 1.05 + (i < 3 ? 0.02 : 0), 0.24 + (i < 3 ? -0.06 : 0.02), 10),
			LED[i % 4],
			{emissive: 0.9},
		);
	room.add(cyl(0.012, 0.012, 0.08, -0.2, 1.04, 0.28, 6), '#111');
	room.add(sphere(0.025, -0.2, 1.13, 0.28, 8, 5), '#d83a3a');
	const screenGeo = quad(0.52, 0.42, 0, 0, 0).rotateX(-0.25).translate(0, 1.38, 0.2);
	room.add(screenGeo, screenTint, {emissive: 1, cast: false});
	room.add(box(0.63, 0.2, 0.04, 0, 1.75, 0.3), accent, {emissive: 1.3, cast: false});
	neonStrip(room, {length: 1.8, color: accent, x: 0.35, y: 0.92, z: 0.37, axis: 'y', thickness: 0.015, intensity: 1.4});
	neonStrip(room, {
		length: 1.8,
		color: accent,
		x: -0.35,
		y: 0.92,
		z: 0.37,
		axis: 'y',
		thickness: 0.015,
		intensity: 1.4,
	});
	room.light(0, 1.5, 0.7, {color: accent, intensity: 0.4, range: 1.2, shadow: false});
}

// A poster on a wall (local +Z into the room): a coloured field with a few bold shapes.
function poster(room, {w = 0.7, h = 1.0, y = 1.75, bg, shapes}) {
	room.add(box(w + 0.04, h + 0.04, 0.012, 0, y, 0.006), '#101014');
	room.add(box(w, h, 0.004, 0, y, 0.014), bg);
	for (const [kind, x, sy, s, color] of shapes) {
		if (kind === 'disc')
			room.add(
				cyl(s, s, 0.003, x, 0, 0, 20)
					.rotateX(Math.PI / 2)
					.translate(0, y + sy, 0.017),
				color,
			);
		else if (kind === 'tri')
			room.add(
				extrude(
					[
						[-s, -s * 0.8],
						[s, -s * 0.8],
						[0, s],
					],
					0.003,
					x,
					y + sy,
					0.018,
				),
				color,
			);
		else room.add(box(s * 2, s * 0.5, 0.003, x, y + sy, 0.018), color);
	}
}

export function buildOyunOdasi() {
	const room = new Room({
		ambient: '#3a3a52',
		sky: '#6a6c94',
		ground: '#2a2838',
		ao: {distance: 0.7, strength: 0.75, rays: 12},
		seed: 41,
	});
	const random = room.random;
	const shell = {
		W,
		D,
		H,
		wall: {default: '#3a3466', N: '#2c3a5a'},
		baseboard: '#15151c',
		ceiling: '#22222c',
		base: '#18181e',
		openings: {
			S: [
				{u: -2.5, y0: 1.0, w: 1.6, h: 1.4},
				{u: 2.0, y0: 0, w: 1.1, h: 2.25},
			],
		},
		floor(r) {
			const tile = 0.5;
			for (let ix = 0; ix < W / tile; ix++)
				for (let iz = 0; iz < D / tile; iz++) {
					const v = random() * 0.035;
					const c = (ix + iz) % 2 ? 0.27 + v : 0.24 + v;
					r.add(
						box(tile - 0.008, 0.02, tile - 0.008, -W / 2 + tile * (ix + 0.5), -0.01, -D / 2 + tile * (iz + 0.5)),
						rgb(c, c, c + 0.03),
					);
				}
			r.add(box(W, 0.012, D, 0, -0.016, 0), '#0e0e12');
		},
	};
	buildShell(room, shell);

	// LED trim at the top of every wall; ceiling light panels
	for (const [side, color] of [
		['N', LED[0]],
		['W', LED[1]],
		['E', LED[1]],
		['S', LED[0]],
	])
		onWall(room, shell, side, 0, () => {
			const length = side === 'N' || side === 'S' ? W : D;
			neonStrip(room, {length, color, x: 0, y: H - 0.12, z: 0.03, thickness: 0.025, intensity: 1.3});
			neonStrip(room, {length, color, x: 0, y: 0.13, z: 0.03, thickness: 0.018, intensity: 1.1});
		});
	room.useBucket('ceiling');
	for (const [x, z] of [
		[-3.4, -2.6],
		[2.7, -2.3],
		[-3.4, 2.3],
		[2.7, 2.6],
	])
		room.add(box(1.6, 0.03, 0.6, x, H - 0.015, z), '#f0f2ff', {emissive: 0.9, cast: false});
	room.useBucket('room');
	for (const [x, z] of [
		[-3.4, -2.6],
		[-3.4, 2.3],
		[2.7, 2.6],
	])
		room.light(x, H - 0.2, z, {color: '#e8ecff', intensity: 0.65, range: 3.2, down: 0.8});

	// --- north wall: the TV, a media console with consoles, posters; couch (C) and bean bags (B)
	screen(room, shell, 'N', -3.0, {width: 2.8, y: 1.6});
	onWall(room, shell, 'N', -3.0, () => {
		tvBezel(room, {w: 2.8, h: (2.8 * 9) / 16, y: 1.6});
		room.add(box(3.2, 0.45, 0.45, 0, 0.225, 0.225), '#15151c');
		neonStrip(room, {length: 3.1, color: LED[0], x: 0, y: 0.46, z: 0.45, thickness: 0.015, intensity: 1.2});
		room.add(rbox(0.36, 0.08, 0.28, 0.02, -0.8, 0.49, 0.22), '#e8e8ee');
		room.add(rbox(0.2, 0.36, 0.22, 0.03, 0.9, 0.63, 0.22), '#111116');
		room.add(box(0.012, 0.3, 0.005, 0.9, 0.63, 0.333), LED[0], {emissive: 1.2, cast: false});
		for (const s of [-1, 1]) room.add(rbox(0.14, 0.04, 0.09, 0.02, s * 0.25 - 0.1, 0.47, 0.3), '#2a2a30');
		poster(room, {
			x: 0,
			y: 1.6,
			bg: '#e8c23a',
			w: 0.7,
			h: 0.95,
			shapes: [
				['disc', 0, 0.12, 0.2, '#d83a3a'],
				['bar', 0, -0.3, 0.22, '#1b1b22'],
			],
		});
	});
	onWall(room, shell, 'N', -5.4, () =>
		poster(room, {
			y: 1.7,
			bg: '#1b2a5a',
			shapes: [
				['tri', 0, 0.05, 0.22, '#36e0ff'],
				['bar', 0, -0.32, 0.25, '#ff4fd8'],
			],
		}),
	);
	onWall(room, shell, 'N', -0.6, () =>
		poster(room, {
			y: 1.7,
			bg: '#d83a6a',
			shapes: [
				['disc', -0.1, 0.2, 0.14, '#ffe36a'],
				['disc', 0.12, -0.05, 0.1, '#1b1b22'],
				['bar', 0, -0.33, 0.25, '#ffffff'],
			],
		}),
	);
	onWall(room, shell, 'N', 1.5, () =>
		poster(room, {
			y: 1.75,
			w: 0.9,
			h: 0.65,
			bg: '#1b1b22',
			shapes: [
				['bar', -0.15, 0.1, 0.12, '#7dff6a'],
				['bar', 0.15, -0.05, 0.12, '#36e0ff'],
				['disc', 0.25, 0.15, 0.06, '#ff4fd8'],
			],
		}),
	);

	room.at(-3.0, 0, -0.9, Math.PI, () => {
		const heads = sofa(room, {
			width: 2.4,
			seats: 3,
			frame: '#2a3a5a',
			cushion: '#3a5a8a',
			legs: '#0e0e12',
			pillows: ['#e8c23a', '#ff4fd8'],
		});
		heads.forEach((h, i) => room.empty(`seat_C_${String(i + 1).padStart(2, '0')}`, ...h));
	});
	room.at(-3.0, 0, -2.7, 0, () => rug(room, {w: 3.8, d: 3.2, color: '#5a2a6a', border: '#36e0ff', inner: '#2a2a3a'}));
	[
		[-4.3, -3.0, 0.5, '#e85a3a'],
		[-3.5, -3.5, 0.15, '#3ad8a0'],
		[-2.5, -3.5, -0.15, '#e8c23a'],
		[-1.7, -3.0, -0.5, '#5a7ae8'],
	].forEach(([x, z, yaw, color], i) =>
		room.at(x, 0, z, Math.PI + yaw, () =>
			room.empty(`seat_B_${String(i + 1).padStart(2, '0')}`, ...beanBag(room, color)),
		),
	);

	// --- west wall: four gaming stations (A_01..A_04), shelves; two more on the east wall (A_05, A_06)
	const stations = [
		['W', -0.2],
		['W', 1.3],
		['W', 2.8],
		['W', 4.3],
		['E', 2.3],
		['E', 3.7],
	];
	stations.forEach(([side, u], i) => {
		const accent = LED[i % 4];
		const x = side === 'W' ? -W / 2 + 0.36 : W / 2 - 0.36;
		const yaw = side === 'W' ? Math.PI / 2 : -Math.PI / 2;
		room.at(x, 0, u, yaw, () => gamingDesk(room, accent, random));
		const cx = side === 'W' ? -W / 2 + 1.25 : W / 2 - 1.25;
		room.at(cx, 0, u, yaw + Math.PI, () =>
			room.empty(`seat_A_${String(i + 1).padStart(2, '0')}`, ...gamingChair(room, accent)),
		);
	});
	onWall(room, shell, 'W', -3.0, () =>
		bookshelf(room, {
			w: 1.8,
			h: 2.1,
			wood: '#1b1b22',
			random,
			palette: ['#36e0ff', '#ff4fd8', '#e8c23a', '#d83a3a', '#e8e8ee', '#5a7ae8'],
		}),
	);
	onWall(room, shell, 'W', 2.05, () => {
		poster(room, {
			y: 2.0,
			w: 0.8,
			h: 0.6,
			bg: '#101018',
			shapes: [
				['tri', -0.2, 0, 0.15, '#7dff6a'],
				['disc', 0.15, 0, 0.14, '#ff4fd8'],
			],
		});
		frame(room, {w: 0.6, h: 0.45, y: 2.0, color: '#000000', art: []});
	});
	onWall(room, shell, 'W', 3.55, () =>
		poster(room, {
			y: 2.05,
			w: 0.6,
			h: 0.8,
			bg: '#36e0ff',
			shapes: [
				['bar', 0, 0.15, 0.2, '#1b1b22'],
				['disc', 0, -0.15, 0.12, '#ffffff'],
			],
		}),
	);

	// --- arcade corner (north-east) and a pinball-ish table of plants
	[
		[5.0, '#ff4fd8', '#5a3ad8'],
		[5.75, '#36e0ff', '#2fae7a'],
	].forEach(([x, accent, tint]) => room.at(x, 0, -D / 2 + 0.45, 0, () => arcade(room, accent, tint)));
	room.at(6.1, 0, -2.0, 0, () => plant(room, {random, pot: '#e8e8ee', leaf: '#3a8a4a', height: 1.3}));
	room.at(-6.1, 0, 4.5, 0, () => plant(room, {random, pot: '#e8e8ee', leaf: '#3a8a4a', height: 1.2}));

	// --- game tables
	TABLES.forEach(([x, z], i) => {
		const slot = `T0${i + 1}`;
		room.at(x, 0, z, 0, () => {
			gameTable(room, {top: TABLE.top, topY: TABLE.topY, felt: '#26506a', wood: '#1b1b22', rim: 0.07});
			const seatsXZ = tableContract(room, slot, {...TABLE, watch: [1, 2, 3, 4]});
			for (const [sx, sz] of seatsXZ) {
				const d = Math.hypot(sx, sz);
				room.at((sx / d) * (d - 0.02), 0, (sz / d) * (d - 0.02), Math.atan2(-sx, -sz), () =>
					gamingChair(room, LED[(i * 2 + Math.round(sx + sz)) & 3]),
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
					room.add(cyl(0.2, 0.22, 0.5, 0, 0, 0, 14), '#2a2a36');
					room.add(cyl(0.2, 0.2, 0.03, 0, 0.5, 0, 14), LED[(i + dx + 2) & 3]);
				});
			});
			pendant(room, {
				ceiling: H,
				drop: 0.95,
				kind: 'dome',
				shade: '#1b1b22',
				glow: '#fff2d8',
				intensity: 1.6,
				range: 2.3,
			});
		});
	});

	room.light(0, 2.8, 0.5, {color: '#c8c8ff', intensity: 0.8, range: 7, shadow: false});
	room.at(1.0, 0, 2.6, 0.2, () => langirt(room));
	room.at(1.0, 0, 2.6, 0, () =>
		pendant(room, {ceiling: H, drop: 1.1, kind: 'cone', shade: '#ff4fd8', glow: '#fff2d8', intensity: 1.2, range: 2}),
	);
	onWall(room, shell, 'E', 0.4, () => {
		room.add(cylZ(0.24, 0.04, 0, 1.73, 0.02, 24), '#111116');
		for (let i = 0; i < 4; i++)
			room.add(cylZ(0.2 - i * 0.05, 0.005, 0, 1.73, 0.042 + i * 0.002, 20), i % 2 ? '#e8e0c8' : '#c8302a');
	});
	onWall(room, shell, 'E', -1.0, () =>
		poster(room, {
			y: 1.75,
			w: 0.7,
			h: 1.0,
			bg: '#7dff6a',
			shapes: [
				['tri', 0, 0.1, 0.22, '#1b1b22'],
				['bar', 0, -0.32, 0.25, '#ff4fd8'],
			],
		}),
	);
	onWall(room, shell, 'S', 2.0, () => door(room, {w: 1.1, h: 2.25}));
	onWall(room, shell, 'S', -2.5, () =>
		windowUnit(room, {w: 1.6, h: 1.4, sill: 1.0, frame: '#15151c', backdrop: '#1a2050', glow: 1}),
	);

	stands(room, [
		[-0.6, 0.2],
		[-1.4, 1.6],
		[0.4, 1.8],
		[2.0, 0.6],
		[3.6, 0.4],
		[5.2, 1.6],
		[2.6, 3.6],
		[0.6, 4.0],
		[-1.8, 3.6],
		[-3.6, 3.4],
		[2.7, -4.3],
		[-0.4, -4.1],
	]);
	camera(room, shell, {azimuthDeg: 32, elevationDeg: 35, targetY: 2.0, zoomMin: 0.1, pan: [4, 3]});
	return room;
}

// Langırt: a foosball table, long side along x.
function langirt(room) {
	room.add(box(1.2, 0.22, 0.7, 0, 0.8, 0), '#1b2a5a');
	room.add(box(1.12, 0.01, 0.62, 0, 0.72, 0), '#2f8a4a');
	room.add(box(0.02, 0.005, 0.62, 0, 0.726, 0), '#e8e8ee');
	for (const s of [-1, 1]) {
		room.add(box(0.1, 0.7, 0.1, s * 0.5, 0.35, 0.28), '#111116');
		room.add(box(0.1, 0.7, 0.1, s * 0.5, 0.35, -0.28), '#111116');
		room.add(box(0.02, 0.1, 0.18, s * 0.6, 0.78, 0), '#e8e8ee');
	}
	for (let i = 0; i < 8; i++) {
		const x = -0.49 + i * 0.14;
		room.add(cylZ(0.008, 1.0, x, 0.86, 0, 6), '#c8c8d0');
		for (const sz of [-0.09, 0.09]) {
			room.add(box(0.025, 0.09, 0.03, x, 0.8, sz), i % 2 ? '#d83a3a' : '#e8e8ee');
			room.add(sphere(0.016, x, 0.86, sz, 6, 4), '#e8c8a0');
		}
		room.add(cylZ(0.022, 0.08, x, 0.86, (i % 2 ? 1 : -1) * 0.56, 8), '#111116');
	}
}

function rgb(r, g, b) {
	const c = (v) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`;
}
