// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomCutaway, RoomLayout, RoomSeat, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {CAMERA_MIN_DISTANCE_FACTOR, TV_VIEW_DEG} from '@app/features/voice_scene/utils/CameraLimits';
import {parseSeatName, tableSeatName} from '@fluxer/constants/src/VoiceRoomThemes';

// One named object of the room GLB, already in world space. `plane` is measured for the `screen` mesh only; `id` (the
// node's uuid) finds a cut-away group again, its name being only a label.
export interface RoomContractNode {
	name: string;
	id?: string;
	position: Vec3;
	userData?: Record<string, unknown>;
	plane?: {width: number; height: number; normal: Vec3};
}

export class RoomContractError extends Error {
	constructor(message: string) {
		super(`Room GLB contract: ${message}`);
		this.name = 'RoomContractError';
	}
}

const TABLE_NAME = /^table_(T[0-9]{2})$/;
const STAND_NAME = /^stand_([0-9]{2})$/;
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Contract rev 4: exactly four wall groups, each with `wall_plane: [px, pz,
// nx, nz]` (a point on its inner face and the outward unit normal), and one ceiling group with `ceiling_y`; they are
// found by these extras, their names are only labels. A room that breaks this does not load (the flat view's
// load_failed): there is no older camera window to fall back to.
function parseCutaway(nodes: ReadonlyArray<RoomContractNode>): RoomCutaway {
	const walls: Array<RoomCutaway['walls'][number]> = [];
	const ceilings: Array<RoomCutaway['ceiling']> = [];
	for (const {name, id, userData} of nodes) {
		if (userData && 'wall_plane' in userData) {
			const plane = userData.wall_plane;
			if (
				!Array.isArray(plane) ||
				plane.length !== 4 ||
				!plane.every(Number.isFinite) ||
				Math.abs(Math.hypot(plane[2], plane[3]) - 1) > 0.01
			)
				throw new RoomContractError(`${name} has a malformed wall_plane`);
			walls.push({name, id, point: {x: plane[0], z: plane[1]}, normal: {x: plane[2], z: plane[3]}});
		}
		if (userData && 'ceiling_y' in userData) {
			const y = userData.ceiling_y;
			if (typeof y !== 'number' || !Number.isFinite(y))
				throw new RoomContractError(`${name} has a malformed ceiling_y`);
			ceilings.push({name, id, y});
		}
	}
	if (walls.length !== 4) throw new RoomContractError(`${walls.length} wall groups, not 4`);
	if (ceilings.length !== 1) throw new RoomContractError(`${ceilings.length} ceiling groups, not 1`);
	return {walls, ceiling: ceilings[0]!};
}

// An optional extras number: absent → undefined, anything but a number in [min, max] → contract error.
function optionalNumber(node: RoomContractNode, key: string, min: number, max: number): number | undefined {
	const value = node.userData?.[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !(value >= min && value <= max))
		throw new RoomContractError(`${node.name} ${key} is not a number in [${min}, ${max}]`);
	return value;
}

// Reads only the names of docs/oda-3b/GLB-SOZLESME.md (rev 3: watch seats, cam_target pan box) and the rev 4 extras
//; anything else is scenery.
export function parseRoomLayout(nodes: ReadonlyArray<RoomContractNode>): RoomLayout {
	const byName = new Map(nodes.map((node) => [node.name, node]));
	const required = (name: string): RoomContractNode => {
		const node = byName.get(name);
		if (!node) throw new RoomContractError(`${name} is missing`);
		return node;
	};

	const seats: Array<RoomSeat> = [];
	const stands: Array<{index: number; position: Vec3}> = [];
	const tables: Array<RoomLayout['tables'][number]> = [];
	for (const node of nodes) {
		const seat = parseSeatName(node.name);
		if (seat?.kind === 'lounge')
			seats.push({name: node.name, group: seat.group, position: node.position, table: null, watch: null});
		if (seat?.kind === 'table')
			seats.push({
				name: node.name,
				group: seat.slot,
				position: node.position,
				table: {slot: seat.slot, position: seat.position},
				watch: null,
			});
		// GLB rev 3: a watch seat sounds in its table's group.
		if (seat?.kind === 'watch')
			seats.push({
				name: node.name,
				group: seat.slot,
				position: node.position,
				table: null,
				watch: {slot: seat.slot, index: seat.index},
			});
		const stand = STAND_NAME.exec(node.name);
		if (stand) stands.push({index: Number(stand[1]), position: node.position});
		const table = TABLE_NAME.exec(node.name);
		if (table) {
			const topSize = Number(node.userData?.top_size);
			if (!(topSize > 0)) throw new RoomContractError(`${node.name} has no top_size`);
			tables.push({slot: table[1]!, center: node.position, topSize});
		}
	}
	for (const {slot} of tables) {
		for (const position of [1, 2, 3, 4]) required(tableSeatName(slot, position));
	}
	for (const seat of seats) {
		if (seat.watch && !tables.some((table) => table.slot === seat.watch?.slot))
			throw new RoomContractError(`${seat.name} has no table_${seat.watch.slot}`);
	}

	const screen = required('screen');
	if (!screen.plane) throw new RoomContractError('screen is not a quad');
	const camTarget = required('cam_target');
	// GLB rev 3: half-widths of the zoom-to-cursor target box; missing or not positive = no pan on that axis.
	const panHalfWidth = (key: string): number => {
		const value = Number(camTarget.userData?.[key]);
		return value > 0 ? value : 0;
	};
	return {
		seats: seats.sort((a, b) => byCodePoint(a.name, b.name)),
		stands: stands.sort((a, b) => a.index - b.index).map((stand) => stand.position),
		tables: tables.sort((a, b) => byCodePoint(a.slot, b.slot)),
		camTarget: camTarget.position,
		camHome: required('cam_home').position,
		camPan: {x: panHalfWidth('pan_x'), z: panHalfWidth('pan_z')},
		// the TV cone's half width, 30°–90°.
		screen: {
			center: screen.position,
			...screen.plane,
			viewDeg: optionalNumber(screen, 'tv_view_deg', 30, 90) ?? TV_VIEW_DEG,
		},
		cutaway: parseCutaway(nodes),
		// a room may keep the orbit further out, up to 0.25 × home (the rev 3 floor), never more.
		camZoomMin: optionalNumber(camTarget, 'zoom_min', CAMERA_MIN_DISTANCE_FACTOR, 0.25) ?? CAMERA_MIN_DISTANCE_FACTOR,
	};
}
