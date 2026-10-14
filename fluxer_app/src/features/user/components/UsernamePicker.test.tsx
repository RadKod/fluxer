// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const check = vi.hoisted(() => vi.fn());
vi.mock('@app/features/user/commands/UsernameCommands', () => ({checkUsernameAvailability: check}));
vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: unknown) => (Array.isArray(descriptor) ? {message: descriptor.join('')} : descriptor),
}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label, error, leftElement, ...props}: {label: string; error?: string; leftElement?: React.ReactNode}) =>
		createElement('label', {}, label, leftElement, createElement('input', props), error),
}));

import {UsernamePicker} from './UsernamePicker';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
describe('shared username picker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		check.mockReset().mockResolvedValue({taken: false});
		container = document.createElement('div');
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
	});
	async function mount(value: string) {
		await act(async () => root.render(createElement(UsernamePicker, {value, onChange: vi.fn()})));
		await act(async () => vi.advanceTimersByTimeAsync(350));
	}
	test.each([
		[{taken: false}, 'This name is available ✓'],
		[{taken: true, reason: 'TAKEN'}, 'This name is taken.'],
		[{taken: true, reason: 'TIER_FOR_SALE'}, 'This name can be purchased.'],
		[{taken: true, reason: 'REQUIRES_ENTITLEMENT'}, 'This name can be purchased.'],
		[{taken: true, reason: 'RESERVED'}, 'This name cannot be used.'],
	])('maps the server decision to a distinct notice', async (response, notice) => {
		check.mockResolvedValue(response);
		await mount('alice');
		expect(container.querySelector('input')?.getAttribute('autocomplete')).toBe('username');
		expect(container.textContent).toContain(notice);
	});
	test('shows the release date without exposing an owner', async () => {
		check.mockResolvedValue({taken: true, reason: 'RELEASE_EMBARGO', available_at: '2026-10-23T00:00:00Z'});
		await mount('alice');
		expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-23T00:00:00Z');
	});
	test('shows a fixed @ prefix without duplicating a pasted @', async () => {
		await mount('@alice');
		expect(container.querySelector('input')?.value).toBe('alice');
		expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('@');
	});
});
