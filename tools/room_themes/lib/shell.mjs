// SPDX-License-Identifier: AGPL-3.0-or-later

// The room box: floor slab, four wall groups (contract rev 4 `wall_plane`: a point on the inner face and the
// outward unit normal) and one ceiling group (`ceiling_y`, its inner face). The orbit camera hides the walls and the
// ceiling it comes near, so everything hung on a wall goes into that wall's group (onWall).

import {box, slab} from './shapes.mjs';

export const WALLS = {
	N: {normal: [0, -1]},
	S: {normal: [0, 1]},
	E: {normal: [1, 0]},
	W: {normal: [-1, 0]},
};

// Frame of a wall: local x along the wall, y up, +Z into the room, origin on the inner face at floor level.
export function wallFrame(shell, side, u) {
	const {W, D} = shell;
	switch (side) {
		case 'N':
			return [u, 0, -D / 2, 0];
		case 'S':
			return [-u, 0, D / 2, Math.PI];
		case 'E':
			return [W / 2, 0, -u, -Math.PI / 2];
		default:
			return [-W / 2, 0, u, Math.PI / 2];
	}
}

export function onWall(room, shell, side, u, fn) {
	const previous = room.current.name;
	room.useBucket(`wall_${side}`);
	const [x, y, z, yaw] = wallFrame(shell, side, u);
	room.at(x, y, z, yaw, fn);
	room.useBucket(previous);
}

// shell: {W, D, H, t, wall: {N: colour...}, wainscot: {color, height}, floor(room), openings: {N: [{u, y0, w, h}]}}
export function buildShell(room, shell) {
	const {W, D, H, t = 0.16} = shell;
	room.useBucket('floor');
	// Slab under the floor finish; its sides show from the orbit as the room's base.
	room.add(box(W + 2 * t, 0.25, D + 2 * t, 0, -0.125 - 0.002, 0), shell.base ?? '#2a2522');
	shell.floor(room);

	for (const side of ['N', 'S', 'E', 'W']) {
		const [px, , pz] = wallFrame(shell, side, 0);
		const [nx, nz] = WALLS[side].normal;
		room.useBucket(`wall_${side}`, {wall_plane: [px, pz, nx, nz]});
		const length = side === 'N' || side === 'S' ? W + 2 * t : D;
		const color = shell.wall[side] ?? shell.wall.default;
		const [x, y, z, yaw] = wallFrame(shell, side, 0);
		room.at(x, y, z, yaw, () => {
			wallWithOpenings(room, length, H, t, color, shell.openings?.[side] ?? []);
			const wainscot = shell.wainscot;
			if (wainscot) {
				const inner = side === 'N' || side === 'S' ? W : D;
				for (const [a, b] of spans(inner, wainscot.height, shell.openings?.[side] ?? []))
					room.add(slab(b - a, wainscot.height, 0.02, (a + b) / 2, wainscot.height / 2, 0.01, 0.35), wainscot.color);
				if (wainscot.cap)
					for (const [a, b] of spans(inner, wainscot.height, shell.openings?.[side] ?? []))
						room.add(box(b - a, 0.04, 0.04, (a + b) / 2, wainscot.height, 0.02), wainscot.cap);
			}
			if (shell.baseboard) {
				const inner = side === 'N' || side === 'S' ? W : D;
				for (const [a, b] of spans(inner, 0.1, shell.openings?.[side] ?? []))
					room.add(box(b - a, 0.1, 0.025, (a + b) / 2, 0.05, 0.0125 + (wainscot ? 0.02 : 0)), shell.baseboard);
			}
			if (shell.crown) {
				const inner = side === 'N' || side === 'S' ? W : D;
				room.add(box(inner, 0.08, 0.05, 0, H - 0.04, 0.025), shell.crown);
			}
		});
	}

	room.useBucket('ceiling', {ceiling_y: H});
	room.add(slab(W + 2 * t, 0.14, D + 2 * t, 0, H + 0.07, 0, 0.6), shell.ceiling ?? '#d9d4ca');
	room.useBucket('room');
}

// Horizontal spans of [-L/2, L/2] at height y that no opening covers.
function spans(length, y, openings) {
	let out = [[-length / 2, length / 2]];
	for (const o of openings) {
		if (!(o.y0 < y && y <= o.y0 + o.h + 0.06) && !(o.y0 <= 0.01)) continue;
		const a = o.u - o.w / 2 - 0.06;
		const b = o.u + o.w / 2 + 0.06;
		out = out.flatMap(([s, e]) => {
			if (b <= s || a >= e) return [[s, e]];
			const parts = [];
			if (a > s) parts.push([s, a]);
			if (b < e) parts.push([b, e]);
			return parts;
		});
	}
	return out.filter(([s, e]) => e - s > 0.02);
}

// A wall slab of `length` × `height`, `t` thick behind z = 0, with rectangular holes.
function wallWithOpenings(room, length, height, t, color, openings) {
	const sorted = [...openings].sort((a, b) => a.u - b.u);
	let cursor = -length / 2;
	const piece = (x0, x1, y0, y1) => {
		if (x1 - x0 < 0.001 || y1 - y0 < 0.001) return;
		room.add(slab(x1 - x0, y1 - y0, t, (x0 + x1) / 2, (y0 + y1) / 2, -t / 2, 0.4), color);
	};
	for (const o of sorted) {
		const a = o.u - o.w / 2;
		const b = o.u + o.w / 2;
		piece(cursor, a, 0, height);
		piece(a, b, 0, o.y0);
		piece(a, b, o.y0 + o.h, height);
		cursor = b;
	}
	piece(cursor, length / 2, 0, height);
}
