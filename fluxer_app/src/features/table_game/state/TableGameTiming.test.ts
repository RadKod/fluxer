// SPDX-License-Identifier: AGPL-3.0-or-later

import {TABLE_GAME_ENDED_TTL_S} from '@app/features/table_game/state/TableGameTiming';
import {describe, expect, it} from 'vitest';
import {TABLE_GAME_TTL_S} from '../../../../../fluxer_api/src/api/table_game/TableGameLimits';

describe('TableGameTiming', () => {
	it("the ended table window matches the API's ended key TTL", () => {
		expect(TABLE_GAME_ENDED_TTL_S).toBe(TABLE_GAME_TTL_S.ended);
	});
});
