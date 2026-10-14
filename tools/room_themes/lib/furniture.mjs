// SPDX-License-Identifier: AGPL-3.0-or-later

// Furniture in its own frame: metres, standing on y = 0, front (where a sitter faces) towards +Z, centred on x.
// Seat helpers return the seat's head point (where the client draws the sitter), in that same frame.

import {box, cyl, cylX, cylZ, extrude, lathe, quad, rbox, slab, sphere, torus} from './shapes.mjs';

export const HEAD_ABOVE_SEAT = 0.64;

// A sofa with arms, back, seat and back cushions; returns one head point per seat.
export function sofa(
	room,
	{
		width = 2.2,
		depth = 0.92,
		seats = 3,
		frame = '#3b3f4a',
		cushion = '#525a6b',
		legs = '#1d1a17',
		armWidth = 0.2,
		backHeight = 0.86,
		seatHeight = 0.44,
		pillows = [],
	} = {},
) {
	const legH = 0.08;
	const baseTop = seatHeight - 0.14;
	for (const sx of [-1, 1])
		for (const sz of [-1, 1])
			room.add(cyl(0.025, 0.02, legH, sx * (width / 2 - 0.08), 0, sz * (depth / 2 - 0.08), 8), legs);
	room.add(rbox(width, baseTop - legH, depth, 0.03, 0, (legH + baseTop) / 2, 0), frame);
	for (const sx of [-1, 1])
		room.add(rbox(armWidth, 0.62 - legH, depth, 0.06, sx * (width / 2 - armWidth / 2), (legH + 0.62) / 2, 0), frame);
	const inner = width - 2 * armWidth;
	room.add(rbox(inner, backHeight - baseTop, 0.2, 0.06, 0, (baseTop + backHeight) / 2, -depth / 2 + 0.1), frame);
	const each = inner / seats;
	const heads = [];
	const cushionDepth = depth - 0.24;
	const cz = -depth / 2 + 0.2 + cushionDepth / 2 + 0.02;
	for (let i = 0; i < seats; i++) {
		const x = -inner / 2 + each * (i + 0.5);
		room.add(rbox(each - 0.015, 0.15, cushionDepth, 0.06, x, baseTop + 0.075, cz), cushion);
		const back = rbox(each - 0.03, 0.42, 0.16, 0.07)
			.rotateX(-0.16)
			.translate(x, seatHeight + 0.22, -depth / 2 + 0.27);
		room.add(back, cushion);
		heads.push([x, seatHeight + HEAD_ABOVE_SEAT, cz - 0.08]);
	}
	pillows.forEach((color, i) => {
		const side = i % 2 === 0 ? -1 : 1;
		const p = rbox(0.38, 0.36, 0.12, 0.05)
			.rotateZ(side * 0.25)
			.rotateX(-0.25)
			.translate(side * (inner / 2 - 0.22), seatHeight + 0.2, -depth / 2 + 0.38);
		room.add(p, color);
	});
	return heads;
}

export function armchair(room, {color = '#6b4a3a', cushion = '#7d5847', legs = '#2a1d15', width = 0.86} = {}) {
	return sofa(room, {width, depth: 0.86, seats: 1, frame: color, cushion, legs, armWidth: 0.17, backHeight: 0.9});
}

// A bentwood café chair; the sitter faces +Z.
export function cafeChair(room, {wood = '#5a3420', seat = '#6e4128', height = 0.46} = {}) {
	const s = 0.42;
	room.add(rbox(s, 0.035, s, 0.012, 0, height - 0.0175, 0), seat);
	for (const sx of [-1, 1])
		for (const sz of [-1, 1])
			room.add(cyl(0.016, 0.013, height - 0.035, sx * (s / 2 - 0.035), 0, sz * (s / 2 - 0.035), 6), wood);
	// stretcher ring
	room.add(
		torus(0.17, 0.008, 0, 0.17, 0, 4, 16)
			.rotateX(Math.PI / 2)
			.translate(0, 0, 0),
		wood,
	);
	// back posts and bent back
	for (const sx of [-1, 1]) room.add(cyl(0.014, 0.016, 0.5, sx * (s / 2 - 0.04), height, -s / 2 + 0.03, 6), wood);
	room.add(torus(0.17, 0.016, 0, height + 0.42, -s / 2 + 0.03, 5, 14, Math.PI), wood);
	room.add(box(s - 0.08, 0.05, 0.02, 0, height + 0.22, -s / 2 + 0.03), wood);
	return [0, height + HEAD_ABOVE_SEAT, 0.03];
}

