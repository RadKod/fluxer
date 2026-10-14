// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createRoleID} from '@app/api/BrandedTypes';
import {micupBotRoleProblem} from '@app/api/guild/micupbot/MicupBotRoleRules';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {expect, it} from 'vitest';

it('@everyone, managed and elevated roles are problems; a plain role is not', () => {
	const guildId = createGuildID(1n);
	const role = {id: createRoleID(2n), permissions: Permissions.SEND_MESSAGES};
	expect(micupBotRoleProblem({...role, id: createRoleID(1n)}, guildId)).toBe('everyone');
	expect(micupBotRoleProblem({...role, managed: true}, guildId)).toBe('managed');
	expect(micupBotRoleProblem({...role, permissions: Permissions.ADMINISTRATOR}, guildId)).toBe('elevated');
	expect(micupBotRoleProblem(role, guildId)).toBeNull();
});
