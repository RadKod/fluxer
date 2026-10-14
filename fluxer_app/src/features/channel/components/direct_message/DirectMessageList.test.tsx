// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	pathname: '/channels/@me',
	mobile: false,
	premium: true,
	premiumPage: true,
	shop: true,
}));
const premiumModalCommands = vi.hoisted(() => ({open: vi.fn()}));
const routerUtils = vi.hoisted(() => ({transitionTo: vi.fn()}));

const passThrough = ({children}: {children?: React.ReactNode}) => children ?? null;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en'}}),
	Trans: passThrough,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {isSelfHosted: () => true}}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: state.pathname}),
}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => premiumModalCommands);
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	getPremiumProductName: () => 'sanalyer Plus',
	shouldShowPremiumFeatures: () => state.premium,
	isPremiumPageAvailable: () => state.premiumPage,
}));
vi.mock('@app/features/shop/utils/ShopAvailability', () => ({isShopPageAvailable: () => state.shop}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => state.mobile}}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_NAME: 'sanalyer Plus'}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({
	PERSONAL_NOTES_DESCRIPTOR: {message: 'Personal notes'},
}));
vi.mock('@app/features/shop/utils/ShopMessageDescriptors', () => ({SHOP_DESCRIPTOR: {message: 'Shop'}}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/app/components/LongPressable', () => ({
	LongPressable: ({children, onClick}: {children: React.ReactNode; onClick?: () => void}) =>
		createElement('div', {role: 'button', onClick}, children),
}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({reportSkeletonDMSidebarLayout: vi.fn()}));
vi.mock('@app/features/app/hooks/useMergeRefs', () => ({useMergeRefs: () => () => {}}));
vi.mock('@app/features/app/hooks/useRovingFocusList', () => ({useRovingFocusList: () => () => {}}));
vi.mock('@app/features/app/hooks/useSkeletonLayoutMemoryCapture', () => ({useSkeletonLayoutReport: () => {}}));
vi.mock('@app/features/channel/components/alerts/PersonalNotesPurgeFailedModal', () => ({
	PersonalNotesPurgeFailedModal: () => null,
}));
vi.mock('@app/features/channel/components/bottomsheets/CreateDMBottomSheet', () => ({CreateDMBottomSheet: () => null}));
vi.mock('@app/features/channel/components/direct_message/DMListItem', () => ({DMListItem: () => null}));
vi.mock('@app/features/channel/components/direct_message/DMListHelpers', () => ({getDmRouteChannelId: () => null}));
vi.mock('@app/features/channel/components/modals/CreateDMModal', () => ({CreateDMModal: () => null}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {dmChannels: []}}));
vi.mock('@app/features/channel/utils/CreateDMModalUtils', () => ({
	getCreateDmRestriction: () => null,
	getCreateDMRestrictionMessage: () => '',
}));
vi.mock('@app/features/messaging/commands/MessageCommands', () => ({purgePersonalNotes: vi.fn()}));
vi.mock('@app/features/messaging/utils/DmChannelUtils', () => ({getSortedDmChannels: () => []}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectChannel: vi.fn()}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({
	default: {selectedChannelIds: new Map(), recentChannelVisits: []},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));
vi.mock('@app/features/relationship/components/modals/AddFriendSheet', () => ({AddFriendSheet: () => null}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {getRelationships: () => []}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {show: vi.fn()}}));
vi.mock('@app/features/ui/action_menu/ContextMenuIcons', () => ({DeleteIcon: () => null}));
vi.mock('@app/features/ui/action_menu/PersonalNotesContextMenu', () => ({PersonalNotesContextMenu: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/commands/LayoutCommands', () => ({updateMobileLayoutState: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/components/MentionBadge', () => ({MentionBadge: () => null}));
vi.mock('@app/features/ui/components/Scroller', () => ({Scroller: passThrough}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/keybind_hint/KeybindHint', () => ({KeybindHint: () => null, TooltipWithKeybind: () => null}));
vi.mock('@app/features/ui/menu_bottom_sheet/MenuBottomSheet', () => ({MenuBottomSheet: () => null}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/user/commands/UserCommands', () => ({preloadDMMessages: vi.fn(async () => {})}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: '1'}}}));

const {DMList} = await import('@app/features/channel/components/direct_message/DirectMessageList');
const {default: pageItemStyles} = await import(
	'@app/features/channel/components/direct_message/DMListPageItems.module.css'
);

describe('DMList quick links', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {pathname: '/channels/@me', mobile: false, premium: true, premiumPage: true, shop: true});
		premiumModalCommands.open.mockClear();
		routerUtils.transitionTo.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// A new key per render: the list is a memoised observer and the fakes above are not observable.
	let renders = 0;
	const render = () => act(() => root.render(createElement(DMList, {key: ++renders})));
	const rows = () =>
		[...container.querySelectorAll('button, [role="button"]')]
			.map((row) => row.textContent ?? '')
			.filter((text) => ['Friends', 'Personal notes', 'sanalyer Plus', 'Bot System', 'Shop'].includes(text));
	const row = (label: string) =>
		[...container.querySelectorAll<HTMLElement>('button, [role="button"]')].find((el) => el.textContent === label);

	it('lists the shop right under premium, Bot System after them', () => {
		render();
		expect(rows()).toEqual(['Friends', 'Personal notes', 'sanalyer Plus', 'Shop', 'Bot System']);
	});

	// The same rows as the feed sidebar (DMListPageItems): premium and the shop carry the accent.
	it('draws premium and the shop with the accent, Bot System without it', () => {
		render();
		expect(row('sanalyer Plus')?.classList).toContain(pageItemStyles.accent);
		expect(row('Shop')?.classList).toContain(pageItemStyles.accent);
		expect(row('Bot System')?.classList).not.toContain(pageItemStyles.accent);
		expect(row('Friends')?.classList).not.toContain(pageItemStyles.accent);
	});

	it('hides the shop row where the shop does not run', () => {
		state.shop = false;
		render();
		expect(rows()).toEqual(['Friends', 'Personal notes', 'sanalyer Plus', 'Bot System']);
	});

	it('the shop row goes to the shop page and is selected there', () => {
		render();
		expect(row('Shop')?.getAttribute('aria-current')).toBeNull();
		act(() => row('Shop')?.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');

		state.pathname = '/shop';
		render();
		expect(row('Shop')?.getAttribute('aria-current')).toBe('page');
		expect(row('Friends')?.getAttribute('aria-current')).toBeNull();
	});

	it('the premium row opens premium and is selected on the premium page', () => {
		render();
		act(() => row('sanalyer Plus')?.click());
		expect(premiumModalCommands.open).toHaveBeenCalledTimes(1);
		expect(row('sanalyer Plus')?.getAttribute('aria-current')).toBeNull();

		state.pathname = '/premium';
		render();
		expect(row('sanalyer Plus')?.getAttribute('aria-current')).toBe('page');
	});

	it('on mobile, premium and the shop sit together under personal notes where they are pages', () => {
		state.mobile = true;
		render();
		expect(rows()).toEqual(['Personal notes', 'sanalyer Plus', 'Shop', 'Bot System']);
		act(() => row('Shop')?.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');

		state.premiumPage = false;
		state.shop = false;
		render();
		expect(rows()).toEqual(['Personal notes', 'Bot System']);
	});

	it('on mobile, draws premium and the shop with the desktop accent, Bot System without it', () => {
		state.mobile = true;
		render();
		for (const label of ['sanalyer Plus', 'Shop']) {
			expect(row(label)?.classList).toContain(pageItemStyles.accent);
			expect(row(label)?.querySelector(`.${pageItemStyles.accentIcon}`)).not.toBeNull();
			expect(row(label)?.querySelector(`.${pageItemStyles.accentLabel}`)?.textContent).toBe(label);
		}
		expect(row('Bot System')?.classList).not.toContain(pageItemStyles.accent);
		expect(row('Personal notes')?.classList).not.toContain(pageItemStyles.accent);
	});

	it.each([false, true])('opens and selects Bot System with mobile=%s even without the shop', (mobile) => {
		state.mobile = mobile;
		state.shop = false;
		render();
		expect(row('Bot System')).toBeDefined();
		expect(row('Bot System')?.getAttribute('aria-current')).toBeNull();
		act(() => row('Bot System')?.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/bots');
		state.pathname = '/bots';
		render();
		expect(row('Bot System')?.getAttribute('aria-current')).toBe('page');
		if (!mobile) expect(row('Friends')?.getAttribute('aria-current')).toBeNull();
	});
});
