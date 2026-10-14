// SPDX-License-Identifier: AGPL-3.0-or-later

import {type OkeyStage, stagedTiles, stageToAction} from '@app/features/table_game/components/okey/Okey101Staging';
import {describe, expect, it} from 'vitest';

const ADD = {meld_id: 2, tiles: ['t19'], at: 'end' as const};

describe('Okey101Staging', () => {
	it('stage → meld{open,add}', () => {
		const stage: OkeyStage = {take: null, open: [['t0', 't1', 't2']], add: [ADD]};
		expect(stageToAction(stage)).toEqual({type: 'meld', open: [['t0', 't1', 't2']], add: [ADD]});
		expect(stageToAction({take: null, open: [['t0', 't1', 't2']], add: []})).toEqual({
			type: 'meld',
			open: [['t0', 't1', 't2']],
		});
	});

	it('stage with take → take_discard{open,add}', () => {
		expect(stageToAction({take: 't40', open: [['t13', 't14', 't40']], add: []})).toEqual({
			type: 'take_discard',
			open: [['t13', 't14', 't40']],
		});
		expect(stageToAction({take: 't19', open: [], add: [ADD]})).toEqual({type: 'take_discard', add: [ADD]});
	});

	it('staged tiles: the taken tile, the sets to open and the additions', () => {
		expect(stagedTiles({take: 't40', open: [['t13', 't14', 't40']], add: [ADD]}).sort()).toEqual([
			't13',
			't14',
			't19',
			't40',
		]);
	});

	it('cancel clears: a dropped stage (null) holds nothing', () => {
		expect(stagedTiles(null)).toEqual([]);
	});
});
