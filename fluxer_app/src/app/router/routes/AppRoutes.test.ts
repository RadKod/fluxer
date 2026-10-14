// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import Authentication from '@app/features/auth/state/Authentication';
import {Redirect, type RouteContext} from '@app/features/platform/components/router/RouterTypes';
import {isReservedVanityCode} from '@fluxer/schema/src/primitives/MicupBrandGuard';
import type {ReactElement} from 'react';
import {describe, expect, it, vi} from 'vitest';

const available = vi.hoisted(() => ({premium: true, shop: true}));
const none = vi.hoisted(() => () => null);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({isPremiumPageAvailable: () => available.premium}));
vi.mock('@app/features/shop/utils/ShopAvailability', () => ({isShopPageAvailable: () => available.shop}));
// The rest of the tree only has to import: the layouts and stores read the page bootstrap.
vi.mock('@app/app/router/routes/RootRoutes', async () => {
	const {createRootRoute} = await import('@app/features/platform/components/router/RouterBuilder');
	return {rootRoute: createRootRoute()};
});
vi.mock('@app/app/router/components/GuildChannelRouter', () => ({GuildChannelRouter: none}));
vi.mock('@app/features/app/components/AppNotificationBadge', () => ({AppBadge: none}));
vi.mock('@app/features/app/components/layout/AppLayout', () => ({AppLayout: none}));
vi.mock('@app/features/app/components/layout/DiscoveryLayout', () => ({DiscoveryLayout: none}));
vi.mock('@app/features/app/components/layout/FavoritesLayout', () => ({FavoritesLayout: none}));
vi.mock('@app/features/app/components/layout/GuildsLayout', () => ({GuildsLayout: none}));
vi.mock('@app/features/app/components/pages/NotFoundPage', () => ({NotFoundPage: none}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {getSnapshotOrNull: () => null}}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {
		get isAuthenticated() {
			return false;
		},
	},
}));
vi.mock('@app/features/auth/flow/auth_login_core/useDesktopHandoffFlow', () => ({isHandoffRequest: vi.fn()}));
vi.mock('@app/features/channel/components/ChannelIndexPage', () => ({ChannelIndexPage: none}));
vi.mock('@app/features/channel/components/ChannelLayout', () => ({ChannelLayout: none}));
vi.mock('@app/features/channel/components/direct_message/DirectMessageLayout', () => ({DMLayout: none}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({
	marketingUrl: (path: string) => path,
	setPathQueryParams: (path: string) => path,
}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({}));
vi.mock('@app/features/navigation/utils/DefaultLandingUtils', () => ({getDirectMessagesFallbackPath: () => '/'}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({useParams: () => ({userId: '42'})}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {isInitialized: true}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {}}));
vi.mock('@app/features/gateway/transport/GatewayConnection', () => ({default: {}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {}}));

const {appRouteTree, premiumCallbackRoute} = await import('@app/app/router/routes/AppRoutes');

const enter = (id: string) =>
	appRouteTree
		.build()
		.find((route) => route.id === id)
		?.onEnter?.({} as RouteContext);

describe('the bot system route', () => {
	it('keeps a direct /bots opening on the app route instead of a short invite', () => {
		vi.stubGlobal('window', {location: {pathname: '/bots', search: ''}});
		vi.spyOn(Authentication, 'isAuthenticated', 'get').mockReturnValue(true);
		try {
			expect(isReservedVanityCode(window.location.pathname.slice(1))).toBe(true);
			const route = appRouteTree.build().find((route) => route.path === window.location.pathname);
			expect(route?.id).toBe('bots');
			expect(route?.parentId).toBe('guildsLayout');
			expect(enter('appLayout')).toBeUndefined();
			expect(enter('bots')).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});

	it('opens the lazy bot page beside the DM list under the app login guard', () => {
		const route = appRouteTree.build().find((route) => route.id === 'bots');
		expect(route?.path).toBe('/bots');
		expect(Routes.isSpecialPage('/bots')).toBe(true);
		expect(route?.parentId).toBe('guildsLayout');
		expect(route?.preload).toBeTypeOf('function');
		expect(enter('bots')).toBeUndefined();
		const Component = route!.component as unknown as () => ReactElement<{children: ReactElement}>;
		expect((Component().props.children.type as {displayName?: string}).displayName).toBe('BotsPage');
	});
});

// Micup: /premium and /shop open only where the page exists; a link or a reload elsewhere lands on Friends.
describe.each(['premium', 'shop'] as const)('the %s route', (id) => {
	it('opens where the page is available', () => {
		available[id] = true;
		expect(enter(id)).toBeUndefined();
	});

	it('redirects to Friends where it is not', () => {
		available[id] = false;
		const result = enter(id);
		expect(result).toBeInstanceOf(Redirect);
		expect((result as Redirect).to).toBe(Routes.ME);
	});
});

// Micup: the same pages opened from the feed stay beside the feed sidebar: the feed page with the page inside.
describe.each([
	['feedPremium', '/feed/premium', 'PremiumPage'],
	['feedShop', '/feed/shop', 'ShopPage'],
	['feedBots', '/feed/bots', 'BotsPage'],
] as const)('the %s route', (id, path, page) => {
	it('renders the page inside the feed page under the guilds layout', () => {
		const route = appRouteTree.build().find((route) => route.id === id);
		expect(route?.path).toBe(path);
		expect(route?.parentId).toBe('guildsLayout');
		expect(route?.preload).toBeTypeOf('function');
		expect(Routes.isSpecialPage(path)).toBe(false);
		const Component = route!.component as unknown as () => ReactElement<{children: ReactElement}>;
		const element = Component();
		expect((element.type as {displayName?: string}).displayName).toBe('FeedPage');
		expect((element.props.children.type as {displayName?: string}).displayName).toBe(page);
	});
});

describe.each([
	['feedPremium', 'premium'],
	['feedShop', 'shop'],
] as const)('the %s route', (id, gate) => {
	it('opens where the page is available and falls back to the feed where it is not', () => {
		available[gate] = true;
		expect(enter(id)).toBeUndefined();
		available[gate] = false;
		const result = enter(id);
		expect(result).toBeInstanceOf(Redirect);
		expect((result as Redirect).to).toBe(Routes.FEED);
		available[gate] = true;
	});
});

// Micup: /users/<id> is the full profile page beside the DM list, under the guild
// rail, behind the same login guard as every app page.
describe('the user profile route', () => {
	const routes = appRouteTree.build();
	const byId = (id: string) => routes.find((route) => route.id === id);

	it('renders the page for the id in the path under the guilds layout', () => {
		const route = byId('userProfile');
		expect(route?.path).toBe(Routes.USER_PROFILE);
		expect(route?.parentId).toBe('guildsLayout');
		const Component = route!.component as unknown as () => ReactElement<{children: ReactElement<{userId: string}>}>;
		const page = Component().props.children;
		expect((page.type as {displayName?: string}).displayName).toBe('UserProfilePage');
		expect(page.props.userId).toBe('42');
	});

	it('keeps the login guard of the app layout', () => {
		vi.stubGlobal('window', {location: {pathname: '/users/42', search: ''}});
		expect(byId('guildsLayout')?.parentId).toBe('appLayout');
		const result = byId('appLayout')?.onEnter?.({url: new URL('https://micup.gg/users/42')} as RouteContext);
		expect(result).toBeInstanceOf(Redirect);
		expect((result as Redirect).to).toBe(Routes.LOGIN);
		vi.unstubAllGlobals();
	});
});

// Micup: Payriff sends the buyer back to this page in whatever browser paid, often one that is not signed in.
describe('the premium callback route', () => {
	it('opens the payment return without a session', () => {
		vi.stubGlobal('window', {location: {pathname: Routes.PREMIUM_CALLBACK, search: '?status=success'}});
		try {
			const route = premiumCallbackRoute.build().find((route) => route.id === 'premiumCallback');
			expect(route?.path).toBe(Routes.PREMIUM_CALLBACK);
			expect(
				route?.onEnter?.({url: new URL(`https://micup.gg${Routes.PREMIUM_CALLBACK}?status=success`)} as RouteContext),
			).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
