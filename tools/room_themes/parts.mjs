// SPDX-License-Identifier: AGPL-3.0-or-later

// masa-parcalari: the table parts every room shares (contract: build_manifest.mjs inspectParts, the client's
// scene/table models). Unlit like the rooms. The models tint most parts themselves (piece side colours, checker and
// tile instance colours), so their shading comes from the `piece` / `wood` / `okey_body` texture: a grey ramp each
// vertex samples at its own baked brightness (u = sRGB shade). The tavla board keeps its own vertex colours.

import {encodePng} from './lib/glb.mjs';
import {Room} from './lib/scene.mjs';
import {box, cyl, extrude, lathe, rbox, sphere} from './lib/shapes.mjs';
import {BufferAttribute, BufferGeometry, mergeGeometries, mergeVertices, Vector3} from './lib/three.mjs';

const KEY = new Vector3(0.35, 0.85, 0.4).normalize();

// sRGB shade of a surface from its normal: the bake the models' colour gains were tuned for (bodies ≈ 0.63,
// faces turned up ≈ 0.95).
const shadeOf = (n) => Math.min(0.98, Math.max(0.22, 0.5 + 0.35 * Math.max(0, n.dot(KEY)) + 0.15 * n.y));

function ramp() {
	const width = 64;
	const height = 2;
	const rgb = new Uint8Array(width * height * 3);
	for (let x = 0; x < width; x++)
		for (let y = 0; y < height; y++)
			rgb.fill(Math.round((x / (width - 1)) * 255), (y * width + x) * 3, (y * width + x) * 3 + 3);
	return encodePng(width, height, rgb);
}

// Merges geometries, gives every vertex its ramp u, drops normals, indexes.
function shaded(geometries, {darken = () => 1} = {}) {
	const parts = geometries.map((geometry) => {
		const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		const position = g.getAttribute('position');
		const normal = g.getAttribute('normal');
		const uv = new Float32Array(position.count * 2);
		const n = new Vector3();
		const p = new Vector3();
		for (let i = 0; i < position.count; i++) {
			n.fromBufferAttribute(normal, i).normalize();
			p.fromBufferAttribute(position, i);
			uv[i * 2] = Math.round(shadeOf(n) * darken(p, n) * 255) / 255;
			uv[i * 2 + 1] = 0.5;
		}
		const out = new BufferGeometry();
		out.setAttribute('position', position);
		out.setAttribute('uv', new BufferAttribute(uv, 2));
		return out;
	});
	return toPrimitive(mergeVertices(mergeGeometries(parts), 1e-6));
}

function toPrimitive(g, material) {
	const attributes = {POSITION: Float32Array.from(g.getAttribute('position').array)};
	if (g.getAttribute('uv')) attributes.TEXCOORD_0 = Float32Array.from(g.getAttribute('uv').array);
	if (g.getAttribute('color')) attributes.COLOR_0 = Float32Array.from(g.getAttribute('color').array);
	return {attributes, indices: g.index.array, material};
}

// ---- chess (king 0.095 m tall; the client rescales the set) ----

const BASE = [
	[0, 0],
	[0.0175, 0],
	[0.0175, 0.003],
	[0.016, 0.005],
	[0.0168, 0.0065],
	[0.0135, 0.0085],
];

function pawn() {
	return [
		lathe(
			[
				...BASE,
				[0.0105, 0.011],
				[0.0075, 0.02],
				[0.0062, 0.028],
				[0.0098, 0.0295],
				[0.0098, 0.0315],
				[0.0055, 0.033],
				[0, 0.033],
			],
			0,
			0,
			0,
			20,
		),
		sphere(0.0092, 0, 0.0405, 0, 16, 10),
	];
}

