#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds the 3D voice room manifest from validated room GLB files.
//   node tools/room_themes/build_manifest.mjs --rooms <dir> --out <dir> --manifest <ts> [--only a,b]
//   node tools/room_themes/build_manifest.mjs --rooms <dir> --manifest <ts> [--only a,b] --check
//   node tools/room_themes/build_manifest.mjs --self-test
//   … [--parts-manifest <ts> [--parts <glb>]] also writes (or checks) the table parts manifest; null without --parts.
// Every <dir>/<id>/<id>.glb is checked for room nodes, seats and cut-away extras; the parts file is checked
// separately. A file that breaks these constraints fails the whole run. Files are copied as <id>.<sha256 first 12 hex>.glb.

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

const MAX_BYTES = 8_000_000;
const ROOM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOUNGE_SEAT = /^seat_([A-Z][A-Z0-9]*)_([0-9]{2})$/;
const TABLE_SEAT = /^seat_(T[0-9]{2})_([1-4])$/;
// Watch seats beside a table; anything else shaped like one is a contract error.
const WATCH_SEAT = /^seat_(T[0-9]{2})_Y([1-4])$/;
const WATCH_LIKE = /^seat_T[0-9]{2}_Y/;
const TABLE = /^table_(T[0-9]{2})$/;
const STAND = /^stand_[0-9]{2}$/;
const REQUIRED = ['screen', 'cam_target', 'cam_home'];

// One table-parts GLB shared by every room, published as masa-parcalari.<hash>.glb.
const PARTS_ID = 'masa-parcalari';
const PARTS_MAX_BYTES = 1_500_000;
const PARTS_MAX_TRIANGLES = 30_000;
const PARTS_MAX_MATERIALS = 8;
const PART_MESHES = [
	'piece_k',
	'piece_q',
	'piece_r',
	'piece_b',
	'piece_n',
	'piece_p',
	'piece_dm',
	'piece_dk',
	'tavla_board',
	'tavla_checker',
	'tavla_die',
	'okey_face',
	'okey_body',
	'okey_rack',
];
const PART_EMPTIES = [
	...Array.from({length: 24}, (_, i) => `tp_${String(i + 1).padStart(2, '0')}`),
	'tp_bar_w',
	'tp_bar_b',
	'tp_off_w',
	'tp_off_b',
];

