// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayCustomStatusPayload} from '@app/features/user/state/CustomStatus';
import type {UserPartial} from '@fluxer/schema/src/domains/user/UserResponseSchemas';

export type GameActivity =
	| {readonly game_id: string; readonly started_at: number}
	| {readonly manual_name: string; readonly started_at: number};

export interface PresenceRecord {
	readonly guild_id?: string | null;
	readonly user: UserPartial;
	readonly status?: string | null;
	readonly afk?: boolean;
	readonly mobile?: boolean;
	readonly custom_status?: GatewayCustomStatusPayload | null;
	readonly game_activity?: GameActivity | null;
}

export type Presence = PresenceRecord;
