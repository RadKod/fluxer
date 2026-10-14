// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({isAvailable: true, shouldAsk: false}));
const commands = vi.hoisted(() => ({resetChoice: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/analytics/state/AnalyticsConsent', () => ({default: state}));
vi.mock('@app/features/analytics/commands/AnalyticsCommands', () => commands);

const {AnalyticsPreferencesLink} = await import('@app/features/analytics/components/AnalyticsPreferencesLink');

let container: HTMLDivElement;
let root: Root;

function render(): void {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement('div');
	root = createRoot(container);
	act(() => root.render(createElement(AnalyticsPreferencesLink)));
}

beforeEach(() => {
	state.isAvailable = true;
	state.shouldAsk = false;
	vi.clearAllMocks();
});

afterEach(() => {
	act(() => root.unmount());
});

describe('AnalyticsPreferencesLink', () => {
	it('lets a signed-out visitor reopen the choice they made', () => {
		render();
		const button = container.querySelector('button');
		expect(button?.textContent).toBe('Cookie preferences');
		expect(button?.getAttribute('type')).toBe('button');
		act(() => button?.click());
		expect(commands.resetChoice).toHaveBeenCalledTimes(1);
	});

	it('is absent without analytics and while the banner is already asking', () => {
		state.isAvailable = false;
		render();
		expect(container.innerHTML).toBe('');
		act(() => root.unmount());
		state.isAvailable = true;
		state.shouldAsk = true;
		render();
		expect(container.innerHTML).toBe('');
	});
});