function rook() {
	const body = lathe(
		[
			...BASE,
			[0.012, 0.011],
			[0.0102, 0.02],
			[0.0098, 0.036],
			[0.0128, 0.038],
			[0.0128, 0.046],
			[0.0095, 0.046],
			[0.0095, 0.043],
			[0, 0.043],
		],
		0,
		0,
		0,
		20,
	);
	const merlons = [];
	for (let i = 0; i < 5; i++) {
		const a = (i / 5) * Math.PI * 2;
		merlons.push(
			box(0.0062, 0.006, 0.0034)
				.rotateY(a)
				.translate(Math.sin(a) * 0.0111, 0.049, Math.cos(a) * 0.0111),
		);
	}
	return [body, ...merlons];
}

function bishop() {
	return [
		lathe(
			[
				...BASE,
				[0.0112, 0.011],
				[0.0078, 0.024],
				[0.0066, 0.036],
				[0.0098, 0.0375],
				[0.0098, 0.0395],
				[0.0062, 0.041],
				[0.0078, 0.046],
				[0.0084, 0.052],
				[0.0068, 0.058],
				[0.0035, 0.0625],
				[0, 0.0645],
			],
			0,
			0,
			0,
			20,
		),
		sphere(0.0028, 0, 0.0665, 0, 8, 6),
	];
}

function queen() {
	const parts = [
		lathe(
			[
				...BASE,
				[0.0118, 0.011],
				[0.0082, 0.03],
				[0.0068, 0.05],
				[0.0108, 0.0525],
				[0.0108, 0.0548],
				[0.0072, 0.0565],
				[0.0096, 0.066],
				[0.0118, 0.072],
				[0.0074, 0.0735],
				[0.0042, 0.076],
				[0, 0.077],
			],
			0,
			0,
			0,
			20,
		),
		sphere(0.0038, 0, 0.0795, 0, 10, 7),
	];
	for (let i = 0; i < 8; i++) {
		const a = (i / 8) * Math.PI * 2;
		parts.push(sphere(0.0022, Math.sin(a) * 0.0112, 0.0728, Math.cos(a) * 0.0112, 6, 4));
	}
	return parts;
}

function king() {
	return [
		lathe(
			[
				...BASE,
				[0.012, 0.011],
				[0.0084, 0.032],
				[0.007, 0.054],
				[0.011, 0.0565],
				[0.011, 0.059],
				[0.0074, 0.0605],
				[0.0094, 0.07],
				[0.0108, 0.0765],
				[0.0072, 0.078],
				[0.004, 0.0805],
				[0, 0.081],
			],
			0,
			0,
			0,
			20,
		),
		box(0.0035, 0.013, 0.0035, 0, 0.0875, 0),
		box(0.0105, 0.0035, 0.0035, 0, 0.0885, 0),
	];
}

// The knight's head looks along +Z: a side profile (forward = +X) extruded across, turned so +X becomes +Z.
function knight() {
	const head = extrude(
		[
			[-0.009, 0],
			[0.0095, 0],
			[0.0075, 0.012],
			[0.0105, 0.021],
			[0.0145, 0.0285],
			[0.0148, 0.033],
			[0.0115, 0.0345],
			[0.006, 0.031],
			[0.0045, 0.037],
			[0.0065, 0.0445],
			[0.0025, 0.0515],
			[-0.0005, 0.0555],
			[-0.003, 0.0505],
			[-0.0085, 0.044],
			[-0.0115, 0.031],
			[-0.0115, 0.016],
		],
		0.011,
		0,
		0,
		0,
		0.0012,
	)
		.rotateY(-Math.PI / 2)
		.translate(0, 0.0085, 0);
	return [
		lathe([...BASE, [0.0118, 0.0105], [0, 0.0105]], 0, 0, 0, 20),
		head,
		sphere(0.0013, 0.0058, 0.0395, 0.007, 6, 4),
		sphere(0.0013, -0.0058, 0.0395, 0.007, 6, 4),
	];
}

// ---- dama: the man and the king (two stacked, crowned) ----

