// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Constants from '@fluxer/constants/src/ApplicationCommandConstants';
import {describe, expect, test} from 'vitest';

describe('application command protocol constants', () => {
	test('supports only chat-input and the seven first-release option types', () => {
		expect(Constants.ApplicationCommandTypes).toEqual({CHAT_INPUT: 1});
		expect(Constants.ApplicationCommandOptionTypes).toEqual({
			STRING: 3,
			INTEGER: 4,
			BOOLEAN: 5,
			USER: 6,
			CHANNEL: 7,
			ROLE: 8,
			NUMBER: 10,
		});
		expect(Constants.InteractionCallbackTypes).toEqual({
			CHANNEL_MESSAGE_WITH_SOURCE: 4,
			DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
		});
		expect(Constants.InteractionResponseFlags).toEqual({EPHEMERAL: 64});
	});

	test('bounds command snapshots, catalogs and interaction work', () => {
		expect(Constants).toMatchObject({
			MAX_APPLICATION_COMMAND_NAME_LENGTH: 32,
			MAX_APPLICATION_COMMAND_DESCRIPTION_LENGTH: 100,
			MAX_APPLICATION_COMMAND_OPTIONS: 25,
			MAX_APPLICATION_COMMAND_CHOICES: 25,
			MAX_APPLICATION_COMMANDS_PER_SCOPE: 100,
			MAX_APPLICATION_COMMAND_CHOICE_NAME_LENGTH: 100,
			MAX_APPLICATION_COMMAND_CHOICE_STRING_LENGTH: 100,
			MAX_APPLICATION_COMMAND_STRING_LENGTH: 6000,
			MAX_APPLICATION_COMMAND_BYTES: 32768,
			MAX_APPLICATION_COMMAND_SET_BYTES: 524288,
			MAX_APPLICATION_COMMAND_CATALOG_PAGE_SIZE: 50,
			MAX_APPLICATION_COMMAND_CATALOG_PAGE_BYTES: 131072,
			APPLICATION_COMMAND_INDEX_BUCKETS: 64,
			APPLICATION_COMMAND_CATALOG_BATCH_SIZE: 8,
			MAX_APPLICATION_COMMAND_CATALOG_CANDIDATES: 50,
			INTERACTION_ACK_TIMEOUT_MS: 3000,
			INTERACTION_TOKEN_BYTES: 32,
			INTERACTION_TTL_SECONDS: 900,
			MAX_INTERACTION_FOLLOWUPS: 20,
			MAX_INTERACTION_RESPONSE_BYTES: 32768,
		});
	});
});
