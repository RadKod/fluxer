// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {NameStyleText} from '@app/features/name_style/components/NameStyleText';
import styles from '@app/features/name_style/components/NameStyleText.module.css';
import {mountCssModule} from '@app/features/name_style/testing/CssModuleSheet';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

describe('NameStyleText underline', () => {
	let sheet: HTMLStyleElement;
	beforeAll(() => {
		sheet = mountCssModule('src/features/name_style/components/NameStyleText.module.css', styles);
	});
	afterAll(() => {
		sheet.remove();
		document.documentElement.className = '';
	});

	function underline(rootClass: string, nameStyle: NameStyle): string {
		document.documentElement.className = rootClass;
		document.body.innerHTML = renderToStaticMarkup(
			createElement(NameStyleText, {nameStyle, style: {color: '#e74c3c'}}, 'Ada'),
		);
		return getComputedStyle(document.body.firstElementChild!).textDecorationColor;
	}

	it.each<[string, NameStyle, string]>([
		['solid', {font_id: 1, colors: [0x8b0000]}, '#8b0000'],
		['gradient', {font_id: 1, colors: [0x8b0000, 0x00008b]}, '#8b0000'],
	])('draws the hover underline of a %s name in its first colour, not the role colour', (_kind, nameStyle, first) => {
		expect(underline('theme-dark', nameStyle)).toBe(first);
		expect(underline('theme-light', nameStyle)).toBe(first);
	});

	it('leaves the underline to the surface where the name keeps its colour', () => {
		const dark: NameStyle = {font_id: 1, colors: [0x8b0000]};
		expect(underline('theme-dark hide-name-styles', dark)).not.toBe('#8b0000');
		const unreadableOnLight: NameStyle = {font_id: 1, colors: [0xffffff, 0xfffff0]};
		expect(underline('theme-light', unreadableOnLight)).not.toBe('#ffffff');
		expect(underline('theme-dark', unreadableOnLight)).toBe('#ffffff');
	});
});
