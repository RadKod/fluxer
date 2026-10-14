// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));
vi.mock('@app/features/navigation/utils/ChannelNavigationGuard', () => ({
	tryInterceptChannelNavigationPath: () => false,
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
	},
}));

const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');

const at = (path: string) => window.history.replaceState(null, '', path);
const here = () => window.location.pathname + window.location.search;

// Micup: premium, the shop and the bots open beside the sidebar they are opened from, whoever opens them.
describe('RouterUtils section pages', () => {
	beforeEach(() => at('/channels/@me'));

	it('opens a shared page beside the feed while the feed is shown', () => {
		at('/feed');
		RouterUtils.transitionTo('/premium');
		expect(here()).toBe('/feed/premium');
		RouterUtils.transitionTo('/shop?set=42');
		expect(here()).toBe('/feed/shop?set=42');
		RouterUtils.replaceWith('/shop');
		expect(here()).toBe('/feed/shop');
		RouterUtils.transitionTo('/bots');
		expect(here()).toBe('/feed/bots');
	});

	it('opens the same pages beside the DM list from anywhere else', () => {
		RouterUtils.transitionTo('/premium');
		expect(here()).toBe('/premium');
		RouterUtils.replaceWith('/shop');
		expect(here()).toBe('/shop');
	});

	it('does not push the page it is already on', () => {
		at('/feed/shop');
		const length = window.history.length;
		RouterUtils.transitionTo('/shop');
		expect(here()).toBe('/feed/shop');
		expect(window.history.length).toBe(length);
	});
});
