// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {TableSceneHud} from '@app/features/voice_scene/hooks/useTableGameScene';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/table_game/state/TableGames', () => ({default: {requestPanel: vi.fn()}}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		small,
		compact,
		fitContainer,
		variant,
		...props
	}: Record<string, unknown> & {children: ReactNode}) => createElement('button', {type: 'button', ...props}, children),
}));

const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {VoiceSceneSeatHud} = await import('@app/features/voice_scene/components/VoiceSceneSeatHud');

function hud(extra: Partial<TableSceneHud> = {}): TableSceneHud {
	return {
		game: 'okey101',
		role: 'player',
		interactive: true,
		stage: null,
		stagedCount: 0,
		tavlaSteps: [],
		tavlaComplete: false,
		pathChoice: null,
		promotion: null,
		openStage: vi.fn(),
		cancelStage: vi.fn(),
		undoTavla: vi.fn(),
		confirmTavla: vi.fn(),
		choosePath: vi.fn(),
		pickPromotion: vi.fn(),
		dismissChoice: vi.fn(),
		previewPath: vi.fn(),
		...extra,
	};
}

let root: Root;
let host: HTMLDivElement;
const onExit = vi.fn();

function render(state: TableSceneHud | null): void {
	act(() => root.render(createElement(VoiceSceneSeatHud, {hud: state, channelId: '500', slot: 'T01', onExit})));
}

const labels = () => [...host.querySelectorAll('button')].map((button) => button.textContent);
const button = (text: string) =>
	[...host.querySelectorAll('button')].find((entry) => entry.textContent === text) as HTMLButtonElement;

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.mocked(TableGames.requestPanel).mockClear();
	onExit.mockClear();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('VoiceSceneSeatHud', () => {
	it('exit, panel, 101 Aç (n)/İptal, tavla Geri al/Tamam appear by game and role', () => {
		render(hud());
		expect(labels()).toEqual(['Back to room', 'Table panel']);
		const staged = hud({stage: {take: null, open: [['t0', 't1', 't2']], add: []}, stagedCount: 3});
		render(staged);
		expect(labels()).toEqual(['Back to room', 'Table panel', 'Open (3)', 'Cancel']);
		act(() => button('Open (3)').click());
		act(() => button('Cancel').click());
		expect(staged.openStage).toHaveBeenCalledTimes(1);
		expect(staged.cancelStage).toHaveBeenCalledTimes(1);
		const tavla = hud({game: 'tavla', tavlaSteps: [{from: 24, to: 18}]});
		render(tavla);
		expect(labels()).toEqual(['Back to room', 'Table panel', 'Undo', 'Done']);
		// The last step of a whole turn sends it by itself; Done is there for a turn the steps already complete.
		expect(button('Done').disabled).toBe(true);
		act(() => button('Undo').click());
		expect(tavla.undoTavla).toHaveBeenCalledTimes(1);
		render(hud({game: 'tavla', tavlaSteps: [{from: 24, to: 18}], tavlaComplete: true}));
		expect(button('Done').disabled).toBe(false);
	});

	it('dama path chooser and chess promotion picker', () => {
		const dama = hud({
			game: 'dama',
			pathChoice: [
				['c3', 'c5', 'e5'],
				['c3', 'e3', 'e5'],
			],
		});
		render(dama);
		expect(labels()).toEqual(['Back to room', 'Table panel', 'c3 → c5 → e5', 'c3 → e3 → e5', 'Cancel']);
		act(() => button('c3 → e3 → e5').click());
		expect(dama.choosePath).toHaveBeenCalledWith(['c3', 'e3', 'e5']);
		const chess = hud({game: 'chess', promotion: {from: 'e7', to: 'e8', side: 'white'}});
		render(chess);
		act(() => (host.querySelector('[data-promotion="q"]') as HTMLButtonElement).click());
		expect(chess.pickPromotion).toHaveBeenCalledWith('q');
	});

	// the buttons name the squares only; the board shows the path while a button is hovered or focused.
	it('hovering or focusing a dama path previews it on the board; leaving it ends the preview', () => {
		const dama = hud({
			game: 'dama',
			pathChoice: [
				['b8', 'b3', 'h3', 'h7'],
				['b8', 'b1', 'h1', 'h7'],
			],
		});
		render(dama);
		const first = button('b8 → b3 → h3 → h7');
		const second = button('b8 → b1 → h1 → h7');
		act(() => first.dispatchEvent(new MouseEvent('mouseover', {bubbles: true})));
		expect(dama.previewPath).toHaveBeenLastCalledWith(['b8', 'b3', 'h3', 'h7']);
		act(() => first.dispatchEvent(new MouseEvent('mouseout', {bubbles: true, relatedTarget: host})));
		expect(dama.previewPath).toHaveBeenLastCalledWith(null);
		act(() => second.focus());
		expect(dama.previewPath).toHaveBeenLastCalledWith(['b8', 'b1', 'h1', 'h7']);
		act(() => second.blur());
		expect(dama.previewPath).toHaveBeenLastCalledWith(null);
		// Cancel is not a path.
		const calls = vi.mocked(dama.previewPath).mock.calls.length;
		act(() => button('Cancel').dispatchEvent(new MouseEvent('mouseover', {bubbles: true})));
		expect(dama.previewPath).toHaveBeenCalledTimes(calls);
	});

	// the picker lays its pieces in one row (the 2D panel), wider than the HUD; Bishop and Knight fell off the right
	// edge. In the HUD they sit two per row. The layout itself is checked on screen (1280 × 720, 1440 × 900).
	it('promotion: all four pieces in the HUD, each named and picking itself, two per row (Y2)', () => {
		const chess = hud({game: 'chess', promotion: {from: 'a7', to: 'a8', side: 'white'}});
		render(chess);
		const hudElement = host.querySelector('[data-seat-hud]')!;
		const choices = [...hudElement.querySelectorAll<HTMLButtonElement>('[data-promotion]')];
		expect(choices.map((choice) => choice.getAttribute('aria-label'))).toEqual(['Queen', 'Rook', 'Bishop', 'Knight']);
		for (const choice of choices) act(() => choice.click());
		expect(vi.mocked(chess.pickPromotion).mock.calls).toEqual([['q'], ['r'], ['b'], ['n']]);
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'VoiceSceneSeatHud.module.css'), 'utf8');
		expect(css).toMatch(/\.hud > fieldset \{[^}]*grid-template-columns: repeat\(2, /);
	});

	it('a table with no view yet still shows exit and panel', () => {
		render(null);
		expect(labels()).toEqual(['Back to room', 'Table panel']);
	});

	it('watchers see only exit and panel', () => {
		render(
			hud({
				role: 'watch',
				interactive: false,
				stage: {take: null, open: [['t0', 't1', 't2']], add: []},
				stagedCount: 3,
			}),
		);
		expect(labels()).toEqual(['Back to room', 'Table panel']);
	});

	it("panel button opens TableGamesEntry's panel (requestPanel); exit leaves the seat view", () => {
		render(hud());
		act(() => button('Table panel').click());
		expect(TableGames.requestPanel).toHaveBeenCalledWith('500', 'T01');
		act(() => button('Back to room').click());
		expect(onExit).toHaveBeenCalledTimes(1);
	});
});
