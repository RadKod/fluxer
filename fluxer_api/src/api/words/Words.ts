// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomBytes, randomInt} from 'node:crypto';
import {scales, tails} from '@app/api/utils/UsernameGenerator';

export function generateConnectionId(): string {
	const scale = scales[randomInt(scales.length)];
	const tail = tails[randomInt(tails.length)];
	// The gateway keys voice states by this id alone (per guild, and per node for voice
	// counts). The word pairs repeat among a few hundred live connections; the random
	// suffix makes the space word pairs x 2^32.
	return `${tail}-${scale}-${randomBytes(4).toString('hex')}`;
}
