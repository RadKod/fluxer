// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {runInAction} from 'mobx';
import {act, createElement, forwardRef, type HTMLAttributes, useImperativeHandle, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const Surface = ({children}: HTMLAttributes<HTMLDivElement>) => createElement('div', null, children);
const router = {replaceWith: vi.fn()};
const commands = {
	searchGuilds: vi.fn(async () => ({guilds: [], total: 0, categoryCounts: null})),
	getCategories: vi.fn(async () => []),
};
const http = {get: vi.fn()};
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));
vi.mock('@lingui/react/macro', async () => {
	const {i18n} = await import('@lingui/core');
	return {useLingui: () => ({i18n})};
});
vi.mock('@app/features/navigation/utils/RouterUtils', () => router);
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/discovery/commands/DiscoveryCommands', () => commands);
vi.mock('@app/features/navigation/state/Navigation', () => ({default: {navigateToDiscover: vi.fn()}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {zoomLevel: 1}}));
vi.mock('@app/features/app/components/layout/DiscoveryGuildHeader', () => ({DiscoveryGuildHeader: () => null}));
vi.mock('@app/features/app/components/layout/GuildSidebar', () => ({GuildSidebar: () => null}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: true}}));
vi.mock('@app/features/app/components/skeleton/DiscoverySkeleton', () => ({DiscoveryPageSkeleton: () => null}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({
	SKELETON_DISCOVERY_MIN_CARD_WIDTH_PX: 320,
	SKELETON_DISCOVERY_ESTIMATED_ROW_HEIGHT_PX: 344,
	SKELETON_DISCOVERY_GRID_GAP_PX: 16,
	SKELETON_DISCOVERY_MAX_COLUMNS: 4,
	reportSkeletonDiscoveryGrid: vi.fn(),
}));
vi.mock('@app/features/app/hooks/useSkeletonLayoutMemoryCapture', () => ({useSkeletonLayoutReport: () => {}}));
vi.mock('@app/features/discovery/discovery/DiscoveryEmptyState', () => ({DiscoveryEmptyState: () => null}));
vi.mock('@app/features/discovery/discovery/DiscoveryGridMetrics', () => ({DISCOVERY_GRID_METRICS_STYLE: {}}));
vi.mock('@app/features/discovery/discovery/DiscoveryGuildCard', () => ({}));
vi.mock('@app/features/discovery/discovery/DiscoveryNavbar', () => ({DiscoveryNavbar: () => null}));
vi.mock('@app/features/discovery/discovery/DiscoverySearchFilters', () => ({}));
vi.mock('@app/features/discovery/discovery/DiscoveryTransition', () => ({
	DiscoveryTransition: Surface,
	DiscoveryMotionKind: {RESULTS: 'results'},
}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({getAppRemScale: () => 1}));
vi.mock('@app/features/ui/components/Scroller', () => ({
	Scroller: forwardRef<
		{getViewportElement: () => HTMLDivElement | null; scrollTo: () => void},
		HTMLAttributes<HTMLDivElement>
	>(({children}, ref) => {
		const viewport = useRef<HTMLDivElement>(null);
		useImperativeHandle(ref, () => ({getViewportElement: () => viewport.current, scrollTo: vi.fn()}));
		return createElement('div', {ref: viewport}, children);
	}),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: Surface}));
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: () => ({getVirtualItems: () => [], getTotalSize: () => 0}),
}));

const {default: discovery} = await import('../state/Discovery');
const {DiscoverySidebar} = await import('./DiscoverySidebar');
const {DiscoveryPage} = await import('./DiscoveryPage');
const {DiscoveryLayout} = await import('@app/features/app/components/layout/DiscoveryLayout');

describe('Discovery bot catalog compatibility', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		discovery.reset();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	it('does not list Apps in Discovery navigation', () => {
		act(() => root.render(createElement(DiscoverySidebar)));
		expect(container.textContent).not.toContain('Apps');
		expect(container.textContent).toContain('Communities');
	});
	it('redirects legacy apps state without community or catalog requests', () => {
		runInAction(() => {
			discovery.view = 'apps';
		});
		act(() => root.render(createElement(DiscoveryLayout)));
		expect(router.replaceWith).toHaveBeenCalledWith('/bots');
		expect(commands.searchGuilds).not.toHaveBeenCalled();
		expect(commands.getCategories).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
	});
	it('communities show already settled empty results', async () => {
		runInAction(() => {
			discovery.categoriesLoaded = true;
		});
		await discovery.search({offset: 0});
		act(() => root.render(createElement(DiscoveryPage)));
		expect(container.querySelector('[data-flx="discovery.discovery.discovery-page.content"]')).not.toBeNull();
	});
});
