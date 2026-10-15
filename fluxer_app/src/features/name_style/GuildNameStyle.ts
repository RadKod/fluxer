// SPDX-License-Identifier: AGPL-3.0-or-later

import Guilds from '@app/features/guild/state/Guilds';
import type {GuildRoleColors} from '@app/features/name_style/NameStyle';
import type {User} from '@app/features/user/models/User';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';

export interface GuildNameStyleProps {
	nameStyle: NameStyle | null;
	guildRoles: GuildRoleColors | undefined;
}

// For a name in a guild surface: the whole style draws over a role colour, except colours that could pass for one of
// the guild's coloured roles, which give way to the surface's colour.
export function guildNameStyleProps(user: User, guildId: string): GuildNameStyleProps {
	const nameStyle = user.nameStyle;
	return {nameStyle, guildRoles: nameStyle ? Guilds.getGuild(guildId)?.roles : undefined};
}
