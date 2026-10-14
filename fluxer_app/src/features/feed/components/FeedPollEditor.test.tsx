// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedPollDraft} from '@app/features/feed/components/FeedPollEditor';
import {act, createElement, type ReactNode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1}}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		onClick,
		disabled,
		className,
	}: {
		children: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		className?: string;
	}) => createElement('button', {type: 'button', onClick, disabled, className}, children),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: (props: Record<string, unknown>) => createElement('input', props),
}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		value,
		options,
		onChange,
		label,
	}: {
		value: number;
		options: ReadonlyArray<{value: number; label: string}>;
		onChange: (value: number) => void;
		label: string;
	}) =>
		createElement(
			'select',
			{
				'aria-label': label,
				value,
				onChange: (event: {target: {value: string}}) => onChange(Number(event.target.value)),
			},
			options.map((option) => createElement('option', {key: option.value, value: option.value}, option.label)),
		),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));

const {EMPTY_FEED_POLL, FeedPollEditor} = await import('@app/features/feed/components/FeedPollEditor');
const {default: styles} = await import('@app/features/feed/components/FeedPollEditor.module.css');

describe('FeedPollEditor', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let latest: FeedPollDraft;

	function Harness() {
		const [poll, setPoll] = useState<FeedPollDraft>(EMPTY_FEED_POLL);
		latest = poll;
		return createElement(FeedPollEditor, {...poll, onChange: setPoll});
	}

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

	const optionInputs = () => Array.from(container.querySelectorAll('input'));
	const buttons = (label: string) =>
		Array.from(container.querySelectorAll('button')).filter(
			(button) => button.getAttribute('aria-label') === label || button.textContent === label,
		);
	const click = (element: Element) => act(() => (element as HTMLElement).click());

	it('marks the Add option button for its 44px touch rule', () => {
		act(() => root.render(createElement(Harness)));
		expect(styles.addOption).toBeTruthy();
		expect(buttons('Add option')[0]!.className).toBe(styles.addOption);
	});

	it('starts with two options, adds up to four, removes down to two, caps each at 80 characters, offers 1 h / 1 d / 3 d / 7 d', () => {
		act(() => root.render(createElement(Harness)));
		expect(optionInputs().map((input) => input.getAttribute('aria-label'))).toEqual([
			'Option {number}',
			'Option {number}',
		]);
		expect(buttons('Remove option')).toHaveLength(0);

		click(buttons('Add option')[0]!);
		click(buttons('Add option')[0]!);
		expect(optionInputs()).toHaveLength(4);
		expect(buttons('Add option')).toHaveLength(0);
		expect(optionInputs().every((input) => input.maxLength === 80)).toBe(true);

		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(optionInputs()[3], 'Tea');
			optionInputs()[3]!.dispatchEvent(new Event('input', {bubbles: true}));
		});
		expect(latest.options).toEqual(['', '', '', 'Tea']);

		click(buttons('Remove option')[0]!);
		expect(latest.options).toEqual(['', '', 'Tea']);
		click(buttons('Remove option')[0]!);
		expect(optionInputs()).toHaveLength(2);
		expect(buttons('Remove option')).toHaveLength(0);

		const length = container.querySelector('select[aria-label="Poll length"]') as HTMLSelectElement;
		expect(Array.from(length.options).map((option) => [option.value, option.textContent])).toEqual([
			['1', '1 hour'],
			['24', '1 day'],
			['72', '3 days'],
			['168', '7 days'],
		]);
		expect(length.value).toBe('24');
		act(() => {
			length.value = '168';
			length.dispatchEvent(new Event('change', {bubbles: true}));
		});
		expect(latest.durationHours).toBe(168);
	});
});
