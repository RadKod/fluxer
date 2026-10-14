// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The label comes from the shipped Turkish catalog, so the test fails if the translation drifts.
const TR_CATALOG = readFileSync('src/features/i18n/locales/tr/messages.po', 'utf8');

function translate(descriptor: {message: string}): string {
	const entry = TR_CATALOG.split(/\r?\n\r?\n/).find((block) =>
		block.includes(`msgid ${JSON.stringify(descriptor.message)}`),
	);
	const translated = entry?.match(/^msgstr (".*")\r?$/m);
	return translated ? JSON.parse(translated[1]) : descriptor.message;
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {locale: 'tr', _: translate}})}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));

const {VerifiedUserBadge} = await import('@app/features/user/components/VerifiedUserBadge');
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

describe('VerifiedUserBadge', () => {
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
	});

	const render = (flags: number) =>
		act(() => root.render(createElement(VerifiedUserBadge, {user: userWithFlags(flags)})));

	it('draws the tick with the Turkish label for a verified user', () => {
		render(PublicUserFlags.VERIFIED);

		const badge = container.querySelector('[role="img"]');
		expect(badge?.getAttribute('aria-label')).toBe('Doğrulanmış hesap');
		expect(badge?.querySelector('svg')).not.toBeNull();
	});

	it('puts the caller data-flx on the badge', () => {
		act(() =>
			root.render(
				createElement(VerifiedUserBadge, {
					user: userWithFlags(PublicUserFlags.VERIFIED),
					'data-flx': 'channel.channel-header.verified-user-badge',
				}),
			),
		);

		expect(container.querySelector('[role="img"]')?.getAttribute('data-flx')).toBe(
			'channel.channel-header.verified-user-badge',
		);
	});

	it.each([
		['no flags', 0],
		['other public flags', PublicUserFlags.STAFF | PublicUserFlags.PARTNER | PublicUserFlags.SPAMMER],
	])('draws nothing for a user with %s', (_name, flags) => {
		render(flags);

		expect(container.innerHTML).toBe('');
	});
});
