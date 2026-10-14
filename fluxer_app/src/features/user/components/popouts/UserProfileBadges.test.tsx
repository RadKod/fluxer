// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import styles from '@app/features/user/components/popouts/UserProfileBadges.module.css';
import type {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import {PublicUserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Badge titles come from the shipped Turkish catalog, so the test fails if the translation drifts.
const TR_CATALOG = readFileSync('src/features/i18n/locales/tr/messages.po', 'utf8');

function translate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	const entry = TR_CATALOG.split(/\r?\n\r?\n/).find((block) =>
		block.includes(`msgid ${JSON.stringify(descriptor.message)}`),
	);
	const translated = entry?.match(/^msgstr (".*")\r?$/m);
	const text: string = translated ? JSON.parse(translated[1]) : descriptor.message;
	return text.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {locale: 'tr', _: translate}})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => null,
		isSelfHosted: () => true,
		staticCdnEndpoint: 'https://static.micup.gg',
		mediaEndpoint: 'https://media.micup.gg',
	},
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({handleExternalLinkClick: () => {}}));

const {UserProfileBadges} = await import('@app/features/user/components/popouts/UserProfileBadges');

const userWithFlags = (flags: number) => ({flags}) as User;
const profileWith = (fields: Partial<Profile>) => ({badges: null, premiumType: null, ...fields}) as Profile;

