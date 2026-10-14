// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));

const {ChessPromotionPicker} = await import('@app/features/table_game/components/ChessPromotionPicker');

describe('ChessPromotionPicker', () => {
	it('picker is reusable outside the board: four named pieces in the side colour, one pick each', async () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const host = document.createElement('div');
		document.body.append(host);
		const root = createRoot(host);
		const onPick = vi.fn();
		await act(async () => root.render(createElement(ChessPromotionPicker, {side: 'black', onPick})));
		expect(host.textContent).toContain('Promote the pawn to');
		const choices = [...host.querySelectorAll<HTMLButtonElement>('[data-promotion]')];
		expect(choices.map((choice) => choice.getAttribute('data-promotion'))).toEqual(['q', 'r', 'b', 'n']);
		expect(choices.map((choice) => choice.getAttribute('aria-label'))).toEqual(['Queen', 'Rook', 'Bishop', 'Knight']);
		expect(choices.every((choice) => choice.getAttribute('data-side') === 'black')).toBe(true);
		await act(async () => choices[3]!.click());
		expect(onPick.mock.calls).toEqual([['n']]);
		act(() => root.unmount());
		host.remove();
	});
});
