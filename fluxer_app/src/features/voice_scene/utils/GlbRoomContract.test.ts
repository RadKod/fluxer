// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	parseRoomLayout,
	RoomContractError,
	type RoomContractNode,
} from '@app/features/voice_scene/utils/GlbRoomContract';
import {describe, expect, it} from 'vitest';

const at = (x: number, y: number, z: number) => ({x, y, z});

function roomNodes(): Array<RoomContractNode> {
	return [
		{name: 'Floor', position: at(0, 0, 0)},
		{name: 'seat_B_01', position: at(2, 1.1, 0)},
		{name: 'seat_A_02', position: at(1, 1.1, 0)},
		{name: 'seat_A_01', position: at(0, 1.1, 0)},
		{name: 'seat_T01_1', position: at(-3, 1.1, 1)},
		{name: 'seat_T01_2', position: at(-2, 1.1, 0)},
		{name: 'seat_T01_3', position: at(-3, 1.1, -1)},
		{name: 'seat_T01_4', position: at(-4, 1.1, 0)},
		{name: 'table_T01', position: at(-3, 0.8, 0), userData: {top_size: 1.3}},
		{name: 'stand_02', position: at(5, 1.6, 2)},
		{name: 'stand_01', position: at(4, 1.6, 2)},
		{name: 'cam_target', position: at(0, 2, 0)},
		{name: 'cam_home', position: at(14, 10, 20)},
		{name: 'screen', position: at(0, 2, -4), plane: {width: 1.6, height: 0.9, normal: at(0, 0, 1)}},
		// Rev 4: the wall groups and the ceiling, found by their extras; the names are only labels.
		{name: 'wall_N', position: at(0, 0, 0), userData: {wall_plane: [0, -4.2, 0, -1]}},
		{name: 'wall_E', position: at(0, 0, 0), userData: {wall_plane: [6, 0, 1, 0]}},
		{name: 'wall_S', position: at(0, 0, 0), userData: {wall_plane: [0, 5, 0, 1]}},
		{name: 'Mur_ouest.001', position: at(0, 0, 0), userData: {wall_plane: [-6, 0, -1, 0]}},
		{name: 'ceiling', position: at(0, 3, 0), userData: {ceiling_y: 3.1}},
	];
}

const withExtras = (name: string, userData: Record<string, unknown>): Array<RoomContractNode> =>
	roomNodes().map((node) => (node.name === name ? {...node, userData} : node));

function without(name: string): Array<RoomContractNode> {
	return roomNodes().filter((node) => node.name !== name);
}

