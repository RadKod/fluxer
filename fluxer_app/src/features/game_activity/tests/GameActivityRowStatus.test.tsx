// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({icon: vi.fn(), portal: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', async () => {
	const {setupI18n} = await import('@lingui/core');
	const i18n = setupI18n({locale: 'en', messages: {en: {}}});
	return {useLingui: () => ({i18n})};
});
vi.mock('react-dom', async (importOriginal) => {
	const actual = await importOriginal<typeof import('react-dom')>();
	return {...actual, createPortal: mocks.portal};
});
vi.mock('@fluxer/game_catalog/src/GameCatalog', () => ({
	getGameById: (id: string) => (id === 'known-game' ? {id, name: 'Known game', icon: 'known-game'} : undefined),
}));
vi.mock('@app/features/game_activity/utils/GameIconUrls', () => ({getGameIconUrl: mocks.icon}));
const {GameActivityRowStatus} = await import('@app/features/game_activity/components/GameActivityRowStatus');

describe('GameActivityRowStatus', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		mocks.icon.mockResolvedValue('/assets/known.webp');
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const render = async (
		activity: {game_id: string; started_at: number} | {manual_name: string; started_at: number},
	) => {
		await act(async () => root.render(createElement(GameActivityRowStatus, {activity, className: 'row-slot'})));
	};
	const status = () => container.querySelector('[data-flx="game-activity.row-status"]');

	it('shows the catalog icon and name for a game_id', async () => {
		await render({game_id: 'known-game', started_at: 1});

		expect(status()?.getAttribute('aria-label')).toBe('Playing Known game');
		expect(status()?.classList.contains('row-slot')).toBe(true);
		expect(status()?.textContent).toBe('Known game');
		expect(mocks.icon).toHaveBeenCalledWith('known-game', 64);
		expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/known.webp');
	});

	it('uses the generic controller icon and plain text for a manual name', async () => {
		await render({manual_name: '<img src=x onerror=alert(1)>', started_at: 1});

		expect(status()?.textContent).toBe('<img src=x onerror=alert(1)>');
		expect(status()?.getAttribute('aria-label')).toBe('Playing <img src=x onerror=alert(1)>');
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('svg')).not.toBeNull();
		expect(mocks.icon).not.toHaveBeenCalled();
	});

	it('falls back to a generic name for an unknown game_id', async () => {
		await render({game_id: 'unknown', started_at: 1});

		expect(status()?.textContent).toBe('Game');
		expect(container.querySelector('svg')).not.toBeNull();
	});

	it('adds no timer, observer, layout read or portal per row', async () => {
		const timeout = vi.spyOn(window, 'setTimeout');
		const interval = vi.spyOn(window, 'setInterval');
		const frame = vi.spyOn(window, 'requestAnimationFrame');
		const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
		const observer = vi.fn();
		vi.stubGlobal('IntersectionObserver', observer);
		vi.stubGlobal('ResizeObserver', observer);

		await render({game_id: 'known-game', started_at: 1});
		await render({manual_name: 'Manual', started_at: 2});

		expect(timeout).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();
		expect(frame).not.toHaveBeenCalled();
		expect(rect).not.toHaveBeenCalled();
		expect(observer).not.toHaveBeenCalled();
		expect(mocks.portal).not.toHaveBeenCalled();
	});
});