export function stool(room, {height = 0.66, seat = '#8b2f2f', metal = '#2b2b2e', radius = 0.18} = {}) {
	room.add(
		lathe(
			[
				[0, 0],
				[0.2, 0],
				[0.2, 0.02],
				[0.05, 0.04],
				[0.035, height - 0.08],
				[radius * 0.8, height - 0.06],
				[0, height - 0.06],
			],
			0,
			0,
			0,
			14,
		),
		metal,
	);
	room.add(
		lathe(
			[
				[0, 0],
				[radius, 0],
				[radius + 0.01, 0.04],
				[radius - 0.01, 0.08],
				[0, 0.085],
			],
			0,
			height - 0.07,
			0,
			16,
		),
		seat,
	);
	room.add(torus(0.17, 0.01, 0, height * 0.42, 0, 4, 16).rotateX(Math.PI / 2), metal);
	return [0, height + 0.08 + 0.56, 0];
}

// A square game table; its felt top is at `topY`, exactly `top` metres square, centred on the origin.
export function gameTable(
	room,
	{top = 1.3, topY = 0.76, felt = '#2f5e45', wood = '#5b3a24', rim = 0.07, pedestal = false} = {},
) {
	const outer = top + 2 * rim;
	room.add(slab(top, 0.02, top, 0, topY - 0.01, 0, 0.33), felt);
	for (const s of [-1, 1]) {
		room.add(rbox(outer, 0.05, rim, 0.012, 0, topY - 0.02, s * (top / 2 + rim / 2)), wood);
		room.add(rbox(rim, 0.05, top, 0.012, s * (top / 2 + rim / 2), topY - 0.02, 0), wood);
	}
	room.add(box(outer - 0.1, 0.1, outer - 0.1, 0, topY - 0.09, 0), wood);
	if (pedestal) {
		room.add(cyl(0.08, 0.1, topY - 0.14, 0, 0.04, 0, 10), wood);
		room.add(cyl(0.45, 0.48, 0.05, 0, 0, 0, 16), wood);
	} else {
		for (const sx of [-1, 1])
			for (const sz of [-1, 1])
				room.add(box(0.07, topY - 0.14, 0.07, sx * (outer / 2 - 0.1), (topY - 0.14) / 2, sz * (outer / 2 - 0.1)), wood);
	}
}

export function roundTable(room, {radius = 0.35, height = 0.72, top = '#6b4630', base = '#2a2420'} = {}) {
	room.add(cyl(radius, radius, 0.035, 0, height - 0.035, 0, 20), top);
	room.add(cyl(0.035, 0.04, height - 0.035, 0, 0, 0, 8), base);
	room.add(cyl(radius * 0.6, radius * 0.65, 0.03, 0, 0, 0, 14), base);
}

export function squareTable(room, {size = 0.7, height = 0.72, top = '#6b4630', legs = '#4a2f1d'} = {}) {
	room.add(rbox(size, 0.035, size, 0.01, 0, height - 0.0175, 0), top);
	room.add(box(size - 0.08, 0.07, size - 0.08, 0, height - 0.07, 0), legs);
	for (const sx of [-1, 1])
		for (const sz of [-1, 1])
			room.add(
				box(0.045, height - 0.035, 0.045, sx * (size / 2 - 0.06), (height - 0.035) / 2, sz * (size / 2 - 0.06)),
				legs,
			);
}

