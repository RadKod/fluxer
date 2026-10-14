// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const runtimeConfig = vi.hoisted(() => ({sourceUrl: null as string | null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtimeConfig}));

const {SourceCodeLink} = await import('@app/features/app/components/dialogs/components/SourceCodeLink');

describe('SourceCodeLink', () => {
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
		runtimeConfig.sourceUrl = null;
	});

	const render = () => act(() => root.render(createElement(SourceCodeLink, {className: 'legal'})));

	it('renders nothing while the instance offers no source URL', () => {
		render();
		expect(container.innerHTML).toBe('');
	});

	it('links to the source URL in a new tab without an opener', () => {
		runtimeConfig.sourceUrl = 'https://micup.test/yasal/kaynak';
		render();
		const link = container.querySelector('a');
		expect(container.childElementCount).toBe(1);
		expect(link?.getAttribute('href')).toBe('https://micup.test/yasal/kaynak');
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
		expect(link?.className).toBe('legal');
		expect(link?.textContent).toBe('Source code');
	});
});
