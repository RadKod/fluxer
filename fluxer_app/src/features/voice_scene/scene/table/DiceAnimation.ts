// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameView, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Quaternion, Vector3} from 'three';

// the server rolls; the client only shows its result. ≤ 400 ms, then no more frames.
export const DICE_ROLL_MS = 360;
const SPIN_TURNS = 2;
const HOP_M = 0.05;
const SLIDE_M = 0.12;
const GOLDEN_ANGLE = 2.399963;

const UP = new Vector3(0, 1, 0);
// GLB contract rev 3: tavla_die faces +Y=1, −Y=6, +X=3, −X=4, +Z=2, −Z=5.
const FACE_NORMALS: Record<number, Vector3> = {
	1: new Vector3(0, 1, 0),
	6: new Vector3(0, -1, 0),
	3: new Vector3(1, 0, 0),
	4: new Vector3(-1, 0, 0),
	2: new Vector3(0, 0, 1),
	5: new Vector3(0, 0, -1),
};
const TUMBLE_AXES = [new Vector3(1, 0, 0.6).normalize(), new Vector3(-0.7, 0, 1).normalize()] as const;

// The die turned so `value`'s face points up, then turned `yaw` about the vertical.
export function faceUpQuaternion(value: number, yaw: number): Quaternion {
	return new Quaternion()
		.setFromAxisAngle(UP, yaw)
		.multiply(new Quaternion().setFromUnitVectors(FACE_NORMALS[value]!, UP));
}

const tavlaOf = (view: TableGameView | null): TavlaView | null =>
	view?.game_view?.game === 'tavla' ? view.game_view : null;

// dice are rolled when a turn starts. The table version alone also moves for joins and disconnects, so a
// new roll is a new version with a new turn or new last moves (an equal roll on the next turn still rolls).
// TEMPORARY: one mover playing the very same moves twice around an opponent's pass is not told apart (no roll shown).
export function isNewRoll(prev: TableGameView | null, next: TableGameView): boolean {
	const now = tavlaOf(next);
	if (!now?.dice || prev === null) return false; // first sight mid-game: the dice just lie there
	const before = tavlaOf(prev);
	if (!before) return true; // the game has just started
	if (next.summary.version === prev.summary.version) return false;
	return (
		now.turn !== before.turn ||
		before.dice === null ||
		JSON.stringify(now.last_moves) !== JSON.stringify(before.last_moves)
	);
}

export interface DicePose {
	quaternion: Quaternion;
	// From the rest spot, board-local metres.
	offset: Vec3;
}

export class DiceAnimation {
	private values: readonly [number, number] | null = null;
	private yaws: readonly [number, number] = [0, 0];
	private startMs: number | null = null;
	private edge = 1; // thrown in from white's edge (+Z) or black's (−Z)

	update(prev: TableGameView | null, next: TableGameView, nowMs: number): void {
		const dice = tavlaOf(next)?.dice ?? null;
		if (!dice) {
			this.values = null;
			this.startMs = null;
			return;
		}
		const rolled = isNewRoll(prev, next);
		const changed = this.values === null || this.values[0] !== dice[0] || this.values[1] !== dice[1];
		if (rolled || changed) {
			// Fixed per roll, so the settled dice never jump on a later update.
			const seed = next.summary.version * GOLDEN_ANGLE;
			this.yaws = [seed, seed + 1.9];
			this.startMs = rolled ? nowMs : null;
			const view = tavlaOf(next)!;
			this.edge = view.turn === view.white ? 1 : -1;
		}
		this.values = [dice[0]!, dice[1]!];
	}

	running(nowMs: number): boolean {
		return this.startMs !== null && nowMs - this.startMs < DICE_ROLL_MS;
	}

	// Ends exactly on faceUpQuaternion(value): the spin left over is zero once the roll is over.
	pose(index: 0 | 1, nowMs: number): DicePose | null {
		if (!this.values) return null;
		const t = this.startMs === null ? 1 : Math.min(1, Math.max(0, (nowMs - this.startMs) / DICE_ROLL_MS));
		const settle = 1 - (1 - t) ** 3;
		const end = faceUpQuaternion(this.values[index], this.yaws[index]);
		const quaternion =
			t < 1
				? new Quaternion().setFromAxisAngle(TUMBLE_AXES[index], (1 - settle) * SPIN_TURNS * 2 * Math.PI).multiply(end)
				: end;
		return {
			quaternion,
			offset:
				t < 1
					? {x: 0, y: HOP_M * Math.sin(Math.PI * t) * (1 - t), z: this.edge * SLIDE_M * (1 - settle)}
					: {x: 0, y: 0, z: 0},
		};
	}
}
