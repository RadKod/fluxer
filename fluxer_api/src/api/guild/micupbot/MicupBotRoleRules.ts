// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, RoleID} from '@app/api/BrandedTypes';
import {ELEVATED_MFA_PERMISSIONS} from '@app/api/guild/services/GuildMfaEnforcement';
export function micupBotRoleProblem(
	role: {id: RoleID; permissions: bigint; managed?: boolean; isManaged?: boolean},
	guildId: GuildID,
): 'everyone' | 'managed' | 'elevated' | null {
	if (BigInt(role.id) === BigInt(guildId)) return 'everyone';
	if (role.managed || role.isManaged) return 'managed';
	return (role.permissions & ELEVATED_MFA_PERMISSIONS) !== 0n ? 'elevated' : null;
}