export function coffeeTable(room, {w = 1.2, d = 0.6, h = 0.4, top = '#2b2b30', legs = '#c9a24a'} = {}) {
	room.add(rbox(w, 0.04, d, 0.015, 0, h - 0.02, 0), top);
	for (const sx of [-1, 1])
		for (const sz of [-1, 1])
			room.add(cyl(0.015, 0.015, h - 0.04, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), 6), legs);
	room.add(box(w - 0.12, 0.02, d - 0.12, 0, 0.1, 0), top);
}

export function rug(room, {w = 3, d = 2, color = '#5a2e2e', border = '#c8a46a', inner = null} = {}) {
	room.add(slab(w, 0.012, d, 0, 0.006, 0, 0.5), border);
	room.add(slab(w - 0.2, 0.004, d - 0.2, 0, 0.014, 0, 0.5), color);
	if (inner) room.add(slab(w * 0.45, 0.004, d * 0.45, 0, 0.017, 0, 0.5), inner);
}

export function plant(room, {pot = '#c46a3c', leaf = '#3f7a3a', height = 1.1, random = Math.random} = {}) {
	room.add(
		lathe(
			[
				[0, 0],
				[0.16, 0],
				[0.2, 0.34],
				[0.22, 0.36],
				[0.2, 0.37],
				[0, 0.37],
			],
			0,
			0,
			0,
			12,
		),
		pot,
	);
	room.add(cyl(0.19, 0.19, 0.01, 0, 0.35, 0, 12), '#3a2a1d');
	room.add(cyl(0.015, 0.02, height * 0.55, 0, 0.35, 0, 5), '#4e3b26');
	const n = 9;
	for (let i = 0; i < n; i++) {
		const angle = (i / n) * Math.PI * 2 + random() * 0.5;
		const len = 0.35 + random() * 0.25;
		const tilt = 0.5 + random() * 0.6;
		const blade = extrude(
			[
				[0, 0],
				[0.07, len * 0.4],
				[0, len],
				[-0.07, len * 0.4],
			],
			0.01,
		)
			.rotateX(-tilt)
			.rotateY(angle)
			.translate(0, 0.45 + random() * (height - 0.6), 0);
		const shade = i % 2 ? leaf : '#4f8d45';
		room.add(blade, shade, {flat: true});
	}
}

export function floorLamp(
	room,
	{shade = '#f3dfb5', metal = '#2a2622', glow = '#ffcf8a', intensity = 1.2, range = 2.4} = {},
) {
	room.add(cyl(0.16, 0.18, 0.03, 0, 0, 0, 14), metal);
	room.add(cyl(0.014, 0.014, 1.45, 0, 0.03, 0, 6), metal);
	room.add(
		lathe(
			[
				[0.2, 0],
				[0.14, 0.32],
			],
			0,
			1.35,
			0,
			16,
		),
		shade,
		{emissive: 1.0, cast: false},
	);
	room.light(0, 1.5, 0, {color: glow, intensity, range, radius: 0.1});
}

export function pendant(
	room,
	{drop = 0.8, ceiling = 3.2, shade = '#2a2a2a', glow = '#ffd9a0', intensity = 1, range = 2.5, kind = 'dome'} = {},
) {
	const y = ceiling - drop;
	room.add(cyl(0.004, 0.004, drop, 0, y, 0, 4), '#151515', {cast: false});
	if (kind === 'globe') {
		room.add(sphere(0.16, 0, y - 0.12, 0, 12, 8), glow, {emissive: 1.1, cast: false});
	} else if (kind === 'cone') {
		room.add(
			lathe(
				[
					[0.18, 0],
					[0.03, 0.22],
					[0, 0.23],
				],
				0,
				y - 0.22,
				0,
				14,
			),
			shade,
			{cast: false},
		);
		room.add(sphere(0.05, 0, y - 0.21, 0, 8, 5), glow, {emissive: 1.4, cast: false});
	} else {
		room.add(
			lathe(
				[
					[0.24, 0],
					[0.22, 0.05],
					[0.12, 0.16],
					[0.03, 0.2],
					[0, 0.2],
				],
				0,
				y - 0.2,
				0,
				16,
			),
			shade,
			{cast: false},
		);
		room.add(cyl(0.2, 0.2, 0.005, 0, y - 0.2, 0, 16), glow, {emissive: 1.25, cast: false});
	}
	room.light(0, y - 0.28, 0, {color: glow, intensity, range, radius: 0.1, down: 0.6});
}

