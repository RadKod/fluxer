// SPDX-License-Identifier: AGPL-3.0-or-later

// Contract nodes (docs: GlbRoomContract.ts, build_manifest.mjs): seats, stands, tables, the screen and the camera.

import {quad} from './shapes.mjs';
import {wallFrame} from './shell.mjs';
import {PerspectiveCamera, Vector3} from './three.mjs';

// The client's reference framing (CameraLimits.REFERENCE_FOV_DEG at 16:9).
const FOV_DEG = 28;
const ASPECT = 16 / 9;

export function seat(room, name, [x, y, z]) {
	return room.empty(name, x, y, z);
}

export function stands(room, points, y = 1.6) {
	points.forEach(([x, z], i) => room.empty(`stand_${String(i + 1).padStart(2, '0')}`, x, y, z));
	return points.length;
}

// A game table's contract: table_<slot> at the centre of its top (top_size), its four seats counter-clockwise from
// above starting at +Z (1 south, 2 east, 3 north, 4 west, in the table's own frame) and up to four watch seats
// 1.7 m out, 25° on from each player seat.
export function tableContract(room, slot, {top, topY, seatOut, headY, watch = []}) {
	room.empty(`table_${slot}`, 0, topY, 0, {top_size: top});
	const dirs = [
		[0, 1],
		[1, 0],
		[0, -1],
		[-1, 0],
	];
	dirs.forEach(([dx, dz], i) => room.empty(`seat_${slot}_${i + 1}`, dx * seatOut, headY, dz * seatOut));
	for (const index of watch) {
		const [dx, dz] = dirs[index - 1];
		const angle = Math.atan2(dx, dz) + (25 * Math.PI) / 180;
		room.empty(`seat_${slot}_Y${index}`, Math.sin(angle) * 1.7, headY + 0.05, Math.cos(angle) * 1.7);
	}
	return dirs.map(([dx, dz]) => [dx * seatOut, dz * seatOut]);
}

// The TV screen quad on a wall (16:9), its own node named `screen` under that wall's group so it hides with it.
export function screen(room, shell, side, u, {width = 2.4, y = 1.75, viewDeg} = {}) {
	const height = (width * 9) / 16;
	const previous = room.current.name;
	room.useBucket('screen', viewDeg ? {tv_view_deg: viewDeg} : undefined, `wall_${side}`);
	const [x, , z, yaw] = wallFrame(shell, side, u);
	room.at(x, 0, z, yaw, () => {
		room.add(quad(width, height, 0, y, 0.075), '#07080b', {emissive: 1, keepNormals: true, cast: false});
	});
	room.useBucket(previous);
	return {width, height};
}

// cam_target over the room centre and cam_home on the given bearing, as near as keeps the room inside the 16:9
// reference frame (the client's orbit then reaches 0.08–1 × that distance).
export function camera(
	room,
	shell,
	{azimuthDeg = 32, elevationDeg = 33, targetY = 2.1, margin = 0.96, zoomMin, pan} = {},
) {
	const {W, D} = shell;
	const target = new Vector3(0, targetY, 0);
	const az = (azimuthDeg * Math.PI) / 180;
	const el = (elevationDeg * Math.PI) / 180;
	const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
	const corners = [];
	for (const x of [-W / 2 - 0.2, W / 2 + 0.2])
		for (const z of [-D / 2 - 0.2, D / 2 + 0.2]) for (const y of [0, 2.4]) corners.push(new Vector3(x, y, z));
	const fits = (distance) => {
		const cam = new PerspectiveCamera(FOV_DEG, ASPECT, 0.1, 200);
		cam.position.copy(target).addScaledVector(dir, distance);
		cam.lookAt(target);
		cam.updateMatrixWorld();
		return corners.every((c) => {
			const p = c.clone().project(cam);
			return Math.abs(p.x) <= margin && Math.abs(p.y) <= margin;
		});
	};
	let distance = 10;
	while (!fits(distance) && distance < 40) distance += 0.1;
	const home = target.clone().addScaledVector(dir, distance);
	room.empty('cam_target', target.x, target.y, target.z, {
		...(zoomMin ? {zoom_min: zoomMin} : {}),
		...(pan ? {pan_x: pan[0], pan_z: pan[1]} : {}),
	});
	room.empty('cam_home', home.x, home.y, home.z);
	return {distance, home};
}

