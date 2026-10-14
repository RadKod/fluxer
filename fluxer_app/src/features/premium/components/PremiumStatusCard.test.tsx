// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {getFormattedLongDate} from '@fluxer/date_utils/src/DateFormatting';
import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	premiumType: number | null;
	premiumUntil: Date | null;
	premiumLifetimeSequence: number | null;
	isPremium: () => boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const users = vi.hoisted(() => ({currentUser: null as FakeUser | null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick?: () => void}) => (
		<button type="button" onClick={onClick} data-flx="premium.premium-status-card-test.button.click">
			{children}
		</button>
	),
}));

const {PremiumStatusCard} = await import('@app/features/premium/components/PremiumStatusCard');

function user(overrides: Partial<FakeUser>): FakeUser {
	return {
		premiumType: UserPremiumTypes.SUBSCRIPTION,
		premiumUntil: null,
		premiumLifetimeSequence: null,
		isPremium: () => true,
		...overrides,
	};
}

describe('PremiumStatusCard', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const addTimeHandler = vi.fn();

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
		addTimeHandler.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	const render = (onAddTime: (() => void) | null) =>
		act(() => root.render(createElement(PremiumStatusCard, {onAddTime})));
	const addTime = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add time');

	it('shows the end date and days left from premiumUntil; Süre ekle opens the plans', () => {
		const until = new Date(Date.now() + 26 * DAY_MS);
		users.currentUser = user({premiumUntil: until});
		render(addTimeHandler);

		expect(container.textContent).toContain('Micup Plus is active');
		expect(container.textContent).toContain(`Until ${getFormattedLongDate(until, 'en')}, 26 days left`);

		act(() => addTime()!.click());
		expect(addTimeHandler).toHaveBeenCalledTimes(1);
	});

	it('counts a part-day as a day left', () => {
		users.currentUser = user({premiumUntil: new Date(Date.now() + DAY_MS / 2)});
		render(addTimeHandler);

		expect(container.textContent).toContain(', 1 day left');
	});

	it('offers no Süre ekle when there are no packages to buy', () => {
		users.currentUser = user({premiumUntil: new Date(Date.now() + DAY_MS)});
		render(null);

		expect(container.textContent).toContain('Micup Plus is active');
		expect(addTime()).toBeUndefined();
	});

	it('a Visionary sees the lifetime status with the number and no Süre ekle', () => {
		users.currentUser = user({premiumType: UserPremiumTypes.LIFETIME, premiumLifetimeSequence: 7});
		render(addTimeHandler);

		expect(container.textContent).toContain('Visionary #7 · Lifetime');
		expect(addTime()).toBeUndefined();
	});

	it('a lifetime account without a number shows Lifetime', () => {
		users.currentUser = user({premiumType: UserPremiumTypes.LIFETIME});
		render(addTimeHandler);

		expect(container.textContent).toContain('Lifetime');
		expect(container.textContent).not.toContain('Visionary');
	});

	it('shows nothing to an account without premium', () => {
		users.currentUser = user({premiumType: 0, isPremium: () => false});
		render(addTimeHandler);

		expect(container.innerHTML).toBe('');
	});
});
