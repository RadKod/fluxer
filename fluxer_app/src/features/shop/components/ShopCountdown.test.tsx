// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const clock = vi.hoisted(() => ({serverAheadMs: 0}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: {now: () => Date.now() + clock.serverAheadMs}}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedDateTime: (value: string) => `on ${value}`}));

const NOW = Date.parse('2026-09-28T20:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

vi.useFakeTimers({now: NOW});
const {ShopCountdown} = await import('@app/features/shop/components/ShopCountdown');
const {default: styles} = await import('@app/features/shop/components/ShopCountdown.module.css');

describe('ShopCountdown', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.setSystemTime(NOW);
		clock.serverAheadMs = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (endsAt: number) =>
		act(() => root.render(createElement(ShopCountdown, {endsAt: new Date(endsAt).toISOString(), size: 'card'})));
	const time = () => container.querySelector('time');
	// Moves the clock to the given time left and lets the shared tick fire once.
	const leaveOnly = (end: number, left: number) =>
		act(() => {
			vi.setSystemTime(end - left - 1000);
			vi.advanceTimersByTime(1000);
		});

	it('counts down 2d 4h → 3h 12m → 12m → less than a minute; under 24 h turns warning', () => {
		const end = NOW + 2 * DAY + 4 * HOUR + 30 * MINUTE;
		render(end);
		expect(time()?.textContent).toBe('2d 4h left');
		expect(time()?.getAttribute('dateTime')).toBe(new Date(end).toISOString());
		expect(time()?.getAttribute('aria-label')).toBe(`Sale ends on ${new Date(end).toISOString()}`);
		expect(time()?.classList.contains(styles.warning)).toBe(false);

		leaveOnly(end, 3 * HOUR + 12 * MINUTE + 30_000);
		expect(time()?.textContent).toBe('3h 12m left');
		expect(time()?.classList.contains(styles.warning)).toBe(true);

		leaveOnly(end, 12 * MINUTE + 30_000);
		expect(time()?.textContent).toBe('12m left');

		leaveOnly(end, 30_000);
		expect(time()?.textContent).toBe('Less than a minute left');

		leaveOnly(end, -MINUTE);
		expect(time()).toBeNull();
	});

	it('takes a className on its root, beside its own', () => {
		act(() =>
			root.render(
				createElement(ShopCountdown, {endsAt: new Date(NOW + DAY).toISOString(), size: 'card', className: 'line'}),
			),
		);
		expect(container.firstElementChild?.classList.contains('line')).toBe(true);
		expect(container.firstElementChild?.classList.contains(styles.countdown)).toBe(true);
	});

	it('counts on the server clock', () => {
		clock.serverAheadMs = HOUR;
		render(NOW + 3 * HOUR);
		expect(time()?.textContent).toBe('2h 0m left');
	});
});