describe('UserProfileBadges on sanalyer', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	const render = (user: User, profile: Profile | null) =>
		act(() => root.render(createElement(UserProfileBadges, {user, profile})));
	const images = () => [...container.querySelectorAll('img')];

	it('labels the STAFF flag "sanalyer Ekibi" with the sanalyer icon', () => {
		render(userWithFlags(PublicUserFlags.STAFF), null);

		expect(images().map((img) => img.alt)).toEqual(['sanalyer Ekibi']);
		expect(images()[0].src).toBe('https://static.micup.gg/badges/staff.svg?v=3');
	});

	it('keeps premium hidden when the public flag is absent, even for a premium profile', () => {
		render(
			userWithFlags(PublicUserFlags.STAFF | PublicUserFlags.PARTNER | PublicUserFlags.BUG_HUNTER),
			profileWith({premiumType: UserPremiumTypes.SUBSCRIPTION, premiumSince: new Date('2026-01-01')}),
		);

		expect(images().map((img) => new URL(img.src).pathname)).toEqual([
			'/badges/staff.svg',
			'/badges/bug-hunter.svg',
			'/badges/partner.svg',
		]);
		expect(images().map((img) => img.alt)).toEqual(['sanalyer Ekibi', 'sanalyer Hata Avcısı', 'sanalyer İş Ortağı']);
		expect(container.querySelector('a')).toBeNull();
	});

	it('shows the shipped premium icon with no profile when its public flag is present', () => {
		render(userWithFlags(PublicUserFlags.PREMIUM_BADGE), null);
		expect(images()).toHaveLength(1);
		expect(images()[0].src).toContain('micup-premium-badge.png');
		expect(images()[0].alt).toBe('sanalyer Plus');
	});

	it('keeps every catalog badge between Premium and Bug Hunter in the server order', () => {
		render(
			userWithFlags(
				PublicUserFlags.STAFF | PublicUserFlags.PREMIUM_BADGE | PublicUserFlags.PARTNER | PublicUserFlags.BUG_HUNTER,
			),
			profileWith({
				premiumType: UserPremiumTypes.LIFETIME,
				premiumLifetimeSequence: 42,
				badges: [
					{id: '1300000000000000002', icon: 'aaaa1111', description: 'Catalog first'},
					{id: '1300000000000000001', icon: 'bbbb2222', description: 'Catalog second'},
				],
			}),
		);

		expect(
			[...container.querySelectorAll('img, [data-flx="user.user-profile-badges.sequence-badge"]')].map((badge) =>
				badge instanceof HTMLImageElement ? badge.alt : badge.textContent,
			),
		).toEqual([
			'sanalyer Ekibi',
			'sanalyer Plus',
			'Catalog first',
			'Catalog second',
			'sanalyer Hata Avcısı',
			'sanalyer İş Ortağı',
			'#42',
		]);
	});

	it('applies measured horizontal alpha padding to the three primary flag icons', () => {
		render(userWithFlags(PublicUserFlags.STAFF | PublicUserFlags.PREMIUM_BADGE | PublicUserFlags.BUG_HUNTER), null);
		expect(
			images().map((image) => [
				Number(image.style.getPropertyValue('--badge-optical-inset-left')),
				Number(image.style.getPropertyValue('--badge-optical-inset-right')),
			]),
		).toEqual([
			[19 / 512, 18 / 512],
			[18 / 512, 18 / 512],
			[41 / 512, 40 / 512],
		]);
	});

	it('uses exact shipped alpha bounds only for the 17px profile variant', () => {
		const user = userWithFlags(
			PublicUserFlags.STAFF | PublicUserFlags.PREMIUM_BADGE | PublicUserFlags.PARTNER | PublicUserFlags.BUG_HUNTER,
		);
		const profile = profileWith({badges: [{id: 'arbitrary', icon: 'new', description: 'Catalog badge'}]});
		act(() => root.render(createElement(UserProfileBadges, {user, profile, isModal: true, largeProfile: true})));
		const row = container.querySelector<HTMLDivElement>('[data-flx="user.user-profile-badges.div"]')!;
		expect(row.style.getPropertyValue('--profile-badge-height')).toBe('17px');
		expect(images().map((image) => image.style.getPropertyValue('--badge-optical-scale'))).toEqual([
			'1',
			String(128 / 90),
			'',
			'1',
			'1',
		]);
		expect(images().map((image) => image.style.getPropertyValue('--badge-optical-inset-left'))).toEqual([
			'0',
			String(4 / 128),
			'',
			'0',
			'0',
		]);
		expect(images()[1].style.getPropertyValue('--badge-optical-inset-right')).toBe(String(5 / 128));
		expect(images()[2].crossOrigin).toBe('anonymous');

		act(() => root.render(createElement(UserProfileBadges, {user, profile, isModal: true})));
		expect(row.style.getPropertyValue('--profile-badge-height')).toBe('');
		expect(images().map((image) => image.style.getPropertyValue('--badge-optical-scale'))).toEqual([
			'1.15',
			'1.37',
			'',
			'1.02',
			'1',
		]);
		expect(images()[0].style.getPropertyValue('--badge-optical-inset-left')).toBe(String(19 / 512));
		expect(images()[1].style.getPropertyValue('--badge-optical-inset-left')).toBe(String(18 / 512));
		expect(images()[3].style.getPropertyValue('--badge-optical-inset-left')).toBe(String(41 / 512));
	});

	it.each([false, true])('keeps flag order and one icon size on mobile=%s', (isMobile) => {
		act(() =>
			root.render(
				createElement(UserProfileBadges, {
					user: userWithFlags(PublicUserFlags.STAFF | PublicUserFlags.PREMIUM_BADGE | PublicUserFlags.BUG_HUNTER),
					profile: profileWith({badges: [{id: '1300000000000000002', icon: 'aaaa1111', description: 'Öncü'}]}),
					isModal: true,
					isMobile,
				}),
			),
		);
		expect(images().map((img) => img.alt)).toEqual(['sanalyer Ekibi', 'sanalyer Plus', 'Öncü', 'sanalyer Hata Avcısı']);
		for (const image of images()) expect(image.classList.contains(styles.badge)).toBe(true);
	});

	it('does not duplicate the name crown on nonprofile callers', () => {
		act(() =>
			root.render(
				createElement(UserProfileBadges, {
					user: userWithFlags(PublicUserFlags.PREMIUM_BADGE),
					profile: null,
					showPremium: false,
				}),
			),
		);
		expect(images()).toEqual([]);
	});

	it('keeps the existing flag and catalog order on nonprofile callers', () => {
		act(() =>
			root.render(
				createElement(UserProfileBadges, {
					user: userWithFlags(
						PublicUserFlags.STAFF |
							PublicUserFlags.PREMIUM_BADGE |
							PublicUserFlags.PARTNER |
							PublicUserFlags.BUG_HUNTER,
					),
					profile: profileWith({badges: [{id: 'arbitrary', icon: 'new', description: 'Catalog badge'}]}),
					showPremium: false,
				}),
			),
		);
		expect(images().map((img) => img.alt)).toEqual([
			'sanalyer Ekibi',
			'sanalyer İş Ortağı',
			'sanalyer Hata Avcısı',
			'Catalog badge',
		]);
		for (const image of images()) {
			expect(image.classList.contains(styles.badgeDesktop)).toBe(true);
			expect(image.style.getPropertyValue('--badge-optical-inset-left')).toBe('');
			expect(image.style.getPropertyValue('--badge-optical-inset-right')).toBe('');
		}
	});

	it('restores legacy spacing when switching from a profile caller to a nonprofile caller', () => {
		const user = userWithFlags(PublicUserFlags.STAFF | PublicUserFlags.BUG_HUNTER);
		render(user, null);
		const row = container.querySelector<HTMLDivElement>('[data-flx="user.user-profile-badges.div"]')!;
		expect(row.style.getPropertyValue('--profile-badge-gap')).toBe(
			'calc(var(--profile-badge-height, 0.75rem) * 0.570327553)',
		);

		act(() => root.render(createElement(UserProfileBadges, {user, profile: null, showPremium: false})));
		expect(row.style.getPropertyValue('--profile-badge-gap')).toBe('');
	});

	it('measures catalog alpha bounds without depending on badge identity', () => {
		const pixels = new Uint8ClampedArray(4 * 4 * 4);
		pixels[(1 * 4 + 2) * 4 + 3] = 16;
		pixels[(3 * 4 + 1) * 4 + 3] = 255;
		pixels[3] = 15;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			drawImage: vi.fn(),
			getImageData: () => ({data: pixels}),
		} as unknown as ReturnType<HTMLCanvasElement['getContext']>);
		render(userWithFlags(0), profileWith({badges: [{id: 'arbitrary', icon: 'new', description: 'Any catalog badge'}]}));
		const image = images()[0];
		Object.defineProperties(image, {naturalWidth: {value: 4}, naturalHeight: {value: 4}});
		act(() => image.dispatchEvent(new Event('load')));
		expect(image.crossOrigin).toBe('anonymous');
		expect(Number(image.style.getPropertyValue('--badge-optical-scale'))).toBeCloseTo(4 / 3);
		expect(Number(image.style.getPropertyValue('--badge-optical-inset-left'))).toBe(1 / 4);
		expect(Number(image.style.getPropertyValue('--badge-optical-inset-right'))).toBe(1 / 4);
	});

	it('keeps the Visionary ID text badge for a lifetime account', () => {
		render(
			userWithFlags(0),
			profileWith({
				premiumType: UserPremiumTypes.LIFETIME,
				premiumSince: new Date('2026-01-01'),
				premiumLifetimeSequence: 42,
			}),
		);

		expect(images()).toEqual([]);
		expect(container.querySelector('[data-flx="user.user-profile-badges.sequence-badge"]')?.textContent).toBe('#42');
	});

	it('draws the profile badges after the flag badges, in the order the server sent them, as plain text', () => {
		render(
			userWithFlags(PublicUserFlags.STAFF),
			profileWith({
				badges: [
					{id: '1300000000000000002', icon: 'aaaa1111', description: '<b>Erken</b> destekçi'},
					{id: '1300000000000000001', icon: 'a_bbbb2222', description: 'Moderatör'},
				],
			}),
		);

		expect(images().map((img) => [img.alt, img.getAttribute('src')])).toEqual([
			['sanalyer Ekibi', 'https://static.micup.gg/badges/staff.svg?v=3'],
			['<b>Erken</b> destekçi', 'https://media.micup.gg/branding/badge-1300000000000000002/aaaa1111.webp?size=128'],
			['Moderatör', 'https://media.micup.gg/branding/badge-1300000000000000001/a_bbbb2222.webp?size=128'],
		]);
		expect(container.querySelector('b')).toBeNull();
	});

	it.each([
		['no profile', null],
		['a restricted profile without badges', profileWith({badges: null})],
		['an empty badge list', profileWith({badges: []})],
	])('draws nothing for a user without flags and %s', (_name, profile) => {
		render(userWithFlags(0), profile);

		expect(container.innerHTML).toBe('');
	});
});