const DAMA = [
	[0, 0],
	[0.0215, 0],
	[0.0225, 0.0015],
	[0.0225, 0.0065],
	[0.0212, 0.008],
	[0.0175, 0.0082],
	[0.0168, 0.0072],
	[0.0118, 0.0072],
	[0.011, 0.0082],
	[0, 0.0082],
];

function damaMan() {
	return [lathe(DAMA, 0, 0, 0, 28)];
}

function damaKing() {
	const parts = [lathe(DAMA, 0, 0, 0, 28), lathe(DAMA, 0, 0.0084, 0, 28)];
	for (let i = 0; i < 6; i++) {
		const a = (i / 6) * Math.PI * 2;
		parts.push(
			box(0.0045, 0.0045, 0.0045, 0, 0, 0)
				.rotateY(a)
				.translate(Math.sin(a) * 0.0075, 0.0185, Math.cos(a) * 0.0075),
		);
	}
	parts.push(cyl(0.0075, 0.0085, 0.0024, 0, 0.0164, 0, 18));
	return parts;
}

// ---- tavla: board (0.60 × 0.44, rim 0.026 high), checker (Ø 0.03), die ----

const TAVLA = {
	half: {x: 0.3, z: 0.22},
	field: {x: 0.26, z: 0.187},
	bar: 0.017,
	surface: 0.008,
	rim: 0.026,
	barTop: 0.014,
	tray: {x: 0.28, z: 0.095},
};
const POINT_WIDTH = (TAVLA.field.x - TAVLA.bar) / 6;

// Point k (1..24) base centre on its outer edge (contract rev 3: white's edge +Z, white's home 1–6 at +X).
function pointBase(k) {
	const {field, bar} = TAVLA;
	if (k <= 6) return [field.x - POINT_WIDTH * (k - 0.5), field.z];
	if (k <= 12) return [-bar - POINT_WIDTH * (k - 6.5), field.z];
	if (k <= 18) return [-field.x + POINT_WIDTH * (k - 12.5), -field.z];
	return [bar + POINT_WIDTH * (k - 18.5), -field.z];
}

function tavlaBoard() {
	const room = new Room({
		ambient: '#3a3a3a',
		sky: '#9a9a9a',
		ground: '#303030',
		lights: [{direction: [-0.35, -0.85, -0.4], color: '#ffffff', intensity: 0.55}],
		ao: {distance: 0.05, strength: 0.6, rays: 10},
	});
	const {half, field, bar, surface, rim, barTop, tray} = TAVLA;
	const frame = '#4a2a18';
	const wood = '#a67c50';
	room.add(box(half.x * 2, surface, half.z * 2, 0, surface / 2, 0, [8, 1, 6]), frame);
	room.add(box(field.x * 2, 0.0006, field.z * 2, 0, surface + 0.0003, 0, [12, 1, 8]), wood);
	// rims
	room.add(
		rbox(half.x * 2, rim - surface, half.z - field.z, 0.003, 0, (surface + rim) / 2, (half.z + field.z) / 2),
		frame,
	);
	room.add(
		rbox(half.x * 2, rim - surface, half.z - field.z, 0.003, 0, (surface + rim) / 2, -(half.z + field.z) / 2),
		frame,
	);
	room.add(
		rbox(half.x - field.x, rim - surface, field.z * 2, 0.003, -(half.x + field.x) / 2, (surface + rim) / 2, 0),
		frame,
	);
	// right end: a narrow outer rim, the borne-off tray channel, the rim between it and the field
	room.add(box(0.003, rim - surface, field.z * 2, half.x - 0.0015, (surface + rim) / 2, 0), frame);
	room.add(box(0.003, rim - surface, field.z * 2, field.x + 0.0015, (surface + rim) / 2, 0), frame);
	room.add(box(tray.x * 2 - 2 * field.x - 0.006, 0.0006, field.z * 2, tray.x, surface + 0.0003, 0), '#5c3a22');
	room.add(box(0.034, 0.004, 0.006, tray.x, surface + 0.002, 0), frame);
	// the bar (and hinge)
	room.add(box(bar * 2, barTop - surface, field.z * 2, 0, (surface + barTop) / 2, 0), frame);
	room.add(box(0.004, 0.002, field.z * 2 - 0.02, 0, barTop + 0.001, 0), '#c9a24a');
	// points
	const length = field.z * 0.8;
	for (let k = 1; k <= 24; k++) {
		const [x, z] = pointBase(k);
		const s = Math.sign(z);
		const tri = extrude(
			[
				[-POINT_WIDTH * 0.46, 0],
				[POINT_WIDTH * 0.46, 0],
				[0, length],
			],
			0.0004,
		)
			.rotateX(Math.PI / 2)
			.rotateY(s > 0 ? Math.PI : 0)
			.translate(x, surface + 0.0009, z);
		room.add(tri, k % 2 ? '#7a1f22' : '#efe2c2', {flat: true});
	}
	room.bake();
	const items = [...room.buckets.values()].flatMap((bucket) => bucket.items);
	const g = mergeGeometries(
		items.map((item) => {
			const out = new BufferGeometry();
			out.setAttribute('position', item.geometry.getAttribute('position'));
			out.setAttribute('color', item.geometry.getAttribute('color'));
			return out;
		}),
	);
	return mergeVertices(g, 1e-6);
}

