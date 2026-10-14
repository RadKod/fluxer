// SPDX-License-Identifier: AGPL-3.0-or-later

// Room assembly and light baking. The client draws rooms unlit (MeshBasicMaterial from KHR_materials_unlit, no
// lights, no tone mapping), so every surface carries its lighting in its vertex colours: ambient + sky/ground +
// point and directional lights with ray-traced soft shadows + short-range ambient occlusion, all in linear space.

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DoubleSide,
	Matrix4,
	MeshBVH,
	mergeGeometries,
	mergeVertices,
	Quaternion,
	Ray,
	Vector3,
} from './three.mjs';

export const linear = (hex) => new Color(hex);

// A deterministic generator, so a rebuild writes the same bytes (and the same hashed file name).
export function rng(seed = 1) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

// Cosine-weighted hemisphere directions around +Z (rotated onto each normal).
function hemisphere(count, random) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const u = (i + random()) / count;
		const phi = 2 * Math.PI * ((i * 0.618034) % 1);
		const r = Math.sqrt(u);
		out.push(new Vector3(r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)));
	}
	return out;
}

export class Room {
	constructor({ambient = '#202020', sky = '#303030', ground = '#101010', lights = [], ao = {}, seed = 7} = {}) {
		this.ambient = linear(ambient);
		this.sky = linear(sky);
		this.ground = linear(ground);
		this.lights = lights.map((light) => ({
			...light,
			color: linear(light.color ?? '#ffffff').multiplyScalar(light.intensity ?? 1),
			position: light.position ? new Vector3(...light.position) : null,
			direction: light.direction ? new Vector3(...light.direction).normalize() : null,
		}));
		this.ao = {distance: 0.6, strength: 0.75, rays: 12, ...ao};
		this.random = rng(seed);
		this.buckets = new Map();
		this.empties = [];
		this.stack = [new Matrix4()];
		this.current = null;
		this.useBucket('room');
	}

	// parent: the name of an earlier bucket this one's node hangs under (the TV screen in its wall group).
	useBucket(name, extras, parent) {
		if (!this.buckets.has(name)) this.buckets.set(name, {name, extras, parent, items: []});
		else if (extras) this.buckets.get(name).extras = extras;
		this.current = this.buckets.get(name);
		return this;
	}