// Shelf unit against a wall (its back at z = 0), with books and jars.
export function bookshelf(
	room,
	{
		w = 1.6,
		h = 2,
		d = 0.34,
		wood = '#5c3e28',
		random = Math.random,
		palette = ['#7a2e2e', '#2e4a7a', '#c9a24a', '#3d6b45', '#d8cbb0', '#5a3d6b'],
	} = {},
) {
	const t = 0.03;
	room.add(box(w, h, 0.02, 0, h / 2, 0.01), wood);
	for (const s of [-1, 1]) room.add(box(t, h, d, s * (w / 2 - t / 2), h / 2, d / 2), wood);
	const shelves = Math.round(h / 0.4);
	for (let i = 0; i <= shelves; i++) {
		const y = Math.min(h - t / 2, 0.05 + (i * (h - 0.05)) / shelves);
		room.add(box(w, t, d, 0, y, d / 2), wood);
		if (i === shelves) break;
		let x = -w / 2 + t + 0.02;
		while (x < w / 2 - t - 0.06) {
			const bw = 0.025 + random() * 0.035;
			const bh = 0.2 + random() * 0.12;
			if (random() < 0.12) {
				x += 0.08;
				continue;
			}
			const color = palette[Math.floor(random() * palette.length)];
			room.add(box(bw, bh, d * 0.75, x + bw / 2, y + t / 2 + bh / 2, d / 2 + 0.01), color);
			x += bw + 0.004;
		}
	}
}

// A window in a wall plane: the wall's inner face at z = 0, the window looks out towards −Z. Frame, mullions,
// sill and a glass pane; behind it an unlit backdrop (night sky, garden) so it never shows the void.
export function windowUnit(
	room,
	{
		w = 1.4,
		h = 1.6,
		sill = 0.9,
		frame = '#e8e1d2',
		backdrop = '#1a2742',
		glow = 0.9,
		mullions = 2,
		backdropFn = null,
	} = {},
) {
	const t = 0.06;
	const y0 = sill;
	room.add(box(w + 2 * t, t, 0.1, 0, y0 - t / 2, 0.03), frame);
	room.add(box(w + 2 * t + 0.08, 0.03, 0.2, 0, y0 - t - 0.015, 0.08), frame);
	room.add(box(w + 2 * t, t, 0.1, 0, y0 + h + t / 2, 0.03), frame);
	for (const s of [-1, 1]) room.add(box(t, h, 0.1, s * (w / 2 + t / 2), y0 + h / 2, 0.03), frame);
	for (let i = 1; i < mullions; i++)
		room.add(box(0.035, h, 0.06, -w / 2 + (w * i) / mullions, y0 + h / 2, 0.02), frame);
	room.add(box(w, 0.035, 0.06, 0, y0 + h * 0.62, 0.02), frame);
	room.add(quad(w, h, 0, y0 + h / 2, 0.0), '#cfe3ff', {glass: true, cast: false});
	if (backdropFn) backdropFn({w, h, y0});
	else room.add(quad(w, h, 0, y0 + h / 2, -0.3), backdrop, {emissive: glow, cast: false});
	reveal(room, {w, h, y0, depth: 0.42});
}

// A dark box behind a wall opening, so what shows through the window never reads as loose planes from outside.
export function reveal(room, {w, h, y0, depth = 0.42, color = '#101014'}) {
	const t = 0.02;
	room.add(box(w + 2 * t, t, depth, 0, y0 - t / 2, -depth / 2), color, {cast: false});
	room.add(box(w + 2 * t, t, depth, 0, y0 + h + t / 2, -depth / 2), color, {cast: false});
	for (const s of [-1, 1])
		room.add(box(t, h, depth, s * (w / 2 + t / 2), y0 + h / 2, -depth / 2), color, {cast: false});
	room.add(box(w + 2 * t, h + 2 * t, t, 0, y0 + h / 2, -depth - t / 2), color, {cast: false});
}

