// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

const textEncoder = new TextEncoder();
const startedAt = z.number().refine(Number.isSafeInteger, 'Timestamp must be a safe integer');
const gameId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const manualName = z
	.string()
	.refine(
		(value) =>
			Array.from(value).length >= 1 &&
			Array.from(value).length <= 64 &&
			textEncoder.encode(value).length <= 256 &&
			!/(?:\p{Cc}|\p{Cf}|\p{Cs}|\u034f|[\u180b-\u180d]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}])/u.test(value),
		'Game name must contain 1-64 visible Unicode code points and at most 256 UTF-8 bytes',
	);

export const GameActivitySchema = z
	.union([
		z.strictObject({game_id: gameId, started_at: startedAt}),
		z.strictObject({manual_name: manualName, started_at: startedAt}),
	])
	.refine((value) => textEncoder.encode(JSON.stringify(value)).length <= 512, 'Game activity exceeds 512 UTF-8 bytes');

export const GameActivityVisibilitySchema = z.enum(['off', 'friends', 'everyone']);

export const GameActivityPolicyRevisionSchema = z
	.string()
	.regex(/^(0|[1-9][0-9]{0,18})$/)
	.refine((value) => value.length < 19 || value <= '9223372036854775807', 'Policy revision exceeds signed bigint');
