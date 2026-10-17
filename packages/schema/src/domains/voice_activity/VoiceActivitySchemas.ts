// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ACTIVITY_IDS} from '@fluxer/constants/src/VoiceActivityConstants';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const VoiceConnectionId = z.string().min(1).max(64).describe("The caller's voice connection ID in this channel");

export const VoiceActivityId = z.enum(VOICE_ACTIVITY_IDS);
export type VoiceActivityId = z.infer<typeof VoiceActivityId>;

export const VoiceActivityQuery = z.object({connection_id: VoiceConnectionId});
export type VoiceActivityQuery = z.infer<typeof VoiceActivityQuery>;

export const StartVoiceActivityRequest = z.object({
	activity_id: VoiceActivityId,
	connection_id: VoiceConnectionId,
});
export type StartVoiceActivityRequest = z.infer<typeof StartVoiceActivityRequest>;

// The same object the room metadata carries under VOICE_ACTIVITY_METADATA_KEY.
export const VoiceActivitySession = z.strictObject({
	activity_id: VoiceActivityId,
	session_id: SnowflakeStringType,
	started_by: SnowflakeStringType,
	started_at: z.number().int().min(0).describe('Start time in ms since the epoch'),
});
export type VoiceActivitySession = z.infer<typeof VoiceActivitySession>;

export const VoiceActivitySessionNullable = VoiceActivitySession.nullable();
