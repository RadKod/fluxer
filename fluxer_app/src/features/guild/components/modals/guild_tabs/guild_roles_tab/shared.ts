// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildRole} from '@app/features/guild/models/GuildRole';

export const ROLE_DND_TYPE = 'guild-role';
export const GUILD_ROLES_TAB_ID = 'roles';

export interface RoleDragItem {
	type: typeof ROLE_DND_TYPE;
	id: string;
	isEveryone: boolean;
	isLocked: boolean;
}

export interface RoleUpdate {
	id: string;
	name?: string;
	color?: number;
	colorSecondary?: number | null;
	iconEmojiId?: string | null;
	unicodeEmoji?: string | null;
	hoist?: boolean;
	mentionable?: boolean;
	permissions?: bigint;
}

export function applyRoleUpdate(role: GuildRole, updates: RoleUpdate | undefined): GuildRole {
	if (!updates) return role;
	return role.withUpdates({
		name: updates.name ?? role.name,
		color: updates.color ?? role.color,
		color_secondary: updates.colorSecondary !== undefined ? updates.colorSecondary : role.colorSecondary,
		icon_emoji_id: updates.iconEmojiId !== undefined ? updates.iconEmojiId : role.iconEmojiId,
		unicode_emoji: updates.unicodeEmoji !== undefined ? updates.unicodeEmoji : role.unicodeEmoji,
		hoist: updates.hoist ?? role.hoist,
		mentionable: updates.mentionable ?? role.mentionable,
		permissions: updates.permissions?.toString() ?? role.permissions.toString(),
		position: role.position,
	});
}
