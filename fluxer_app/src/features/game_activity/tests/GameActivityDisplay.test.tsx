// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return observable({
		friend: true,
		blocked: false,
		rolloutEnabled: true,
		activity: {manual_name: '<img src=x onerror=alert(1)>', started_at: 0} as
			| {manual_name: string; started_at: number}
			| {game_id: string; started_at: number},
		local: null,
	});
});
const mocks = vi.hoisted(() => ({icon: vi.fn(), subscribe: vi.fn(() => vi.fn())}));
vi.mock('@app/features/game_activity/state/GameActivityStore', () => ({
	default: {
		get enabled() {
			return state.rolloutEnabled;
		},
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', async () => {
	const {setupI18n} = await import('@lingui/core');
	const i18n = setupI18n({locale: 'en', messages: {en: {}}});
	return {useLingui: () => ({i18n})};
});
vi.mock('@app/features/game_activity/hooks/useGameActivity', () => ({
	useGameActivity: ({enabled}: {enabled: boolean}) => (enabled ? state.activity : null),
}));
vi.mock('@app/features/game_activity/state/GameActivityMinuteClock', () => ({
	default: {subscribe: mocks.subscribe, getSnapshot: () => 120_000},
	getGameActivityElapsed: (started: number, now: number) => Math.max(0, now - started),
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({
	default: {
		getRelationship: () => ({type: state.friend ? RelationshipTypes.FRIEND : RelationshipTypes.INCOMING_REQUEST}),
		isBlocked: () => state.blocked,
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: 'self'}}}));
vi.mock('@app/features/game_activity/utils/DesktopGameActivityBridge', () => ({
	default: {
		get activity() {
			return state.local;
		},
	},
}));
vi.mock('@fluxer/game_catalog/src/GameCatalog', () => ({
	getGameById: (id: string) => (id === 'known-game' ? {id, name: 'Known game', icon: 'known-game'} : undefined),
}));
vi.mock('@app/features/game_activity/utils/GameIconUrls', () => ({getGameIconUrl: mocks.icon}));
const {GameActivityDisplay} = await import('@app/features/game_activity/components/GameActivityDisplay');

describe('Game activity display', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
		vi.stubGlobal('IntersectionObserver', undefined);
		vi.clearAllMocks();
		state.friend = true;
		state.blocked = false;
		state.rolloutEnabled = true;
		state.activity = {manual_name: '<img src=x onerror=alert(1)>', started_at: 0};
		mocks.icon.mockResolvedValue('/assets/hash.webp');
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	const render = async (visible = true, userId = 'friend') =>
		act(async () => root.render(createElement(GameActivityDisplay, {userId, visible})));
	it('closed rollout does not show remote activity or subscribe to the clock', async () => {
		state.rolloutEnabled = false;
		await render();
		expect(container.textContent).toBe('');
		expect(mocks.subscribe).not.toHaveBeenCalled();
		expect(mocks.icon).not.toHaveBeenCalled();
	});
	it('shows the store game without a friend or full profile condition; hides blocked and remote self data', async () => {
		await render();
		expect(container.textContent).toContain('Playing now');
		state.friend = false;
		await render();
		expect(container.textContent).toContain('Playing now');
		state.friend = true;
		state.blocked = true;
		await render();
		expect(container.textContent).toBe('');
		state.blocked = false;
		await render(true, 'self');
		expect(container.textContent).toBe('');
	});
	it('manual_text_escaped and duration is shown', async () => {
		await render();
		expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
		expect(container.querySelector('img')).toBeNull();
		expect(container.textContent).toContain('2 min');
	});
	it('unknown_id_no_external_fetch', async () => {
		state.activity = {game_id: 'unknown-game', started_at: 0};
		await render();
		expect(container.textContent).toContain('Game');
		expect(mocks.icon).not.toHaveBeenCalled();
	});
	it('lazy_icons_only_when_visible', async () => {
		state.activity = {game_id: 'known-game', started_at: 0};
		await render(false);
		expect(mocks.icon).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
		await render();
		expect(mocks.icon).toHaveBeenCalledTimes(1);
		expect(mocks.icon).toHaveBeenCalledWith('known-game', 64);
		expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/hash.webp');
	});
	it('all_profile_surfaces_once shares UserInfo on the full page', () => {
		const read = (path: string) => readFileSync(resolve('src/features/user/components', path), 'utf8');
		for (const path of [
			'popouts/UserProfilePopout.tsx',
			'modals/user_profile_modal/UserProfileModalUserInfo.tsx',
			'modals/UserProfileMobileSheet.tsx',
		]) {
			expect(read(path).match(/<GameActivityDisplay\b/g)).toHaveLength(1);
			expect(read(path)).not.toMatch(/fullProfile|gameActivityProfileFull/);
		}
		const page = read('pages/UserProfilePage.tsx');
		expect(page.match(/<UserInfo\b/g)).toHaveLength(1);
		expect(page).not.toContain('<GameActivityDisplay');
	});
	it('hidden document removes visible clock and stops icon requests', async () => {
		state.activity = {game_id: 'known-game', started_at: 0};
		Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
		await render();
		expect(mocks.icon).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
		await act(async () => {
			Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(mocks.icon).toHaveBeenCalledOnce();
	});
});
