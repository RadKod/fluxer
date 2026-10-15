// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/react/macro', () => ({Trans: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));

const {UnsavedChangesBannerContent} = await import(
	'@app/features/app/components/dialogs/shared/UnsavedChangesBannerContent'
);

describe('UnsavedChangesBannerContent', () => {
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

	const render = (saveDisabled?: boolean) => {
		const onSave = vi.fn();
		act(() =>
			root.render(
				createElement(UnsavedChangesBannerContent, {
					tabData: {onSave, onReset: vi.fn(), saveDisabled, bannerText: 'Fix the colors to save.'},
					textClassName: 'text',
					actionsClassName: 'actions',
					dataFlx: {text: 't', actions: 'a', resetButton: 'r', saveButton: 's'},
				}),
			),
		);
		const [, save] = container.querySelectorAll('button');
		return {onSave, save};
	};

	it('blocks saving while the tab marks its changes unsavable', () => {
		const {onSave, save} = render(true);

		expect(save.disabled).toBe(true);
		act(() => save.click());
		expect(onSave).not.toHaveBeenCalled();
		expect(container.textContent).toContain('Fix the colors to save.');
	});

	it('saves normally otherwise', () => {
		const {onSave, save} = render();

		act(() => save.click());
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});
