// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {useGameActivity} from '@app/features/game_activity/hooks/useGameActivity';
import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const game = {game_id: 'test-game', started_at: 1000};
const record = {user: {id: 'friend'}, game_activity: game} as Parameters<typeof GameActivityStore.update>[0];

describe('game activity hook rollout', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders: number;
	const Row = observer(() => {
		renders += 1;
		const activity = useGameActivity({userId: 'friend'});
		return createElement('span', null, activity && 'game_id' in activity ? activity.game_id : 'empty');
	});
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		GameActivityStore.resetRollout();
		renders = 0;
		container = document.createElement('div');
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.restoreAllMocks();
	});
	it('disabled rows have no game subscription and no redraw for received games', async () => {
		const subscribe = vi.spyOn(GameActivityStore, 'subscribe');
		await act(async () => root.render(createElement(Row)));
		const before = renders;
		await act(async () => GameActivityStore.update(record));
		expect(container.textContent).toBe('empty');
		expect(subscribe).not.toHaveBeenCalled();
		expect(renders).toBe(before);
	});
	it('live close detaches the game subscription and reopen awaits fresh activity', async () => {
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		const subscribe = vi.spyOn(GameActivityStore, 'subscribe');
		await act(async () => root.render(createElement(Row)));
		await act(async () => GameActivityStore.update(record));
		expect(container.textContent).toBe('test-game');
		await act(async () => GameActivityStore.handleRollout({game_activity_enabled: false, game_activity_epoch: 2}));
		expect(container.textContent).toBe('empty');
		const closedRenders = renders;
		const closedSubscriptions = subscribe.mock.calls.length;
		await act(async () => GameActivityStore.update(record));
		expect(renders).toBe(closedRenders);
		expect(subscribe).toHaveBeenCalledTimes(closedSubscriptions);
		await act(async () => GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 3}));
		expect(container.textContent).toBe('empty');
		await act(async () => GameActivityStore.update(record));
		expect(container.textContent).toBe('test-game');
	});
});