function checker() {
	return [
		lathe(
			[
				[0, 0],
				[0.0142, 0],
				[0.015, 0.0012],
				[0.015, 0.0068],
				[0.0142, 0.008],
				[0.011, 0.008],
				[0.0102, 0.0072],
				[0.0058, 0.0072],
				[0.005, 0.008],
				[0, 0.008],
			],
			0,
			0,
			0,
			28,
		),
	];
}

// Die body (edge 0.016) and its pips: +Y=1, −Y=6, +X=3, −X=4, +Z=2, −Z=5 (DiceAnimation FACE_NORMALS).
function die() {
	const e = 0.016;
	const body = rbox(e, e, e, 0.0024, 0, 0, 0, 3);
	const layouts = {
		1: [[0, 0]],
		2: [
			[-1, 1],
			[1, -1],
		],
		3: [
			[-1, 1],
			[0, 0],
			[1, -1],
		],
		4: [
			[-1, -1],
			[-1, 1],
			[1, -1],
			[1, 1],
		],
		5: [
			[-1, -1],
			[-1, 1],
			[0, 0],
			[1, -1],
			[1, 1],
		],
		6: [
			[-1, -1],
			[-1, 0],
			[-1, 1],
			[1, -1],
			[1, 0],
			[1, 1],
		],
	};
	const faces = [
		[1, (a, b, d) => [a, d, b]],
		[6, (a, b, d) => [a, -d, b]],
		[3, (a, b, d) => [d, a, b]],
		[4, (a, b, d) => [-d, a, b]],
		[2, (a, b, d) => [a, b, d]],
		[5, (a, b, d) => [a, b, -d]],
	];
	const pips = [];
	const step = e * 0.27;
	for (const [value, place] of faces)
		for (const [a, b] of layouts[value]) {
			const [x, y, z] = place(a * step, b * step, e / 2);
			pips.push(sphere(value === 1 ? 0.0022 : 0.0016, x, y, z, 8, 5));
		}
	return {body, pips};
}

// ---- okey: tile body + face (34 × 48 mm face on the body's +Z front, origin the middle of its base), rack ----

function okeyBody() {
	return [rbox(0.035, 0.0495, 0.011, 0.0028, 0, 0.0495 / 2, -0.0055, 2)];
}

function okeyFace() {
	const g = new BufferGeometry();
	const x = 0.017;
	const y0 = 0.00075;
	const y1 = 0.04875;
	const z = 0.0003;
	g.setAttribute('position', new BufferAttribute(new Float32Array([-x, y1, z, x, y1, z, x, y0, z, -x, y0, z]), 3));
	// glTF UV space: v = 0 at the top (the atlas is uploaded with flipY off).
	g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
	g.setIndex([0, 3, 2, 0, 2, 1]);
	return g;
}