function readGlbJson(buffer) {
	if (buffer.length < 20) throw new Error('not a GLB: shorter than the header');
	if (buffer.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB: bad magic');
	if (buffer.readUInt32LE(4) !== 2) throw new Error('GLB version is not 2');
	if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB header length does not match the file size');
	const chunkLength = buffer.readUInt32LE(12);
	if (buffer.toString('ascii', 16, 20) !== 'JSON') throw new Error('first GLB chunk is not JSON');
	if (20 + chunkLength > buffer.length) throw new Error('JSON chunk runs past the end of the file');
	return JSON.parse(buffer.toString('utf8', 20, 20 + chunkLength));
}

// An optional extras number: absent passes, anything but a number in [min, max] is a contract error.
function checkRange(node, key, min, max) {
	const value = node.extras?.[key];
	if (value !== undefined && !(typeof value === 'number' && value >= min && value <= max))
		throw new Error(`${node.name} ${key} is not a number in [${min}, ${max}]`);
}

// Four wall groups with `wall_plane: [px, pz,
// nx, nz]` (outward unit normal) and one ceiling group with `ceiling_y`, found by extras like the client's
// GlbRoomContract (names are only labels); `zoom_min` at most 0.25 (the client reads [0.08, 1]); `tv_view_deg` 30–90.
function checkCutaway(gltfNodes, nodes) {
	let walls = 0;
	let ceilings = 0;
	for (const {name = '(unnamed node)', extras} of gltfNodes) {
		if (extras && 'wall_plane' in extras) {
			const plane = extras.wall_plane;
			if (
				!Array.isArray(plane) ||
				plane.length !== 4 ||
				!plane.every(Number.isFinite) ||
				Math.abs(Math.hypot(plane[2], plane[3]) - 1) > 0.01
			)
				throw new Error(`${name} has a malformed wall_plane`);
			walls++;
		}
		if (extras && 'ceiling_y' in extras) {
			if (!Number.isFinite(extras.ceiling_y)) throw new Error(`${name} has a malformed ceiling_y`);
			ceilings++;
		}
	}
	if (walls !== 4) throw new Error(`${walls} wall groups, not 4`);
	if (ceilings !== 1) throw new Error(`${ceilings} ceiling groups, not 1`);
	checkRange(nodes.get('cam_target'), 'zoom_min', 0.08, 0.25);
	checkRange(nodes.get('screen'), 'tv_view_deg', 30, 90);
}

export function inspectRoom(buffer) {
	if (buffer.length > MAX_BYTES) throw new Error(`${buffer.length} bytes is over the ${MAX_BYTES} byte limit`);
	const gltfNodes = readGlbJson(buffer).nodes ?? [];
	const nodes = new Map(gltfNodes.filter((node) => node.name).map((node) => [node.name, node]));
	const names = new Set(nodes.keys());
	const lounge = [];
	const watch = [];
	const tableSeats = new Map();
	const groups = new Set();
	let stands = 0;
	for (const name of names) {
		const loungeMatch = LOUNGE_SEAT.exec(name);
		const tableMatch = TABLE_SEAT.exec(name);
		const watchMatch = WATCH_SEAT.exec(name);
		if (watchMatch) {
			watch.push({name, slot: watchMatch[1]});
		} else if (WATCH_LIKE.test(name)) {
			throw new Error(`${name} is not a watch seat name (seat_T<NN>_Y1..4)`);
		} else if (tableMatch) {
			groups.add(tableMatch[1]);
			tableSeats.set(tableMatch[1], (tableSeats.get(tableMatch[1]) ?? 0) + 1);
		} else if (loungeMatch) {
			groups.add(loungeMatch[1]);
			lounge.push({name, group: loungeMatch[1], index: Number(loungeMatch[2])});
		} else if (STAND.test(name)) {
			stands++;
		}
	}
	for (const name of REQUIRED) {
		if (!names.has(name)) throw new Error(`missing ${name}`);
	}
	checkCutaway(gltfNodes, nodes);
	const slots = [...names].map((name) => TABLE.exec(name)?.[1]).filter(Boolean);
	for (const slot of slots) {
		const topSize = nodes.get(`table_${slot}`).extras?.top_size;
		if (!(Number.isFinite(topSize) && topSize > 0)) throw new Error(`table_${slot} needs a positive top_size`);
		if (tableSeats.get(slot) !== 4) throw new Error(`table_${slot} needs seat_${slot}_1..4`);
	}
	for (const slot of tableSeats.keys()) {
		if (!slots.includes(slot)) throw new Error(`seat_${slot}_* has no table_${slot}`);
	}
	for (const seat of watch) {
		if (!slots.includes(seat.slot)) throw new Error(`${seat.name} has no table_${seat.slot}`);
	}
	const seatCount = lounge.length + slots.length * 4;
	if (seatCount < 16) throw new Error(`${seatCount} seats, needs at least 16`);
	if (stands < 10) throw new Error(`${stands} standing spots, needs at least 10`);
	if (groups.size < 3) throw new Error(`${groups.size} seat groups, needs at least 3`);
	if (slots.length < 1) throw new Error('needs at least one game table');
	lounge.sort((a, b) => (a.group === b.group ? a.index - b.index : a.group < b.group ? -1 : 1));
	slots.sort();
	return {
		bytes: buffer.length,
		hash: createHash('sha256').update(buffer).digest('hex').slice(0, 12),
		seats: lounge.map((seat) => seat.name),
		watch_seats: watch.map((seat) => seat.name).sort(),
		tables: slots.map((slot) => ({slot, seats: 4})),
		stands,
	};
}

// Lays arrays out the way biome does (one line if it fits in 120 columns with tab = 2; several objects always
// break), so the generated file passes `biome ci` unchanged.
function arrayLine(indent, key, items, objects = false) {
	const oneLine = `${'\t'.repeat(indent)}${key}: [${items.join(', ')}],`;
	if (oneLine.length + indent <= 120 && !(objects && items.length > 1)) return [oneLine];
	return [
		`${'\t'.repeat(indent)}${key}: [`,
		...items.map((item) => `${'\t'.repeat(indent + 1)}${item},`),
		`${'\t'.repeat(indent)}],`,
	];
}

export function renderManifest(rooms) {
	const lines = [
		'// SPDX-License-Identifier: AGPL-3.0-or-later',
		'',
		'// Generated by tools/room_themes/build_manifest.mjs from validated room GLB files. Do not edit by hand.',
		'',
		'export interface VoiceRoomThemeManifestEntry {',
		'\treadonly file: string;',
		'\treadonly bytes: number;',
		'\treadonly seats: ReadonlyArray<string>;',
		'\treadonly watch_seats: ReadonlyArray<string>;',
		'\treadonly tables: ReadonlyArray<{readonly slot: string; readonly seats: 4}>;',
		'\treadonly stands: number;',
		'}',
		'',
		'export const VOICE_ROOM_THEME_MANIFEST = {',
	];
	for (const [id, room] of rooms) {
		lines.push(
			`\t${/^[a-z]+$/.test(id) ? id : `'${id}'`}: {`,
			`\t\tfile: '${id}.${room.hash}.glb',`,
			`\t\tbytes: ${room.bytes},`,
			...arrayLine(
				2,
				'seats',
				room.seats.map((seat) => `'${seat}'`),
			),
			...arrayLine(
				2,
				'watch_seats',
				room.watch_seats.map((seat) => `'${seat}'`),
			),
			...arrayLine(
				2,
				'tables',
				room.tables.map((table) => `{slot: '${table.slot}', seats: 4}`),
				true,
			),
			`\t\tstands: ${room.stands},`,
			'\t},',
		);
	}
	lines.push('} as const satisfies Record<string, VoiceRoomThemeManifestEntry>;', '');
	return lines.join('\n');
}

export function inspectParts(buffer) {
	if (buffer.length > PARTS_MAX_BYTES)
		throw new Error(`${buffer.length} bytes is over the ${PARTS_MAX_BYTES} byte limit`);
	const gltf = readGlbJson(buffer);
	const nodes = new Map((gltf.nodes ?? []).filter((node) => node.name).map((node) => [node.name, node]));
	for (const name of PART_MESHES) {
		if (nodes.get(name)?.mesh === undefined) throw new Error(`missing ${name} mesh`);
	}
	for (const name of PART_EMPTIES) {
		if (!nodes.has(name)) throw new Error(`missing ${name}`);
	}
	const materials = gltf.materials?.length ?? 0;
	if (materials > PARTS_MAX_MATERIALS) throw new Error(`${materials} materials, over ${PARTS_MAX_MATERIALS}`);
	// TEMPORARY: counts triangle-list primitives only (what Blender exports); dogrula_parca.py checks the real mesh.
	let triangles = 0;
	for (const node of gltf.nodes ?? []) {
		if (node.mesh === undefined) continue;
		for (const primitive of gltf.meshes[node.mesh].primitives) {
			triangles += Math.floor(gltf.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3);
		}
	}
	if (triangles > PARTS_MAX_TRIANGLES) throw new Error(`${triangles} triangles, over ${PARTS_MAX_TRIANGLES}`);
	return {bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex').slice(0, 12)};
}

export function renderPartsManifest(parts) {
	const type = '{readonly file: string; readonly bytes: number} | null';
	const value = parts ? `{\n\tfile: '${PARTS_ID}.${parts.hash}.glb',\n\tbytes: ${parts.bytes},\n}` : 'null';
	return [
		'// SPDX-License-Identifier: AGPL-3.0-or-later',
		'',
		'// Generated by tools/room_themes/build_manifest.mjs from the validated table parts GLB file. Do not edit by hand.',
		'',
		'// null: no parts file yet; clients keep the 2D table top texture and never mount a 3D table.',
		`export const VOICE_ROOM_PARTS_MANIFEST: ${type} = ${value};`,
		'',
	].join('\n');
}

function fakeGlb(nodes, padTo = 0, extra = {}) {
	let json = Buffer.from(JSON.stringify({asset: {version: '2.0'}, nodes, ...extra}));
	const padded = Math.max(json.length, padTo - 20);
	json = Buffer.concat([json, Buffer.alloc(padded - json.length + ((4 - (padded % 4)) % 4), 0x20)]);
	const header = Buffer.alloc(20);
	header.write('glTF', 0, 'ascii');
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(20 + json.length, 8);
	header.writeUInt32LE(json.length, 12);
	header.write('JSON', 16, 'ascii');
	return Buffer.concat([header, json]);
}

function selfTest() {
	const walls = [
		{name: 'wall_N', extras: {wall_plane: [0, -4, 0, -1]}},
		{name: 'wall_E', extras: {wall_plane: [9, 0, 1, 0]}},
		{name: 'wall_S', extras: {wall_plane: [0, 4, 0, 1]}},
		{name: 'wall_W', extras: {wall_plane: [-9, 0, -1, 0]}},
	];
	const nodes = [
		{name: 'cam_home'},
		{name: 'cam_target'},
		{name: 'screen', mesh: 0},
		...walls,
		{name: 'ceiling', extras: {ceiling_y: 4.65}},
		{name: 'table_T01', extras: {top_size: 1.3}},
		...[1, 2, 3, 4].map((k) => ({name: `seat_T01_${k}`})),
		...['B_02', 'A_10', 'A_02', 'B_01', 'C_01', 'A_01'].map((s) => ({name: `seat_${s}`})),
		...Array.from({length: 6}, (_, i) => ({name: `seat_D_0${i + 1}`})),
		...Array.from({length: 10}, (_, i) => ({name: `stand_${String(i + 1).padStart(2, '0')}`})),
	];
	const room = inspectRoom(fakeGlb(nodes));
	assert.deepEqual(room.seats.slice(0, 6), [
		'seat_A_01',
		'seat_A_02',
		'seat_A_10',
		'seat_B_01',
		'seat_B_02',
		'seat_C_01',
	]);
	assert.ok(!room.seats.some((seat) => seat.startsWith('seat_T')), 'table seats stay out of lounge seats');
	assert.deepEqual(room.tables, [{slot: 'T01', seats: 4}]);
	assert.equal(room.stands, 10);
	assert.match(room.hash, /^[0-9a-f]{12}$/);
	assert.throws(() => inspectRoom(fakeGlb(nodes.filter((n) => n.name !== 'seat_T01_3'))), /seat_T01_1\.\.4/);
	assert.throws(() => inspectRoom(fakeGlb(nodes.filter((n) => n.name !== 'screen'))), /missing screen/);
	assert.throws(() => inspectRoom(fakeGlb(nodes, MAX_BYTES + 1)), /over the 8000000 byte limit/);
	assert.match(renderManifest([['test-room', room]]), /'test-room': \{\n\t\tfile: 'test-room\.[0-9a-f]{12}\.glb',/);

	// Watch seats: their own list, never lounge seats, not counted towards the 16 seat minimum.
	assert.deepEqual(room.watch_seats, []);
	const watchNodes = [...nodes, ...[2, 1, 4].map((k) => ({name: `seat_T01_Y${k}`}))];
	const watched = inspectRoom(fakeGlb(watchNodes));
	assert.deepEqual(watched.watch_seats, ['seat_T01_Y1', 'seat_T01_Y2', 'seat_T01_Y4']);
	assert.deepEqual(watched.seats, room.seats);
	assert.throws(() => inspectRoom(fakeGlb([...nodes, {name: 'seat_T02_Y1'}])), /seat_T02_Y1 has no table_T02/);
	assert.throws(() => inspectRoom(fakeGlb([...nodes, {name: 'seat_T01_Y5'}])), /seat_T01_Y5/);
	assert.throws(
		() => inspectRoom(fakeGlb(watchNodes.filter((n) => n.name !== 'seat_D_06'))),
		/15 seats, needs at least 16/,
	);
	assert.match(
		renderManifest([['test-room', watched]]),
		/\twatch_seats: \['seat_T01_Y1', 'seat_T01_Y2', 'seat_T01_Y4'\],/,
	);

	// Cut-away extras: four wall groups and one ceiling, found by extras.
	const swap = (name, node) => nodes.map((n) => (n.name === name ? node : n));
	assert.throws(() => inspectRoom(fakeGlb(nodes.filter((n) => n.name !== 'wall_E'))), /3 wall groups, not 4/);
	assert.throws(() => inspectRoom(fakeGlb([...nodes, {extras: {wall_plane: [0, 0, 1, 0]}}])), /5 wall groups/);
	for (const plane of [[9, 0, 1], [9, 0, 2, 0], [9, 0, 0.7, 0.7], [9, 'x', 1, 0], null]) {
		const bad = swap('wall_E', {name: 'wall_E', extras: {wall_plane: plane}});
		assert.throws(() => inspectRoom(fakeGlb(bad)), /wall_E has a malformed wall_plane/, JSON.stringify(plane));
	}
	assert.throws(() => inspectRoom(fakeGlb(nodes.filter((n) => n.name !== 'ceiling'))), /0 ceiling groups, not 1/);
	for (const y of ['4', null]) {
		const bad = swap('ceiling', {name: 'ceiling', extras: {ceiling_y: y}});
		assert.throws(() => inspectRoom(fakeGlb(bad)), /ceiling has a malformed ceiling_y/);
	}
	// zoom_min is optional (Gece Lounge has none); Kahvehane 0.08 and Oyun Odası 0.1469 pass, 0.25 is the cap.
	for (const zoom of [0.08, 0.1469, 0.25]) {
		inspectRoom(fakeGlb(swap('cam_target', {name: 'cam_target', extras: {zoom_min: zoom}})));
	}
	for (const zoom of [0.07, 0.26, 0.62, '0.1']) {
		const bad = swap('cam_target', {name: 'cam_target', extras: {zoom_min: zoom}});
		assert.throws(() => inspectRoom(fakeGlb(bad)), /cam_target zoom_min is not a number in \[0\.08, 0\.25\]/);
	}
	for (const deg of [30, 55, 90]) {
		inspectRoom(fakeGlb(swap('screen', {name: 'screen', mesh: 0, extras: {tv_view_deg: deg}})));
	}
	for (const deg of [29, 91, '55']) {
		const bad = swap('screen', {name: 'screen', mesh: 0, extras: {tv_view_deg: deg}});
		assert.throws(() => inspectRoom(fakeGlb(bad)), /screen tv_view_deg is not a number in \[30, 90\]/);
	}

	// Table parts file: every part name (okey face and body are two meshes) and the budget.
	const fakeParts = ({omit = null, padTo = 0, triangles = 1} = {}) => {
		const materials = [{name: 'piece'}];
		const meshes = PART_MESHES.map((name) => ({name, primitives: [{indices: 0, material: 0}]}));
		const partNodes = [
			...PART_MESHES.map((name, mesh) => ({name, mesh})),
			...PART_EMPTIES.map((name) => ({name})),
		].filter((node) => node.name !== omit);
		return fakeGlb(partNodes, padTo, {materials, meshes, accessors: [{count: triangles * 3}]});
	};
	const parts = inspectParts(fakeParts());
	assert.match(parts.hash, /^[0-9a-f]{12}$/);
	assert.throws(() => inspectParts(fakeParts({omit: 'piece_dk'})), /missing piece_dk/);
	assert.throws(() => inspectParts(fakeParts({omit: 'okey_face'})), /missing okey_face mesh/);
	assert.throws(() => inspectParts(fakeParts({omit: 'tp_bar_w'})), /missing tp_bar_w/);
	assert.throws(() => inspectParts(fakeParts({padTo: PARTS_MAX_BYTES + 1})), /over the 1500000 byte limit/);
	assert.throws(() => inspectParts(fakeParts({triangles: 3000})), /triangles, over 30000/);
	assert.match(renderPartsManifest(parts), /\tfile: 'masa-parcalari\.[0-9a-f]{12}\.glb',\n\tbytes: \d+,\n\};\n$/);
	assert.match(renderPartsManifest(null), / = null;\n$/);
	console.log('build_manifest self-test: ok');
}

function main() {
	const {values} = parseArgs({
		options: {
			rooms: {type: 'string'},
			out: {type: 'string'},
			manifest: {type: 'string'},
			only: {type: 'string'},
			parts: {type: 'string'},
			'parts-manifest': {type: 'string'},
			check: {type: 'boolean', default: false},
			'self-test': {type: 'boolean', default: false},
		},
	});
	if (values['self-test']) return selfTest();
	if (
		!values.rooms ||
		!values.manifest ||
		(!values.check && !values.out) ||
		(values.parts && !values['parts-manifest'])
	) {
		throw new Error(
			'usage: --rooms <dir> --manifest <ts> (--out <dir> | --check) [--only a,b] [--parts-manifest <ts> [--parts <glb>]] | --self-test',
		);
	}
	let parts = null;
	if (values.parts) {
		try {
			parts = {...inspectParts(readFileSync(values.parts)), path: values.parts};
		} catch (error) {
			throw new Error(`${PARTS_ID}: ${error.message}`);
		}
	}
	const ids = values.only
		? values.only.split(',')
		: readdirSync(values.rooms, {withFileTypes: true})
				.filter((entry) => entry.isDirectory() && existsSync(join(values.rooms, entry.name, `${entry.name}.glb`)))
				.map((entry) => entry.name);
	const rooms = [];
	for (const id of ids.sort()) {
		if (!ROOM_ID.test(id)) throw new Error(`room id ${id} must be lowercase ASCII words joined by dashes`);
		const path = join(values.rooms, id, `${id}.glb`);
		let room;
		try {
			room = inspectRoom(readFileSync(path));
		} catch (error) {
			throw new Error(`${id}: ${error.message}`);
		}
		rooms.push([id, {...room, path}]);
	}
	if (rooms.length === 0) throw new Error('no rooms found');
	const outputs = [[values.manifest, renderManifest(rooms)]];
	if (values['parts-manifest']) outputs.push([values['parts-manifest'], renderPartsManifest(parts)]);
	if (values.check) {
		for (const [path, text] of outputs) {
			const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
			if (current !== text) throw new Error(`${path} does not match the GLB files; rebuild it`);
		}
		console.log(`manifest matches ${rooms.length} room(s)${values['parts-manifest'] ? ' and the parts file' : ''}`);
		return;
	}
	mkdirSync(values.out, {recursive: true});
	const files = rooms.map(([id, room]) => [room.path, `${id}.${room.hash}.glb`, room.bytes]);
	if (parts) files.push([parts.path, `${PARTS_ID}.${parts.hash}.glb`, parts.bytes]);
	for (const [path, name] of files) copyFileSync(path, join(values.out, name));
	for (const [path, text] of outputs) writeFileSync(path, text);
	console.log(files.map(([, name, bytes]) => `${name} ${bytes} bytes`).join('\n'));
}

try {
	main();
} catch (error) {
	console.error(`build_manifest: ${error.message}`);
	process.exit(1);
}
