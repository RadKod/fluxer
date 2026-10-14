// SPDX-License-Identifier: AGPL-3.0-or-later

import * as GatewayConstants from '@fluxer/constants/src/GatewayConstants';
import {expect, test} from 'vitest';

test('registers application command dispatch events without changing opcode values', () => {
	expect(GatewayConstants.ApplicationCommandGatewayEvents).toEqual({
		APPLICATION_COMMANDS_UPDATE: 'APPLICATION_COMMANDS_UPDATE',
		INTERACTION_CREATE: 'INTERACTION_CREATE',
		INTERACTION_RESPONSE_CREATE: 'INTERACTION_RESPONSE_CREATE',
	});
	expect(GatewayConstants.GatewayOpcodes.DISPATCH).toBe(0);
});