describe('parseRoomLayout', () => {
	it('collects lounge seats with groups and table seats with slot/position', () => {
		const layout = parseRoomLayout(roomNodes());
		expect(layout.seats.map((seat) => seat.name)).toEqual([
			'seat_A_01',
			'seat_A_02',
			'seat_B_01',
			'seat_T01_1',
			'seat_T01_2',
			'seat_T01_3',
			'seat_T01_4',
		]);
		expect(layout.seats[0]).toEqual({
			name: 'seat_A_01',
			group: 'A',
			position: at(0, 1.1, 0),
			table: null,
			watch: null,
		});
		expect(layout.seats[4]).toEqual({
			name: 'seat_T01_2',
			group: 'T01',
			position: at(-2, 1.1, 0),
			table: {slot: 'T01', position: 2},
			watch: null,
		});
		expect(layout.stands).toEqual([at(4, 1.6, 2), at(5, 1.6, 2)]);
		expect(layout.camTarget).toEqual(at(0, 2, 0));
		expect(layout.camHome).toEqual(at(14, 10, 20));
		expect(layout.screen).toEqual({center: at(0, 2, -4), width: 1.6, height: 0.9, normal: at(0, 0, 1), viewDeg: 55});
	});

	it('reads top_size from userData', () => {
		expect(parseRoomLayout(roomNodes()).tables).toEqual([{slot: 'T01', center: at(-3, 0.8, 0), topSize: 1.3}]);
		const broken = roomNodes().map((node) => (node.name === 'table_T01' ? {...node, userData: {}} : node));
		expect(() => parseRoomLayout(broken)).toThrow(RoomContractError);
	});

	it('requires cam_target, cam_home, screen; missing → throws contract error', () => {
		for (const name of ['cam_target', 'cam_home', 'screen']) {
			expect(() => parseRoomLayout(without(name))).toThrow(RoomContractError);
		}
		const flatScreen = roomNodes().map((node) =>
			node.name === 'screen' ? {name: 'screen', position: node.position} : node,
		);
		expect(() => parseRoomLayout(flatScreen)).toThrow(RoomContractError);
	});

	it('a table without four seats → throws', () => {
		expect(() => parseRoomLayout(without('seat_T01_3'))).toThrow(RoomContractError);
	});

	it('ignores unknown names', () => {
		const layout = parseRoomLayout([
			...roomNodes(),
			{name: 'seat_A_01_1', position: at(9, 9, 9)},
			{name: 'seat_x_01', position: at(9, 9, 9)},
			{name: 'stand_A', position: at(9, 9, 9)},
			{name: 'zone_A', position: at(9, 9, 9)},
		]);
		expect(layout.seats).toHaveLength(7);
		expect(layout.stands).toHaveLength(2);
	});

	it('collects watch seats with slot/index and the table group', () => {
		const layout = parseRoomLayout([
			...roomNodes(),
			{name: 'seat_T01_Y2', position: at(-1.4, 1.1, 1.2)},
			{name: 'seat_T01_Y1', position: at(-4.6, 1.1, 1.2)},
		]);
		const watch = layout.seats.filter((seat) => seat.watch !== null);
		expect(watch).toEqual([
			{name: 'seat_T01_Y1', group: 'T01', position: at(-4.6, 1.1, 1.2), table: null, watch: {slot: 'T01', index: 1}},
			{name: 'seat_T01_Y2', group: 'T01', position: at(-1.4, 1.1, 1.2), table: null, watch: {slot: 'T01', index: 2}},
		]);
		// Watch seats are neither lounge nor table seats.
		expect(layout.seats.filter((seat) => seat.table !== null)).toHaveLength(4);
		expect(layout.seats.filter((seat) => seat.table === null && seat.watch === null)).toHaveLength(3);
	});

	it('watch seat without its table → contract error', () => {
		expect(() => parseRoomLayout([...roomNodes(), {name: 'seat_T02_Y1', position: at(9, 1.1, 9)}])).toThrow(
			RoomContractError,
		);
	});

	it('reads cam_target pan_x/pan_z, default 0', () => {
		expect(parseRoomLayout(roomNodes()).camPan).toEqual({x: 0, z: 0});
		const panned = roomNodes().map((node) =>
			node.name === 'cam_target' ? {...node, userData: {pan_x: 2.5, pan_z: 1.25}} : node,
		);
		expect(parseRoomLayout(panned).camPan).toEqual({x: 2.5, z: 1.25});
		// A half-width that is not a positive number means no pan box on that axis.
		const broken = roomNodes().map((node) =>
			node.name === 'cam_target' ? {...node, userData: {pan_x: 'wide', pan_z: -3}} : node,
		);
		expect(parseRoomLayout(broken).camPan).toEqual({x: 0, z: 0});
	});

	it('reads the wall groups, the ceiling, zoom_min and tv_view_deg by their extras (rev 4)', () => {
		const layout = parseRoomLayout(roomNodes());
		expect(layout.cutaway).toEqual({
			walls: [
				{name: 'wall_N', point: {x: 0, z: -4.2}, normal: {x: 0, z: -1}},
				{name: 'wall_E', point: {x: 6, z: 0}, normal: {x: 1, z: 0}},
				{name: 'wall_S', point: {x: 0, z: 5}, normal: {x: 0, z: 1}},
				{name: 'Mur_ouest.001', point: {x: -6, z: 0}, normal: {x: -1, z: 0}},
			],
			ceiling: {name: 'ceiling', y: 3.1},
		});
		// Absent optional extras: the contract's 0.08 and 55°.
		expect(layout.camZoomMin).toBe(0.08);
		expect(layout.screen?.viewDeg).toBe(55);
		const tuned = roomNodes().map((node) =>
			node.name === 'cam_target'
				? {...node, userData: {zoom_min: 0.1469}}
				: node.name === 'screen'
					? {...node, userData: {tv_view_deg: 40}}
					: node,
		);
		expect(parseRoomLayout(tuned).camZoomMin).toBe(0.1469);
		expect(parseRoomLayout(tuned).screen?.viewDeg).toBe(40);
	});

	it('a room without its four wall groups and one ceiling, or with any of them malformed, does not load (D11)', () => {
		// No fallback to an older camera window: every one of these is a contract error (the flat view's load_failed).
		expect(() => parseRoomLayout(without('wall_E'))).toThrow(RoomContractError);
		expect(() => parseRoomLayout(without('ceiling'))).toThrow(RoomContractError);
		expect(() =>
			parseRoomLayout([...roomNodes(), {name: 'wall_X', position: at(0, 0, 0), userData: {wall_plane: [1, 1, 1, 0]}}]),
		).toThrow(RoomContractError);
		expect(() =>
			parseRoomLayout([...roomNodes(), {name: 'ceiling_2', position: at(0, 0, 0), userData: {ceiling_y: 4}}]),
		).toThrow(RoomContractError);
		for (const wall_plane of [
			[0, -4.2, 0],
			[0, -4.2, 0, -1, 9],
			[0, 'north', 0, -1],
			[0, -4.2, Number.NaN, -1],
			[0, -4.2, 0, 0],
			[0, -4.2, 0, -2],
			'0,-4.2,0,-1',
			null,
			{px: 0},
		])
			expect(() => parseRoomLayout(withExtras('wall_N', {wall_plane}))).toThrow(RoomContractError);
		for (const ceiling_y of ['3.1', Number.POSITIVE_INFINITY, null])
			expect(() => parseRoomLayout(withExtras('ceiling', {ceiling_y}))).toThrow(RoomContractError);
		// zoom_min ∈ [0.08, 0.25]; a room needing more keeps its camera off its furniture some other way.
		for (const zoom_min of [0, 0.05, 0.26, 0.62, 1.5, 'near', Number.NaN])
			expect(() => parseRoomLayout(withExtras('cam_target', {zoom_min}))).toThrow(RoomContractError);
		for (const tv_view_deg of [20, 95, '55'])
			expect(() =>
				parseRoomLayout(
					roomNodes().map((node) => (node.name === 'screen' ? {...node, userData: {tv_view_deg}} : node)),
				),
			).toThrow(RoomContractError);
	});
});
