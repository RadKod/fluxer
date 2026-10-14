// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testChessGameView, testOkeyGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	tick: vi.fn(() => Promise.resolve({ok: true})),
}));

const {tick} = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {useTableDeadlineTick, resetTableDeadlineTicksForTests} = await import(
	'@app/features/table_game/hooks/useTableDeadlineTick'
);

const CHANNEL = '500';
const NOW = Date.parse('2026-10-03T10:00:00.000Z');

function Probe(): null {
	useTableDeadlineTick(CHANNEL, 'T01');
	return null;
}

let root: Root | null = null;

function mount(): void {
	root = createRoot(document.createElement('div'));
	act(() => root!.render(createElement(Probe)));
}

function show(view: ReturnType<typeof testView>): void {
	act(() => {
		TableGames.handleView(CHANNEL, view, 'event');
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.spyOn(Math, 'random').mockReturnValue(0);
	vi.mocked(tick).mockClear();
	TableGames.reset();
	resetTableDeadlineTicksForTests();
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('useTableDeadlineTick', () => {
	it("sends one {type:'tick'} 1 s after deadline_at; not again for the same version", async () => {
		show(testView({version: 4, gameView: testOkeyGameView({deadline_at: new Date(NOW + 3000).toISOString()})}));
		mount();
		await act(() => vi.advanceTimersByTimeAsync(3999));
		expect(tick).not.toHaveBeenCalled();
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(vi.mocked(tick).mock.calls).toEqual([[CHANNEL, 'T01']]);
		act(() => root!.unmount());
		mount();
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(tick).toHaveBeenCalledTimes(1);
		show(testView({version: 5, gameView: testOkeyGameView({deadline_at: new Date(NOW + 70_000).toISOString()})}));
		await act(() => vi.advanceTimersByTimeAsync(11_000));
		expect(tick).toHaveBeenCalledTimes(2);
	});

	it('tick waits 1 s + jitter (0–1500 ms)', async () => {
		vi.mocked(Math.random).mockReturnValue(0.999);
		show(testView({version: 4, gameView: testOkeyGameView({deadline_at: new Date(NOW).toISOString()})}));
		mount();
		await act(() => vi.advanceTimersByTimeAsync(2497));
		expect(tick).not.toHaveBeenCalled();
		await act(() => vi.advanceTimersByTimeAsync(2));
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it('spectators never tick', async () => {
		show(
			testView({
				version: 4,
				viewerPosition: null,
				spectating: true,
				gameView: testOkeyGameView({deadline_at: new Date(NOW).toISOString()}),
			}),
		);
		mount();
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(tick).not.toHaveBeenCalled();
	});

	it("chess deadline is the mover's turn start plus the mover's remaining clock", async () => {
		show(
			testView({
				game: 'chess',
				version: 2,
				gameView: testChessGameView({
					fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
					clocks_ms: {white: 590_000, black: 5000},
					turn_started_at: new Date(NOW).toISOString(),
				}),
			}),
		);
		mount();
		await act(() => vi.advanceTimersByTimeAsync(5999));
		expect(tick).not.toHaveBeenCalled();
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it('no tick for a table that is not playing', async () => {
		show(
			testView({version: 4, status: 'ended', gameView: testOkeyGameView({deadline_at: new Date(NOW).toISOString()})}),
		);
		mount();
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(tick).not.toHaveBeenCalled();
	});
});
