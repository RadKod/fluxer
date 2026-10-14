// SPDX-License-Identifier: AGPL-3.0-or-later

// A small glTF 2.0 binary writer: unlit materials (KHR_materials_unlit), optional PNG textures, nodes with names and
// extras written exactly as given. GLTFExporter needs a DOM canvas for textures; this one needs nothing but Node.

import {deflateSync} from 'node:zlib';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const CLAMP_TO_EDGE = 33071;

const TYPE_BY_SIZE = {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4'};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

// 8-bit RGB PNG from a width × height × 3 byte array.
export function encodePng(width, height, rgb) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const raw = Buffer.alloc(height * (width * 3 + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (width * 3 + 1)] = 0;
		Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw, {level: 9})),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

// scene: {nodes: [Node], materials: [Material], images: [Buffer png]}
// Node: {name, translation?, rotation?, scale?, extras?, mesh?: {name?, primitives: [Primitive]}, children?: [Node]}
// Primitive: {attributes: {POSITION, NORMAL?, COLOR_0?, TEXCOORD_0?} (Float32Array), indices?, material}
// Material: {name, color: [r, g, b, a] linear, texture?: image index, transparent?, doubleSided?}
export function writeGlb(scene) {
	const chunks = [];
	let byteLength = 0;
	const bufferViews = [];
	const accessors = [];
	const meshes = [];
	const nodes = [];

	const addView = (bytes, target) => {
		const pad = (4 - (byteLength % 4)) % 4;
		if (pad) {
			chunks.push(Buffer.alloc(pad));
			byteLength += pad;
		}
		const view = {buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength};
		if (target) view.target = target;
		chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		byteLength += bytes.byteLength;
		bufferViews.push(view);
		return bufferViews.length - 1;
	};

	const addAccessor = (array, size, {target, minMax = false} = {}) => {
		const count = array.length / size;
		const componentType =
			array instanceof Float32Array ? FLOAT : array instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT;
		const accessor = {bufferView: addView(array, target), componentType, count, type: TYPE_BY_SIZE[size]};
		if (minMax) {
			const min = Array(size).fill(Infinity);
			const max = Array(size).fill(-Infinity);
			for (let i = 0; i < count; i++)
				for (let k = 0; k < size; k++) {
					const value = array[i * size + k];
					if (value < min[k]) min[k] = value;
					if (value > max[k]) max[k] = value;
				}
			accessor.min = min;
			accessor.max = max;
		}
		accessors.push(accessor);
		return accessors.length - 1;
	};

	const SIZES = {POSITION: 3, NORMAL: 3, COLOR_0: 3, TEXCOORD_0: 2};
	const addMesh = (mesh) => {
		const primitives = mesh.primitives.map((primitive) => {
			const attributes = {};
			for (const [key, array] of Object.entries(primitive.attributes)) {
				if (!array) continue;
				attributes[key] = addAccessor(array, SIZES[key], {target: ARRAY_BUFFER, minMax: key === 'POSITION'});
			}
			const out = {attributes, material: primitive.material};
			if (primitive.indices) {
				const vertexCount = primitive.attributes.POSITION.length / 3;
				const indices = vertexCount < 65536 ? Uint16Array.from(primitive.indices) : Uint32Array.from(primitive.indices);
				out.indices = addAccessor(indices, 1, {target: ELEMENT_ARRAY_BUFFER});
			}
			return out;
		});
		meshes.push({...(mesh.name ? {name: mesh.name} : {}), primitives});
		return meshes.length - 1;
	};

	const addNode = (node) => {
		const out = {};
		if (node.name) out.name = node.name;
		if (node.translation?.some((v) => v !== 0)) out.translation = node.translation.map(round);
		if (node.rotation && !(node.rotation[3] === 1)) out.rotation = node.rotation;
		if (node.scale?.some((v) => v !== 1)) out.scale = node.scale;
		if (node.extras) out.extras = node.extras;
		if (node.mesh) out.mesh = addMesh(node.mesh);
		const index = nodes.length;
		nodes.push(out);
		if (node.children?.length) out.children = node.children.map(addNode);
		return index;
	};

	const roots = scene.nodes.map(addNode);

	const images = (scene.images ?? []).map((png) => ({bufferView: addView(png), mimeType: 'image/png'}));
	const textures = images.map((_, source) => ({sampler: 0, source}));
	const materials = scene.materials.map((material) => {
		const pbr = {baseColorFactor: material.color, metallicFactor: 0, roughnessFactor: 1};
		if (material.texture !== undefined) pbr.baseColorTexture = {index: material.texture};
		const out = {name: material.name, pbrMetallicRoughness: pbr, extensions: {KHR_materials_unlit: {}}};
		if (material.transparent) out.alphaMode = 'BLEND';
		if (material.doubleSided) out.doubleSided = true;
		return out;
	});

	const pad = (4 - (byteLength % 4)) % 4;
	if (pad) {
		chunks.push(Buffer.alloc(pad));
		byteLength += pad;
	}
	const json = {
		asset: {version: '2.0', generator: 'sanalyer tools/room_themes'},
		extensionsUsed: ['KHR_materials_unlit'],
		scene: 0,
		scenes: [{nodes: roots}],
		nodes,
		meshes,
		materials,
		accessors,
		bufferViews,
		buffers: [{byteLength}],
	};
	if (images.length) {
		json.images = images;
		json.textures = textures;
		json.samplers = [{magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE}];
	}
	let jsonBytes = Buffer.from(JSON.stringify(json));
	jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
	const bin = Buffer.concat(chunks);
	const header = Buffer.alloc(12);
	header.write('glTF', 0, 'ascii');
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
	const jsonHeader = Buffer.alloc(8);
	jsonHeader.writeUInt32LE(jsonBytes.length, 0);
	jsonHeader.write('JSON', 4, 'ascii');
	const binHeader = Buffer.alloc(8);
	binHeader.writeUInt32LE(bin.length, 0);
	binHeader.write('BIN\0', 4, 'binary');
	return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

function round(value) {
	return Math.round(value * 1e5) / 1e5;
}
