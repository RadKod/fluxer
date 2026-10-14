// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry helpers in metres. Boxes are placed by their centre, cylinders and lathes by their base centre.

import {
	BoxGeometry,
	CylinderGeometry,
	ExtrudeGeometry,
	LatheGeometry,
	PlaneGeometry,
	RoundedBoxGeometry,
	Shape,
	SphereGeometry,
	TorusGeometry,
	Vector2,
} from './three.mjs';

export function box(w, h, d, x = 0, y = 0, z = 0, segments = null) {
	const [sx, sy, sz] = segments ?? [1, 1, 1];
	return new BoxGeometry(w, h, d, sx, sy, sz).translate(x, y, z);
}

// Large flat surfaces get subdivided so baked light can vary across them (cells of about `cell` metres).
export function slab(w, h, d, x, y, z, cell = 0.4) {
	const seg = (v) => Math.max(1, Math.min(48, Math.round(v / cell)));
	return box(w, h, d, x, y, z, [seg(w), seg(h), seg(d)]);
}

export function rbox(w, h, d, radius, x = 0, y = 0, z = 0, segments = 2) {
	return new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, w / 2, h / 2, d / 2) * 0.999).translate(x, y, z);
}

export function cyl(rTop, rBottom, h, x = 0, y = 0, z = 0, segments = 12, open = false) {
	return new CylinderGeometry(rTop, rBottom, h, segments, 1, open).translate(x, y + h / 2, z);
}

// Horizontal cylinder along X (axis), centred.
export function cylX(r, length, x = 0, y = 0, z = 0, segments = 10) {
	return new CylinderGeometry(r, r, length, segments).rotateZ(Math.PI / 2).translate(x, y, z);
}

export function cylZ(r, length, x = 0, y = 0, z = 0, segments = 10) {
	return new CylinderGeometry(r, r, length, segments).rotateX(Math.PI / 2).translate(x, y, z);
}

// profile: [[radius, height], ...] from bottom to top
export function lathe(profile, x = 0, y = 0, z = 0, segments = 16) {
	return new LatheGeometry(
		profile.map(([r, h]) => new Vector2(Math.max(r, 0.0001), h)),
		segments,
	).translate(x, y, z);
}

export function sphere(r, x = 0, y = 0, z = 0, w = 10, h = 7) {
	return new SphereGeometry(r, w, h).translate(x, y, z);
}

export function torus(r, tube, x = 0, y = 0, z = 0, radial = 6, tubular = 18, arc = Math.PI * 2) {
	return new TorusGeometry(r, tube, radial, tubular, arc).translate(x, y, z);
}

// A plane facing +Z (before any rotation), centred.
export function quad(w, h, x = 0, y = 0, z = 0) {
	return new PlaneGeometry(w, h).translate(x, y, z);
}

// Extrudes a 2D outline (points in the XY plane) along +Z by depth; centred on z.
export function extrude(points, depth, x = 0, y = 0, z = 0, bevel = 0) {
	const shape = new Shape(points.map(([px, py]) => new Vector2(px, py)));
	const geometry = new ExtrudeGeometry(shape, {
		depth,
		bevelEnabled: bevel > 0,
		bevelThickness: bevel,
		bevelSize: bevel,
		bevelSegments: 1,
		curveSegments: 6,
	});
	return geometry.translate(x, y, z - depth / 2);
}

export function shapeOf(points) {
	return new Shape(points.map(([px, py]) => new Vector2(px, py)));
}
