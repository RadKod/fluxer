// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Presentation only: legality comes from TavlaSteps and the server's legal_moves.
export function tavlaBoardModel(view: TavlaView, position: number | null, steps: ReadonlyArray<TavlaStep>) {
	const side = position === null || position === view.white ? 'white' : 'black';
	const opponent = side === 'white' ? 'black' : 'white';
	const sign = side === 'white' ? 1 : -1;
	const points = [...view.points];
	const bar = {...view.bar};
	const off = {...view.off};
	for (const step of steps) {
		if (step.from === 'bar') bar[side]--;
		else points[step.from - 1]! -= sign;
		if (step.to === 'off') off[side]++;
		else {
			if (points[step.to - 1] === -sign) {
				bar[opponent]++;
				points[step.to - 1] = 0;
			}
			points[step.to - 1]! += sign;
		}
	}
	const whiteOrder = Array.from({length: 24}, (_, i) => (i < 12 ? i + 13 : 24 - i));
	return {points, bar, off, side, order: side === 'white' ? whiteOrder : whiteOrder.map((p) => 25 - p)} as const;
}
