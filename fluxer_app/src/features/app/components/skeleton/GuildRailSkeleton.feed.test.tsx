// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({
	iconUrl: null as string | null,
	singleCommunityEnabled: false,
	directMessagesDisabled: false,
}));

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/ui/state/Dimension', () => ({
	default: {currentGuildListDimensions: () => ({scrollTop: 0})},
}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({
	SKELETON_NO_SELECTED_RAIL_ITEM_INDEX: -1,
	SkeletonGuildRailItemIndicator: {NONE: 'none'},
	SkeletonGuildRailItemKind: {GUILD: 'guild'},
	getRememberedSkeletonGuildRailLayout: () => ({feedVisible: true, organizedItems: []}),
}));

const {GuildRailSkeleton} = await import('@app/features/app/components/skeleton/GuildRailSkeleton');

const FEED_LOGO = '[data-flx="app.skeleton.guild-rail-skeleton.feed-logo-placeholder.item"]';
const INDICATOR =
	'[data-flx="app.skeleton.guild-rail-skeleton.guild-rail-skeleton-indicator.flx-app-guild-rail-skeleton-indicator"]';
const ACTION_TILE = '[data-flx="app.skeleton.guild-rail-skeleton.rail-action-button.item"]';
let container: HTMLDivElement;
let root: Root;

function render(): void {
	container = document.createElement('div');
	root = createRoot(container);
	act(() =>
		root.render(
			createElement(GuildRailSkeleton, {
				isFluxerSelected: false,
				isFavoritesSelected: false,
				isFeedSelected: true,
				isDiscoverySelected: false,
			}),
		),
	);
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	runtime.iconUrl = null;
});

afterEach(() => {
	act(() => root.unmount());
});

describe('startup rail feed tile', () => {
	it('draws the instance icon like the live feed button when branding sets one', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		expect(container.querySelector(`${FEED_LOGO} img`)?.getAttribute('src')).toBe(
			'https://media.example/branding/icon.png',
		);
		expect(container.querySelector(`${FEED_LOGO} ${INDICATOR}`)).not.toBeNull();
	});

	it('hides the instance icon when it does not load', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		const img = container.querySelector<HTMLImageElement>(`${FEED_LOGO} img`);
		act(() => {
			img?.dispatchEvent(new Event('error'));
		});
		expect(img?.hidden).toBe(true);
	});

	it('keeps the newspaper tile without a configured instance icon', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		const actionTilesWithLogo = container.querySelectorAll(ACTION_TILE).length;
		act(() => root.unmount());
		runtime.iconUrl = null;
		render();
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector(FEED_LOGO)).toBeNull();
		// The feed slot is still drawn, as the newspaper action tile.
		expect(container.querySelectorAll(ACTION_TILE).length).toBe(actionTilesWithLogo + 1);
	});
});
