// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
const premium = vi.hoisted(() => ({open: vi.fn(), show: true}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: premium.open}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({shouldShowPremiumFeatures: () => premium.show}));

// The instance branding names the product; Micup's instance says "Micup".
(window as unknown as {__FLUXER_BOOTSTRAP__: unknown}).__FLUXER_BOOTSTRAP__ = {
	instance: {app_public: {branding: {product_name: 'sanalyer'}}},
};

const {PremiumUserBadge} = await import('@app/features/user/components/PremiumUserBadge');
const {User} = await import('@app/features/user/models/User');

const userWithFlags = (flags: number) =>
	new User({
		id: '1',
		username: 'ayse',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags,
	});

describe('PremiumUserBadge', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		premium.open.mockClear();
		premium.show = true;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (flags: number, dataFlx?: string) =>
		act(() => root.render(createElement(PremiumUserBadge, {user: userWithFlags(flags), 'data-flx': dataFlx})));

	const crown = () => container.querySelector('[aria-label="sanalyer Plus"]') as HTMLElement | null;

	it('draws the crown as a button labelled "sanalyer Premium" for a user with PREMIUM_BADGE', () => {
		render(PublicUserFlags.PREMIUM_BADGE);

		const badge = crown();
		expect(badge?.tagName).toBe('BUTTON');
		expect(badge?.getAttribute('type')).toBe('button');
		expect(badge?.getAttribute('data-flx')).toBe('user.premium-user-badge.badge-wrapper');
		const image = badge?.querySelector('img');
		expect(image?.getAttribute('width')).toBe('16');
		expect(image?.getAttribute('alt')).toBe('');
	});

	// the crown opens the Micup Plus page.
	it('opens the premium page once on click', () => {
		render(PublicUserFlags.PREMIUM_BADGE);

		act(() => crown()!.click());

		expect(premium.open).toHaveBeenCalledTimes(1);
	});

	it('keeps the click from the parent, where the name opens the profile popout', () => {
		const parentClick = vi.fn();
		act(() =>
			root.render(
				createElement(
					'div',
					{onClick: parentClick},
					createElement(PremiumUserBadge, {user: userWithFlags(PublicUserFlags.PREMIUM_BADGE)}),
				),
			),
		);

		act(() => crown()!.click());

		expect(premium.open).toHaveBeenCalledTimes(1);
		expect(parentClick).not.toHaveBeenCalled();
	});

	it('takes keyboard focus as a native button, so Enter and Space activate it', () => {
		render(PublicUserFlags.PREMIUM_BADGE);

		const badge = crown()!;
		act(() => badge.focus());

		expect(badge).toBeInstanceOf(HTMLButtonElement);
		expect((badge as HTMLButtonElement).disabled).toBe(false);
		expect(document.activeElement).toBe(badge);
	});

	// inside the member row button and the aria-hidden message header the crown takes no tab stop,
	// yet the mouse still opens the premium page.
	describe('with focusable={false}', () => {
		const renderUnfocusable = () =>
			act(() =>
				root.render(
					createElement(PremiumUserBadge, {user: userWithFlags(PublicUserFlags.PREMIUM_BADGE), focusable: false}),
				),
			);

		it('draws an image, not a button, and stays out of the tab order', () => {
			renderUnfocusable();

			// A span without tabindex is not in the tab order (happy-dom focuses any element, so focus() proves nothing).
			const badge = crown()!;
			expect(container.querySelector('button, a[href], [tabindex]')).toBeNull();
			expect(badge.tagName).toBe('SPAN');
			expect(badge.getAttribute('role')).toBe('img');
			expect(badge.getAttribute('data-flx')).toBe('user.premium-user-badge.badge-wrapper');
		});

		it('opens the premium page once on a mouse click and keeps the click from the parent', () => {
			const parentClick = vi.fn();
			act(() =>
				root.render(
					createElement(
						'div',
						{onClick: parentClick},
						createElement(PremiumUserBadge, {user: userWithFlags(PublicUserFlags.PREMIUM_BADGE), focusable: false}),
					),
				),
			);

			act(() => crown()!.click());

			expect(premium.open).toHaveBeenCalledTimes(1);
			expect(parentClick).not.toHaveBeenCalled();
		});

		it('opens nothing when premium features are hidden', () => {
			premium.show = false;
			renderUnfocusable();

			act(() => crown()!.click());

			expect(premium.open).not.toHaveBeenCalled();
		});
	});

	// in the settings profile previews a click would switch the settings tab past the unsaved-changes check.
	describe('with interactive={false}', () => {
		const renderPicture = (focusable?: boolean) =>
			act(() =>
				root.render(
					createElement(PremiumUserBadge, {
						user: userWithFlags(PublicUserFlags.PREMIUM_BADGE),
						interactive: false,
						focusable,
					}),
				),
			);

		it.each([
			['focusable', undefined],
			['focusable={false}', false],
		])('draws a labelled image outside the tab order that opens nothing (%s)', (_name, focusable) => {
			renderPicture(focusable);

			const badge = crown()!;
			expect(container.querySelector('button, a[href], [tabindex]')).toBeNull();
			expect(badge.tagName).toBe('SPAN');
			expect(badge.getAttribute('role')).toBe('img');
			expect(badge.getAttribute('data-flx')).toBe('user.premium-user-badge.badge-wrapper');
			act(() => badge.click());
			expect(premium.open).not.toHaveBeenCalled();
		});
	});

	it('stays a plain image and opens nothing when premium features are hidden', () => {
		premium.show = false;
		render(PublicUserFlags.PREMIUM_BADGE);

		const badge = crown();
		expect(container.querySelector('button')).toBeNull();
		expect(badge?.getAttribute('role')).toBe('img');
		expect(badge?.getAttribute('data-flx')).toBe('user.premium-user-badge.badge-wrapper');
		act(() => badge!.click());
		expect(premium.open).not.toHaveBeenCalled();
	});

	it.each([
		['no flags', 0],
		['VERIFIED alone', PublicUserFlags.VERIFIED],
	])('renders nothing without the bit (%s)', (_name, flags) => {
		render(flags);

		expect(container.innerHTML).toBe('');
	});

	it('puts the caller data-flx on the badge', () => {
		render(PublicUserFlags.PREMIUM_BADGE, 'channel.member-list-item.premium-user-badge');

		expect(crown()?.getAttribute('data-flx')).toBe('channel.member-list-item.premium-user-badge');
	});

	it('uses the bundled image, never a CDN badge URL', () => {
		render(PublicUserFlags.PREMIUM_BADGE | PublicUserFlags.VERIFIED);

		const src = container.querySelector('img')?.getAttribute('src') ?? '';
		expect(src).toContain('micup-premium-badge');
		expect(src).not.toContain('/badges/');
	});
});