	// Runs fn with (x, y, z, yaw) appended to the transform stack.
	at(x, y, z, yaw, fn) {
		const top = this.stack.at(-1);
		const local = new Matrix4().compose(
			new Vector3(x, y, z),
			new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw ?? 0),
			new Vector3(1, 1, 1),
		);
		this.stack.push(top.clone().multiply(local));
		try {
			fn();
		} finally {
			this.stack.pop();
		}
	}

	// A point light at a local position (lamps place their own light).
	light(x, y, z, {color = '#ffffff', intensity = 1, ...rest} = {}) {
		const p = this.worldPoint(x, y, z);
		this.lights.push({
			...rest,
			color: linear(color).multiplyScalar(intensity),
			position: p,
			direction: null,
		});
		return this;
	}

	worldPoint(x, y, z) {
		return new Vector3(x, y, z).applyMatrix4(this.stack.at(-1));
	}

	// opts: emissive (multiplier of the colour, unlit), glass, cast (default true), flat (face normals), bucket
	add(geometry, color, opts = {}) {
		const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
		g.deleteAttribute('uv');
		if (!g.getAttribute('normal') || opts.flat) {
			g.deleteAttribute('normal');
			g.computeVertexNormals();
		}
		g.applyMatrix4(this.stack.at(-1));
		const bucket = opts.bucket ? this.buckets.get(opts.bucket) : this.current;
		bucket.items.push({
			geometry: g,
			albedo: linear(color),
			emissive: opts.emissive ?? 0,
			glass: opts.glass ?? false,
			cast: opts.cast ?? !opts.glass,
			keepNormals: opts.keepNormals ?? false,
			lit: opts.lit ?? 1,
		});
		return this;
	}

	empty(name, x, y, z, extras) {
		const p = this.worldPoint(x, y, z);
		this.empties.push({name, translation: [p.x, p.y, p.z], ...(extras ? {extras} : {})});
		return p;
	}

	triangleCount() {
		let count = 0;
		for (const bucket of this.buckets.values())
			for (const item of bucket.items) count += item.geometry.getAttribute('position').count / 3;
		return count;
	}

	bake() {
		const casters = [];
		for (const bucket of this.buckets.values())
			for (const item of bucket.items) if (item.cast && !item.emissive) casters.push(positionsOnly(item.geometry));
		const merged = mergeGeometries(casters);
		const bvh = new MeshBVH(merged);
		const dirs = hemisphere(this.ao.rays, this.random);
		const ray = new Ray();
		const tangent = new Vector3();
		const bitangent = new Vector3();
		const n = new Vector3();
		const p = new Vector3();
		const target = new Vector3();
		const toLight = new Vector3();
		const jitter = [
			new Vector3(0, 0, 0),
			new Vector3(1, 0.3, -0.5),
			new Vector3(-0.6, -0.4, 0.9),
			new Vector3(-0.3, 0.8, -0.7),
		].map((v) => v.normalize());
		jitter[0].set(0, 0, 0);
		const sum = new Color();
		const blocked = (origin, direction, far) => {
			ray.origin.copy(origin);
			ray.direction.copy(direction);
			return bvh.raycastFirst(ray, DoubleSide, 0, far) !== null;
		};
		for (const bucket of this.buckets.values())
			for (const item of bucket.items) {
				const position = item.geometry.getAttribute('position');
				const normal = item.geometry.getAttribute('normal');
				const colors = new Float32Array(position.count * 3);
				for (let i = 0; i < position.count; i++) {
					if (item.emissive) {
						colors[i * 3] = item.albedo.r * item.emissive;
						colors[i * 3 + 1] = item.albedo.g * item.emissive;
						colors[i * 3 + 2] = item.albedo.b * item.emissive;
						continue;
					}
					p.fromBufferAttribute(position, i);
					n.fromBufferAttribute(normal, i).normalize();
					const origin = p.clone().addScaledVector(n, 0.006);
					// sky / ground
					const up = n.y * 0.5 + 0.5;
					sum.copy(this.ground).lerp(this.sky, up).add(this.ambient);
					for (const light of this.lights) {
						if (light.position) {
							toLight.subVectors(light.position, p);
							const d = toLight.length();
							const range = light.range ?? 4;
							if (d > range * 4) continue;
							toLight.divideScalar(d);
							const wrap = light.wrap ?? 0.2;
							const ndl = (n.dot(toLight) + wrap) / (1 + wrap);
							if (ndl <= 0) continue;
							let falloff = (range * range) / (range * range + d * d);
							falloff *= Math.max(0, 1 - (d / (range * 4)) ** 2);
							if (light.down) falloff *= Math.max(0.25, -toLight.y) ** light.down;
							let visible = 1;
							if (light.shadow !== false) {
								const radius = light.radius ?? 0.12;
								let lit = 0;
								for (const offset of jitter) {
									target.copy(light.position).addScaledVector(offset, radius).sub(origin);
									const far = target.length() - 0.05;
									if (!blocked(origin, target.normalize(), far)) lit++;
								}
								visible = lit / jitter.length;
							}
							sum.r += light.color.r * ndl * falloff * visible;
							sum.g += light.color.g * ndl * falloff * visible;
							sum.b += light.color.b * ndl * falloff * visible;
						} else if (light.direction) {
							const ndl = -n.dot(light.direction);
							if (ndl <= 0) continue;
							const visible =
								light.shadow === false ? 1 : blocked(origin, toLight.copy(light.direction).negate(), 40) ? 0 : 1;
							sum.r += light.color.r * ndl * visible;
							sum.g += light.color.g * ndl * visible;
							sum.b += light.color.b * ndl * visible;
						}
					}
					// ambient occlusion
					let occlusion = 0;
					if (this.ao.strength > 0) {
						tangent
							.set(Math.abs(n.x) > 0.9 ? 0 : 1, Math.abs(n.x) > 0.9 ? 1 : 0, 0)
							.cross(n)
							.normalize();
						bitangent.crossVectors(n, tangent);
						const spin = (((i * 2654435761) % 1000) / 1000) * Math.PI * 2;
						const c = Math.cos(spin);
						const s = Math.sin(spin);
						for (const d of dirs) {
							const x = d.x * c - d.y * s;
							const y = d.x * s + d.y * c;
							toLight.set(0, 0, 0).addScaledVector(tangent, x).addScaledVector(bitangent, y).addScaledVector(n, d.z);
							ray.origin.copy(origin);
							ray.direction.copy(toLight);
							const hit = bvh.raycastFirst(ray, DoubleSide, 0, this.ao.distance);
							if (hit) occlusion += 1 - hit.distance / this.ao.distance;
						}
						occlusion /= dirs.length;
					}
					const ao = 1 - this.ao.strength * occlusion;
					const lit = item.lit;
					colors[i * 3] = Math.min(1, item.albedo.r * sum.r * ao * lit);
					colors[i * 3 + 1] = Math.min(1, item.albedo.g * sum.g * ao * lit);
					colors[i * 3 + 2] = Math.min(1, item.albedo.b * sum.b * ao * lit);
				}
				item.geometry.setAttribute('color', new BufferAttribute(colors, 3));
			}
	}

	// glTF nodes: one node per bucket (its mesh: an opaque and a glass primitive), then the empties.
	// materials: 0 room (opaque), 1 glass.
	toGltf(bucketNodes = {}) {
		const materials = [
			{name: 'room', color: [1, 1, 1, 1]},
			{name: 'glass', color: [1, 1, 1, 0.38], transparent: true, doubleSided: true},
		];
		const nodes = [];
		const byName = new Map();
		for (const bucket of this.buckets.values()) {
			if (bucket.items.length === 0 && !bucket.extras) continue;
			const primitives = [];
			for (const [material, glass] of [
				[0, false],
				[1, true],
			]) {
				const items = bucket.items.filter((item) => item.glass === glass);
				if (items.length === 0) continue;
				const keepNormals = items.some((item) => item.keepNormals);
				const parts = items.map((item) => {
					const g = new BufferGeometry();
					g.setAttribute('position', item.geometry.getAttribute('position'));
					g.setAttribute('color', item.geometry.getAttribute('color'));
					if (keepNormals) g.setAttribute('normal', item.geometry.getAttribute('normal'));
					return g;
				});
				const merged = mergeVertices(quantizeColors(mergeGeometries(parts)), 1e-4);
				primitives.push({
					attributes: {
						POSITION: Float32Array.from(merged.getAttribute('position').array),
						COLOR_0: Float32Array.from(merged.getAttribute('color').array),
						...(keepNormals ? {NORMAL: Float32Array.from(merged.getAttribute('normal').array)} : {}),
					},
					indices: merged.index.array,
					material,
				});
			}
			const node = {
				name: bucket.name,
				...(bucket.extras ? {extras: bucket.extras} : {}),
				...(primitives.length ? {mesh: {name: bucket.name, primitives}} : {}),
				...(bucketNodes[bucket.name] ?? {}),
				children: [],
			};
			byName.set(bucket.name, node);
			const parent = bucket.parent && byName.get(bucket.parent);
			if (parent) parent.children.push(node);
			else nodes.push(node);
		}
		for (const empty of this.empties) nodes.push(empty);
		return {nodes, materials};
	}
}

// Colours rounded to 1/1024 so neighbouring faces' shared vertices merge into one indexed vertex.
function quantizeColors(geometry) {
	const color = geometry.getAttribute('color');
	for (let i = 0; i < color.array.length; i++) color.array[i] = Math.round(color.array[i] * 1024) / 1024;
	return geometry;
}

function positionsOnly(geometry) {
	const g = new BufferGeometry();
	g.setAttribute('position', geometry.getAttribute('position'));
	return g;
}

