// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TableGameOutcome} from '@app/features/table_game/commands/TableGameCommands';
import type {TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/table_game/state/TableGames', async () => {
	const {observable} = await import('mobx');
	const summaries = observable.map<string, TableGameSummary>({}, {deep: false});
	const watchModes = observable.map<string, string>({});
	return {
		default: {
			getSummary: (_channelId: string, slot: string) => summaries.get(slot) ?? null,
			getWatchMode: (_channelId: string, slot: string) => watchModes.get(slot) ?? null,
		},
		summaries,
		watchModes,
	};
});
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	spectate: vi.fn(() => Promise.resolve({ok: true})),
	unspectate: vi.fn(() => Promise.resolve({ok: true})),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));

const {summaries, watchModes} = (await import('@app/features/table_game/state/TableGames')) as unknown as {
	summaries: Map<string, TableGameSummary>;
	watchModes: Map<string, string>;
};
const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {SPECTATE_RETRY_MS, useWatchSeatSpectate} = await import('@app/features/voice_scene/hooks/useWatchSeatSpectate');

const summary = (status: TableGameSummary['status'], players: Array<string> = ['7']): TableGameSummary => ({
	slot: 'T01',
	game: 'chess',
	speed: 'normal',
	status,
	players: players.map((user_id, index) => ({position: index * 2 + 1, user_id, connected: true, timeouts: 0})),
	spectator_count: 0,
	version: 3,
	result: null,
});

const Probe = observer(function Probe({watchSlot}: {watchSlot: string | null}) {
	useWatchSeatSpectate({channelId: '500', watchSlot, userId: '1'});
	return null;
});

let root: Root;
function render(watchSlot: string | null): void {
	act(() => root.render(createElement(Probe, {watchSlot})));
}
const set = (value: TableGameSummary | null) =>
	act(() => {
		if (value) summaries.set('T01', value);
		else summaries.delete('T01');
	});

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.mocked(TableGameCommands.spectate).mockReset().mockResolvedValue({ok: true});
	vi.mocked(TableGameCommands.unspectate).mockClear();
	vi.mocked(ToastCommands.createToast).mockClear();
	act(() => {
		summaries.clear();
		watchModes.clear();
	});
	root = createRoot(document.createElement('div'));
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
});

const FAILED = {ok: false, error: 'failed'} as const;
const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));
// The next spectate request stays in flight until the returned function answers it.
function inFlightSpectate(): (outcome: TableGameOutcome) => void {
	let answer: (outcome: TableGameOutcome) => void = () => {};
	vi.mocked(TableGameCommands.spectate).mockReturnValueOnce(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	return (outcome) => answer(outcome);
}

describe('useWatchSeatSpectate', () => {
	it('sitting at a watch seat of a live table spectates once', () => {
		set(summary('playing'));
		render('T01');
		render('T01');
		set({...summary('playing'), version: 4});
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.spectate).toHaveBeenCalledWith('500', 'T01');
		expect(TableGameCommands.unspectate).not.toHaveBeenCalled();
	});

	it('joining the table from a watch seat stops spectating once', () => {
		set(summary('lobby'));
		render('T01');
		// The join lands first (a player cannot watch their own table); the server then moves my voice seat.
		set(summary('lobby', ['7', '1']));
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(1);
		render(null);
		set(summary('playing', ['7', '1']));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.unspectate).toHaveBeenCalledWith('500', 'T01');
	});

	it('a table created while I sit there is spectated', () => {
		render('T01');
		expect(TableGameCommands.spectate).not.toHaveBeenCalled();
		set(summary('lobby'));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(1);
	});

	it('leaving the watch seat unspectates', () => {
		set(summary('playing'));
		render('T01');
		render(null);
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(1);
	});

	it('an ended table is let go; the next table on that slot is spectated again', () => {
		// A new table clears the slot's watchers on the server, so each table is watched on its own.
		set(summary('playing'));
		render('T01');
		set(summary('ended'));
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(1);
		set({...summary('lobby'), version: 0});
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(2);
	});

	it('a failed spectate is tried once more, then told (D2)', async () => {
		vi.useFakeTimers();
		vi.mocked(TableGameCommands.spectate).mockResolvedValue(FAILED);
		set(summary('playing'));
		render('T01');
		await settle();
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(1);
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(SPECTATE_RETRY_MS));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(2);
		expect(ToastCommands.createToast).toHaveBeenCalledTimes(1);
		expect(vi.mocked(ToastCommands.createToast).mock.calls[0]![0]).toMatchObject({
			type: 'error',
			children: 'Could not reach the table. Try again.',
		});
		await act(async () => vi.advanceTimersByTimeAsync(60_000));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(2);
	});

	it('a spectate that works on the retry tells nothing; a refusal is told at once', async () => {
		vi.useFakeTimers();
		vi.mocked(TableGameCommands.spectate).mockResolvedValueOnce(FAILED);
		set(summary('playing'));
		render('T01');
		await act(async () => vi.advanceTimersByTimeAsync(SPECTATE_RETRY_MS));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(2);
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
		render(null);
		// The server's answer stands (table games off): retrying cannot change it.
		vi.mocked(TableGameCommands.spectate).mockResolvedValueOnce({ok: false, error: 'disabled'});
		render('T01');
		await settle();
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(3);
		expect(ToastCommands.createToast).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTimeAsync(SPECTATE_RETRY_MS));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(3);
	});

	it('standing up before the retry drops it and tells nothing', async () => {
		vi.useFakeTimers();
		vi.mocked(TableGameCommands.spectate).mockResolvedValue(FAILED);
		set(summary('playing'));
		render('T01');
		await settle();
		render(null);
		await act(async () => vi.advanceTimersByTimeAsync(SPECTATE_RETRY_MS * 2));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(1);
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
	});

	it('a spectate success that lands after I stood up unspectates', async () => {
		vi.useFakeTimers();
		set(summary('playing'));
		// The first request answers after I stood up.
		let answer = inFlightSpectate();
		render('T01');
		render(null);
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(1);
		await act(async () => answer({ok: true}));
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(2);
		// The retry answers after I stood up.
		vi.mocked(TableGameCommands.spectate).mockResolvedValueOnce(FAILED);
		render('T01');
		await settle();
		answer = inFlightSpectate();
		await act(async () => vi.advanceTimersByTimeAsync(SPECTATE_RETRY_MS));
		expect(TableGameCommands.spectate).toHaveBeenCalledTimes(3);
		render(null);
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(3);
		await act(async () => answer({ok: true}));
		expect(TableGameCommands.unspectate).toHaveBeenCalledTimes(4);
		expect(TableGameCommands.unspectate).toHaveBeenLastCalledWith('500', 'T01');
		expect(ToastCommands.createToast).not.toHaveBeenCalled();
	});

	it('a table I already watch by hand is left alone', () => {
		set(summary('playing'));
		act(() => watchModes.set('T01', 'live'));
		render('T01');
		render(null);
		expect(TableGameCommands.spectate).not.toHaveBeenCalled();
		expect(TableGameCommands.unspectate).not.toHaveBeenCalled();
	});
});
