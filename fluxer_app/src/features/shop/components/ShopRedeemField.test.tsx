// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import type React from 'react';
import {act, createElement, forwardRef} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const giftCommands = vi.hoisted(() => ({openAcceptModal: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useSmoothScrolling: false}}));
vi.mock('@app/features/gift/commands/GiftCommands', () => giftCommands);
vi.mock('@app/features/gift/utils/GiftCodeUtils', () => ({
	findKey: (text: string) => (text.trim().startsWith('KEY') ? text.trim() : null),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		onClick,
		type = 'button',
		disabled,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		type?: 'button' | 'submit';
		disabled?: boolean;
	}) =>
		type === 'submit'
			? createElement('button', {type: 'submit', disabled}, children)
			: createElement('button', {type: 'button', onClick, disabled}, children),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & {error?: string}>(
		({error, ...props}, ref) =>
			createElement('span', null, createElement('input', {...props, ref}), error && createElement('em', null, error)),
	),
}));

const {ShopRedeemField, ShopRedeemJumpButton} = await import('@app/features/shop/components/ShopRedeemField');

describe('ShopRedeemField', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		giftCommands.openAcceptModal.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const input = () => container.querySelector('input')!;
	const type = (value: string) =>
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			setter.call(input(), value);
			input().dispatchEvent(new Event('input', {bubbles: true}));
		});
	const submit = async () => {
		await act(async () => container.querySelector('form')!.requestSubmit());
	};

	it('the card asks for a code with its own heading, a line and a hint, and labels the field for screen readers', () => {
		act(() =>
			root.render(createElement(ShopRedeemField, {variant: 'card', inputId: 'premium-code', labelHidden: true})),
		);

		expect(container.querySelector('h3')?.textContent).toBe('Got a code?');
		expect(container.textContent).toContain('Enter a code that carries Plus time or a decoration.');
		expect(container.textContent).toContain('Each code works once.');
		expect(input().id).toBe('premium-code');
		const label = container.querySelector(`label[for="premium-code"]`);
		expect(label?.textContent).toBe('Redeem a code');
	});

	it('the bar shows its label beside the field', () => {
		act(() => root.render(createElement(ShopRedeemField, {variant: 'bar', inputId: 'shop-code'})));

		expect(container.querySelector('h3')).toBeNull();
		expect(container.querySelector('label[for="shop-code"]')?.textContent).toBe('Redeem a code');
	});

	it('opens what a key gives and refuses other text before any request', async () => {
		act(() => root.render(createElement(ShopRedeemField, {variant: 'card', inputId: 'c'})));

		await type('hello');
		await submit();
		expect(giftCommands.openAcceptModal).not.toHaveBeenCalled();
		expect(container.textContent).toContain('Paste a key code or a gift link from this site.');

		await type('KEY-1234');
		await submit();
		expect(giftCommands.openAcceptModal).toHaveBeenCalledWith('KEY-1234');
	});
});

describe('ShopRedeemJumpButton', () => {
	it('brings the code field into view and puts the cursor in it', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		act(() =>
			root.render(
				createElement(
					'div',
					null,
					createElement(ShopRedeemJumpButton, {inputId: 'jump-code'}),
					createElement(ShopRedeemField, {variant: 'bar', inputId: 'jump-code'}),
				),
			),
		);
		const field = container.querySelector<HTMLInputElement>('#jump-code')!;
		const scrollIntoView = vi.fn();
		field.scrollIntoView = scrollIntoView;

		act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Redeem a code')!.click());

		expect(scrollIntoView).toHaveBeenCalledWith({block: 'center', behavior: 'auto'});
		expect(document.activeElement).toBe(field);
		act(() => root.unmount());
		container.remove();
	});
});
