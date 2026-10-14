// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserRow} from '@app/api/database/types/UserTypes';
import type {UsernameMigrationConfig} from '@app/api/instance/AccountIdentityModeCache';
import type {User} from '@app/api/models/User';
import {isAccountClosed} from '@app/api/user/UserHelpers';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';

export type GatedAction =
	| 'message'
	| 'reaction'
	| 'guild_join'
	| 'bot_add'
	| 'guild_create'
	| 'dm_open'
	| 'group_dm'
	| 'relationship_create'
	| 'voice_join';

export class UsernameSelectionGate {
	constructor(
		private readonly getMigration: () => {state: UsernameMigrationConfig['state']; forcedAt: Date | null},
		private readonly readUsernameState: (user: User) => UserRow['username_state'],
		private readonly now: () => number = Date.now,
	) {}

	assertMayAct(user: User, _action: GatedAction): void {
		const now = this.now();
		const suspended =
			(user.flags & UserFlags.DISABLED) !== 0n &&
			(user.tempBannedUntil === null || user.tempBannedUntil.getTime() > now);
		if (user.isBot || user.isSystem || isAccountClosed(user) || suspended) return;
		const state = this.readUsernameState(user);
		if (state === 'selected') return;
		if (state !== 'reselect_required') {
			const migration = this.getMigration();
			if (migration.state !== 'selecting' || migration.forcedAt === null || now < migration.forcedAt.getTime()) {
				return;
			}
		}
		throw new FluxerError({code: APIErrorCodes.USERNAME_SELECTION_REQUIRED, status: 403});
	}
}
