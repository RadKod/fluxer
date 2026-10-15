// SPDX-License-Identifier: AGPL-3.0-or-later

import {ZodOpenAPIConverter} from '@fluxer/openapi/src/converters/ZodToOpenAPI';
import {UserSettingsResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it} from 'vitest';

describe('game activity settings response components', () => {
	it.each(['draft-2020-12', 'openapi-3.0'] as const)('publishes non-null defaults for %s', (target) => {
		const converter = new ZodOpenAPIConverter(target);
		const schema = converter.getSchema('UserSettingsResponse', UserSettingsResponse, 'output');

		expect(schema.properties?.game_activity_visibility).toEqual({
			type: 'string',
			enum: ['off', 'friends', 'everyone'],
			default: 'off',
			description: 'Who can see the current game',
		});
		expect(schema.properties?.game_activity_policy_revision).toEqual({
			type: 'string',
			pattern: '^(0|[1-9][0-9]{0,18})$',
			default: '0',
			description: 'Server-owned game sharing policy revision as a decimal string',
		});
		expect(schema.required).toEqual(
			expect.arrayContaining(['game_activity_visibility', 'game_activity_policy_revision']),
		);
	});
});
