// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {PlusAppearanceValues} from '@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceForm';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = {_: (descriptor: {message: string}) => descriptor.message};
const userUpdate = vi.fn();
const requestFont = vi.fn();

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null, localInstanceDomain: 'micup.test'},
}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({getPremiumProductName: () => 'Plus'}));
vi.mock('@app/features/user/commands/UserCommands', () => ({update: userUpdate}));
vi.mock('@app/features/name_style/NameStyleFontLoader', () => ({requestNameStyleFont: requestFont}));
vi.mock('@app/features/ui/plutonium_upsell/PlutoniumUpsell', () => ({
	PlutoniumUpsell: ({children}: {children: ReactNode}) => createElement('div', {'data-testid': 'upsell'}, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled, 'data-testid': 'reset'}, children),
}));
vi.mock('@app/features/ui/components/form/ColorPickerField', () => ({
	ColorPickerField: ({
		label,
		value,
		onChange,
		disabled,
	}: {
		label: string;
		value: number;
		onChange: (value: number) => void;
		disabled?: boolean;
	}) =>
		createElement('input', {
			'aria-label': label,
			'data-testid': 'color',
			value: String(value),
			disabled,
			onChange: (event: {target: {value: string}}) => onChange(Number(event.target.value)),
		}),
}));

const {default: styles} = await import(
	'@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceSettings.module.css'
);
const {PlusAppearanceSettings} = await import(
	'@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceSettings'
);

const STYLED: PlusAppearanceValues = {
	name_style: {font_id: 3, colors: [0xffffff]},
	theme_colors: [0x3b1d8f, 0x0f8f8a],
};

describe('PlusAppearanceSettings', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const onNameStyleChange = vi.fn();
	const onThemeColorsChange = vi.fn();

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		vi.clearAllMocks();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (value: PlusAppearanceValues, access = {nameStyle: true, profileTheme: true}) =>
		act(() =>
			root.render(
				createElement(PlusAppearanceSettings, {
					displayName: 'İğdır Şükrü',
					value,
					access,
					onNameStyleChange,
					onThemeColorsChange,
				}),
			),
		);
	const fontOptions = () =>
		Array.from(container.querySelectorAll<HTMLButtonElement>('[data-font-grid] [role="radio"]'));

	it('shows all twelve fonts with the display name and loads each font', () => {
		render(STYLED);

		expect(fontOptions()).toHaveLength(12);
		expect(fontOptions().every((option) => option.textContent?.includes('İğdır Şükrü'))).toBe(true);
		expect(new Set(requestFont.mock.calls.map(([key]) => key)).size).toBe(12);
	});

	it('previews the draft name on the draft profile theme, in the card text colour where its colours do not read', () => {
		const previewName = () =>
			container.querySelector<HTMLElement>('[data-flx="user.my-profile-tab.plus-appearance-settings.preview-name"]');
		render({name_style: {font_id: 3, colors: [0xffffff]}, theme_colors: [0x111827, 0x4b5563]});
		expect(previewName()?.textContent).toBe('İğdır Şükrü');
		expect(previewName()?.dataset.nameStyle).toBe('pacifico');
		expect(previewName()?.style.getPropertyValue('--name-style-1')).toBe('#ffffff');

		render({name_style: {font_id: 3, colors: [0xffffff]}, theme_colors: [0xfbcfe8, 0xc4b5fd]});
		expect(previewName()?.dataset.nameStyle).toBe('pacifico');
		expect(previewName()?.style.getPropertyValue('--name-style-1')).toBe('');
	});

	it('names each font option by its style', () => {
		render(STYLED);

		expect(fontOptions().map((option) => option.textContent?.replace('İğdır Şükrü', ''))).toEqual([
			'Rounded',
			'Playful handwriting',
			'Retro script',
			'Handwriting',
			'Pixel',
			'Arcade pixel',
			'Terminal',
			'Techno',
			'Gothic',
			'Rock',
			'Bold block',
			'Retro modern',
		]);
	});

	it('picking a font updates the draft and sends no request', () => {
		render({name_style: null, theme_colors: null});

		act(() => fontOptions()[5].click());

		expect(onNameStyleChange).toHaveBeenCalledWith({font_id: 6, colors: [0xffffff]});
		expect(userUpdate).not.toHaveBeenCalled();
	});

	it('changing a colour updates the draft and sends no request', () => {
		render(STYLED);
		const [nameColor] = container.querySelectorAll<HTMLInputElement>('[data-testid="color"]');

		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
			setter?.call(nameColor, String(0xeeeeee));
			nameColor.dispatchEvent(new Event('input', {bubbles: true}));
		});

		expect(onNameStyleChange).toHaveBeenCalledWith({font_id: 3, colors: [0xeeeeee]});
		expect(userUpdate).not.toHaveBeenCalled();
	});

	it('warns when the name colours are hard to read', () => {
		render({...STYLED, name_style: {font_id: 3, colors: [0x222222]}});

		expect(container.querySelector('[data-readable="false"]')).not.toBeNull();
	});

	it('marks the font samples whose colours fail 3:1 on the light theme, which then draws them plainly', () => {
		const samples = () =>
			Array.from(container.querySelectorAll('[data-flx="user.my-profile-tab.plus-appearance-settings.font-sample"]'));
		render({...STYLED, name_style: {font_id: 3, colors: [0xffd400, 0xff8a00]}});
		expect(samples()).toHaveLength(12);
		expect(samples().every((sample) => sample.classList.contains(styles.fontSampleDefaultOnLight))).toBe(true);

		render({...STYLED, name_style: {font_id: 3, colors: [0x7b5cff, 0x2563eb]}});
		expect(samples().some((sample) => sample.classList.contains(styles.fontSampleDefaultOnLight))).toBe(false);
	});

	it('locks the controls behind Plus for a free account', () => {
		render({name_style: null, theme_colors: null}, {nameStyle: false, profileTheme: false});

		expect(container.querySelector('[data-testid="upsell"]')).not.toBeNull();
		expect(fontOptions().every((option) => option.disabled)).toBe(true);
		expect(
			Array.from(container.querySelectorAll<HTMLInputElement>('[data-testid="color"]')).every((i) => i.disabled),
		).toBe(true);
	});

	it('reset clears both parts', () => {
		render(STYLED);

		act(() => container.querySelector<HTMLButtonElement>('[data-testid="reset"]')?.click());

		expect(onNameStyleChange).toHaveBeenCalledWith(null);
		expect(onThemeColorsChange).toHaveBeenCalledWith(null);
	});
});
