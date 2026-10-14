// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';

export interface Rng {
	int(maxExclusive: number): number;
}

// The only randomness table games use in production (shuffle, indicator, colours): node:crypto only.
export const CryptoRng: Rng = {int: (maxExclusive) => crypto.randomInt(maxExclusive)};