export function frame(
	room,
	{w = 0.6, h = 0.8, y = 1.6, color = '#2a1d15', art = ['#c94f3d', '#e8c26a', '#2f5d7a']} = {},
) {
	room.add(box(w, h, 0.03, 0, y, 0.015), color);
	room.add(box(w - 0.08, h - 0.08, 0.005, 0, y, 0.032), '#efe6d3');
	const n = art.length;
	art.forEach((c, i) => {
		const bw = (w - 0.16) / n;
		room.add(
			box(
				bw * 0.9,
				(h - 0.2) * (0.5 + (0.5 * ((i * 37) % 10)) / 10),
				0.004,
				-w / 2 + 0.08 + bw * (i + 0.5),
				y - 0.04,
				0.036,
			),
			c,
		);
	});
}

export function wallClock(room, {r = 0.24, y = 2.3, face = '#f4ecd8', rim = '#3b2a1c'} = {}) {
	room.add(cylZ(r, 0.05, 0, y, 0.025, 24), rim);
	room.add(cylZ(r - 0.025, 0.01, 0, y, 0.052, 24), face);
	for (let i = 0; i < 12; i++) {
		const a = (i / 12) * Math.PI * 2;
		room.add(
			box(0.012, 0.035, 0.005, Math.sin(a) * (r - 0.05), y + Math.cos(a) * (r - 0.05), 0.06).rotateZ(0),
			'#2a2a2a',
		);
	}
	room.add(box(0.012, r * 0.55, 0.004, 0.04, y + r * 0.2, 0.062).rotateZ(0), '#1a1a1a');
	room.add(box(r * 0.7, 0.01, 0.004, -r * 0.2, y + 0.04, 0.064), '#1a1a1a');
}

// A wall TV: bezel and stand-off; the screen quad itself is added by the caller as its own node.
export function tvBezel(room, {w = 2.4, h = 1.35, y = 1.75}) {
	room.add(rbox(w + 0.08, h + 0.08, 0.06, 0.015, 0, y, 0.04), '#0d0d10');
	room.add(box(0.3, 0.2, 0.04, 0, y, 0.01), '#18181c');
}

export function neonStrip(room, {length, color, x = 0, y = 0, z = 0, axis = 'x', thickness = 0.03, intensity = 1.6}) {
	const g =
		axis === 'x'
			? box(length, thickness, thickness, x, y, z)
			: axis === 'z'
				? box(thickness, thickness, length, x, y, z)
				: box(thickness, length, thickness, x, y, z);
	room.add(g, color, {emissive: intensity, cast: false});
}

export function bottle(room, {x = 0, y = 0, z = 0, color = '#2f6b3a', h = 0.3}) {
	room.add(
		lathe(
			[
				[0, 0],
				[0.035, 0],
				[0.037, h * 0.6],
				[0.014, h * 0.78],
				[0.012, h],
				[0, h],
			],
			x,
			y,
			z,
			8,
		),
		color,
	);
}

export {box, cyl, cylX, cylZ, extrude, lathe, quad, rbox, slab, sphere, torus};

// A door in a wall opening (inner face z = 0, opening w × h from the floor): casing and a closed leaf.
export function door(
	room,
	{w = 1.1, h = 2.25, casing = '#15151c', leaf = '#2a2a33', handle = '#c9a24a', glass = false} = {},
) {
	room.add(box(w + 0.16, 0.08, 0.1, 0, h + 0.04, 0.02), casing);
	for (const s of [-1, 1]) room.add(box(0.08, h, 0.1, s * (w / 2 + 0.04), h / 2, 0.02), casing);
	room.add(box(w, h, 0.05, 0, h / 2, -0.08), leaf);
	room.add(box(w - 0.24, 0.5, 0.01, 0, h * 0.72, -0.05), glass ? '#9db6ff' : leaf, glass ? {glass: true} : {});
	room.add(box(w - 0.24, 0.7, 0.01, 0, h * 0.3, -0.05), leaf);
	room.add(cylZ(0.02, 0.08, w / 2 - 0.12, 1.0, -0.03, 8), handle);
}
