// SPDX-License-Identifier: AGPL-3.0-or-later

import {z} from 'zod';

// Lounge and watch seats only: table seats (seat_T01_1) are taken through the table game routes.
export const VoiceLoungeSeatName = z.string().regex(/^seat_[A-Z][A-Z0-9]*_[0-9]{2}$/);
export const VoiceWatchSeatName = z.string().regex(/^seat_T[0-9]{2}_Y[1-4]$/);

export const PutVoiceSeatRequest = z.object({
	connection_id: z.string().min(1).max(64).describe('Voice connection ID of the caller'),
	seat: z
		.union([VoiceLoungeSeatName, VoiceWatchSeatName])
		.nullable()
		.describe('Lounge or watch seat to take; null lets the server pick a free lounge seat'),
});

export type PutVoiceSeatRequest = z.infer<typeof PutVoiceSeatRequest>;

export const VoiceSeatResponse = z.object({
	seat: z.string().nullable().describe('Seat the connection now holds; null when standing'),
});

export type VoiceSeatResponse = z.infer<typeof VoiceSeatResponse>;
