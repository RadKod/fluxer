// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DICE_ROLL_MS,
	DiceAnimation,
	faceUpQuaternion,
	isNewRoll,
} from '@app/features/voice_scene/scene/table/DiceAnimation';
import type {TableGameView, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {type Quaternion, Vector3} from 'three';
import {describe, expect, it} from 'vitest';

// GLB contract rev 3: tavla_die faces +Y=1, −Y=6, +X=3, −X=4, +Z=2, −Z=5.
const FACES: ReadonlyArray<readonly [number, Vector3]> = [
	[1, new Vector3(0, 1, 0)],
	[6, new Vector3(0, -1, 0)],
	[3, new Vector3(1, 0, 0)],
	[4, new Vector3(-1, 0, 0)],
	[2, new Vector3(0, 0, 1)],
	[5, new Vector3(0, 0, -1)],
];
function upFace(q: Quaternion): number {
	let best = 0;
	let bestY = -Infinity;
	for (const [pips, normal] of FACES) {
		const y = normal.clone().applyQuaternion(q).y;
		if (y > bestY) {
			bestY = y;
			best = pips;
		}
	}
	expect(bestY).toBeCloseTo(1, 9); // flat on the board, not on an edge
	return best;
}

function tableView(game: Partial<TavlaView> | null, version: number): TableGameView {
	return {
		summary: {
			slot: 'T01',
			game: 'tavla',
			speed: 'normal',
			status: game ? 'playing' : 'lobby',
			players: [],
			spectator_count: 0,
			version,
			result: null,
		},
		game_view: game
			? {
					game: 'tavla',
					white: 1,
					points: new Array<number>(24).fill(0),
					bar: {white: 0, black: 0},
					off: {white: 0, black: 0},
					turn: 1,
					dice: [6, 5],
					opening: null,
					deadline_at: null,
					last_moves: [],
					legal_moves: null,
					...game,
				}
			: null,
		viewer_position: 1,
		spectating: false,
	};
}

describe('DiceAnimation', () => {
	it("the animation always ends on the server's faces (+Y=1 … mapping)", () => {
		expect(new Vector3(1, 0, 0).applyQuaternion(faceUpQuaternion(3, 0))).toEqual(
			expect.objectContaining({y: expect.closeTo(1, 9)}),
		);
		expect(new Vector3(0, 0, -1).applyQuaternion(faceUpQuaternion(5, 0))).toEqual(
			expect.objectContaining({y: expect.closeTo(1, 9)}),
		);
		for (let value = 1; value <= 6; value++)
			for (const yaw of [0, 0.7, -2.1, 3]) expect(upFace(faceUpQuaternion(value, yaw))).toBe(value);

		let version = 10;
		for (let a = 1; a <= 6; a++)
			for (let b = 1; b <= 6; b++) {
				const dice = new DiceAnimation();
				const prev = tableView({turn: 3, dice: [2, 2]}, version);
				version += 1;
				dice.update(prev, tableView({turn: 1, dice: [a, b]}, version), 1000);
				const mid = dice.pose(0, 1000 + DICE_ROLL_MS / 3)!;
				const settled = dice.pose(0, 1000 + DICE_ROLL_MS)!;
				expect(mid.quaternion.angleTo(settled.quaternion)).toBeGreaterThan(0.1); // it does tumble
				expect(upFace(settled.quaternion)).toBe(a);
				expect(upFace(dice.pose(1, 1000 + DICE_ROLL_MS)!.quaternion)).toBe(b);
				expect(dice.pose(0, 1000 + DICE_ROLL_MS)!.offset).toEqual({x: 0, y: 0, z: 0});
			}
	});

	it('runs ≤ 400 ms then stops requesting frames', () => {
		expect(DICE_ROLL_MS).toBeLessThanOrEqual(400);
		const dice = new DiceAnimation();
		dice.update(tableView({turn: 3}, 4), tableView({turn: 1, dice: [3, 4]}, 5), 2000);
		expect(dice.running(2000)).toBe(true);
		expect(dice.running(2000 + DICE_ROLL_MS - 1)).toBe(true);
		expect(dice.running(2000 + DICE_ROLL_MS)).toBe(false);
		// Thrown in from the mover's edge (white's +Z), landing on the rest spot.
		expect(dice.pose(0, 2000)!.offset.z).toBeGreaterThan(0);
		expect(dice.pose(1, 2000 + DICE_ROLL_MS / 2)!.offset.y).toBeGreaterThan(0);
	});

	it('no animation when dice did not change', () => {
		const prev = tableView({turn: 1, dice: [6, 5]}, 7);
		// First sight mid-game: the dice lie still on their faces.
		const fresh = new DiceAnimation();
		fresh.update(null, prev, 0);
		expect(fresh.running(0)).toBe(false);
		expect(upFace(fresh.pose(0, 0)!.quaternion)).toBe(6);
		// The same view again, and a version bump that is not a new turn (someone started watching).
		expect(isNewRoll(prev, prev)).toBe(false);
		expect(isNewRoll(prev, tableView({turn: 1, dice: [6, 5]}, 8))).toBe(false);
		fresh.update(prev, tableView({turn: 1, dice: [6, 5]}, 8), 50);
		expect(fresh.running(50)).toBe(false);
		// The settled faces never move again on a later update.
		const settled = fresh.pose(0, 60)!.quaternion.clone();
		fresh.update(prev, tableView({turn: 1, dice: [6, 5]}, 9), 70);
		expect(fresh.pose(0, 80)!.quaternion.equals(settled)).toBe(true);
		// No dice (lobby, game over): nothing to draw.
		const none = new DiceAnimation();
		none.update(null, tableView(null, 1), 0);
		expect(none.pose(0, 0)).toBeNull();
		none.update(tableView(null, 1), tableView({dice: null, turn: null}, 2), 0);
		expect(none.pose(1, 0)).toBeNull();
		expect(none.running(0)).toBe(false);
	});

	it('an equal roll on the next turn still rolls (version + turn / last_moves, D3)', () => {
		const prev = tableView({turn: 1, dice: [4, 2]}, 20);
		expect(isNewRoll(prev, tableView({turn: 3, dice: [4, 2]}, 21))).toBe(true);
		// The other player passed: the same mover rolls again, its last moves are new.
		expect(isNewRoll(prev, tableView({turn: 1, dice: [4, 2], last_moves: [{from: 6, to: 2, hit: false}]}, 22))).toBe(
			true,
		);
		// The game just started: the opening roll rolls.
		expect(isNewRoll(tableView(null, 3), tableView({turn: 3, dice: [5, 1]}, 4))).toBe(true);
		const dice = new DiceAnimation();
		dice.update(prev, tableView({turn: 3, dice: [4, 2]}, 21), 500);
		expect(dice.running(500)).toBe(true);
		expect(upFace(dice.pose(0, 500 + DICE_ROLL_MS)!.quaternion)).toBe(4);
	});
});