// In tile-face units (face 0.048): shelves at y 0.012 / 0.039, rows at z +0.001 / −0.027, 15 slots 0.036 apart,
// end caps at ±0.289.
function okeyRack() {
	const half = 0.289;
	const parts = [
		box(half * 2, 0.012, 0.066, 0, 0.006, -0.017),
		box(half * 2, 0.008, 0.009, 0, 0.016, 0.0075),
		box(half * 2, 0.027, 0.0375, 0, 0.0255, -0.03125),
		extrude(
			[
				[-0.05, 0],
				[-0.042, 0],
				[-0.042, 0.039],
				[-0.044, 0.072],
				[-0.05, 0.072],
			],
			half * 2,
		).rotateY(-Math.PI / 2),
	];
	for (const s of [-1, 1])
		parts.push(
			extrude(
				[
					[-0.05, 0],
					[0.016, 0],
					[0.016, 0.022],
					[-0.012, 0.045],
					[-0.044, 0.074],
					[-0.05, 0.074],
				],
				0.008,
			)
				.rotateY(-Math.PI / 2)
				.translate(s * (half - 0.004), 0, 0),
		);
	return parts;
}

export function buildParts() {
	const images = [ramp()];
	const materials = [
		{name: 'piece', color: [1, 1, 1, 1], texture: 0},
		{name: 'pip', color: [0.02, 0.02, 0.025, 1]},
		{name: 'tavla', color: [1, 1, 1, 1]},
		{name: 'okey_body', color: [0.87, 0.81, 0.66, 1], texture: 0},
		{name: 'okey_face', color: [1, 1, 1, 1]},
		{name: 'wood', color: [0.42, 0.24, 0.12, 1], texture: 0},
	];
	const M = Object.fromEntries(materials.map((m, i) => [m.name, i]));
	const mesh = (name, primitives) => ({name, mesh: {name, primitives}});
	const nodes = [];
	const pieceSet = {k: king, q: queen, r: rook, b: bishop, n: knight, p: pawn, dm: damaMan, dk: damaKing};
	for (const [kind, make] of Object.entries(pieceSet))
		nodes.push(mesh(`piece_${kind}`, [{...shaded(make()), material: M.piece}]));
	const board = tavlaBoard();
	nodes.push({name: 'tavla_board', mesh: {name: 'tavla_board', primitives: [toPrimitive(board, M.tavla)]}});
	nodes.push(mesh('tavla_checker', [{...shaded(checker()), material: M.piece}]));
	const {body, pips} = die();
	nodes.push(
		mesh('tavla_die', [
			{...shaded([body]), material: M.piece},
			{...shaded(pips), material: M.pip},
		]),
	);
	nodes.push(mesh('okey_body', [{...shaded(okeyBody()), material: M.okey_body}]));
	nodes.push({name: 'okey_face', mesh: {name: 'okey_face', primitives: [toPrimitive(okeyFace(), M.okey_face)]}});
	nodes.push(mesh('okey_rack', [{...shaded(okeyRack()), material: M.wood}]));
	// tavla spots on the board (board-local; the board mesh sits at the node origin)
	for (let k = 1; k <= 24; k++) {
		const [px, pz] = pointBase(k);
		nodes.push({name: `tp_${String(k).padStart(2, '0')}`, translation: [px, TAVLA.surface, pz]});
	}
	nodes.push({name: 'tp_bar_w', translation: [0, TAVLA.barTop, 0.02]});
	nodes.push({name: 'tp_bar_b', translation: [0, TAVLA.barTop, -0.02]});
	nodes.push({name: 'tp_off_w', translation: [TAVLA.tray.x, TAVLA.surface, TAVLA.tray.z]});
	nodes.push({name: 'tp_off_b', translation: [TAVLA.tray.x, TAVLA.surface, -TAVLA.tray.z]});
	return {nodes, materials, images};
}
