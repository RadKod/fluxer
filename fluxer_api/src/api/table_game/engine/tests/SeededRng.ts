// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Rng} from '@app/api/table_game/engine/TableGameEngine';

// Test-only deterministic generator (mulberry32) so a seed replays a whole game. Production engines get CryptoRng.
export class SeededRng implements Rng {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	int(maxExclusive: number): number {
		if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
			throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
		}
		return Math.floor(this.next() * maxExclusive);
	}

	private next(): number {
		this.state = (this.state + 0x6d2b79f5) >>> 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
}
