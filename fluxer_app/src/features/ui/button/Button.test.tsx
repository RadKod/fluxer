// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));

const {Button} = await import('@app/features/ui/button/Button');
const {default: styles} = await import('@app/features/ui/button/Button.module.css');

let container: HTMLDivElement;
let root: Root;

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

function render(props: Parameters<typeof Button>[0]) {
	act(() => root.render(createElement(Button, props)));
	return container.querySelector('button')!;
}

const spinnerParts = () => container.querySelectorAll(`.${styles.spinnerWrapper}, .${styles.spinnerItem}`);

describe('Button spinner', () => {
	it('draws no spinner or animated dots while idle, for text, icon and every size variant', () => {
		render({children: 'Save'});
		expect(spinnerParts()).toHaveLength(0);
		render({children: 'Save', variant: 'danger', small: true});
		expect(spinnerParts()).toHaveLength(0);
		render({square: true, icon: createElement('svg'), 'aria-label': 'Close', superCompact: true});
		expect(spinnerParts()).toHaveLength(0);
	});

	it('shows the spinner over the hidden label while submitting, keeping the label as the accessible text', () => {
		const button = render({children: 'Save', submitting: true});
		expect(container.querySelector(`.${styles.spinnerWrapper}`)).not.toBeNull();
		expect(container.querySelectorAll(`.${styles.spinnerItem}`)).toHaveLength(3);
		expect(container.querySelector(`.${styles.iconWrapper}`)!.classList).toContain(styles.hidden);
		expect(button.textContent).toBe('Save');
		expect(button.disabled).toBe(false);
	});

	it('mounts and removes the spinner cleanly across idle, submitting and idle again', () => {
		const button = render({children: 'Save'});
		expect(spinnerParts()).toHaveLength(0);
		expect(render({children: 'Save', submitting: true})).toBe(button);
		expect(container.querySelectorAll(`.${styles.spinnerItem}`)).toHaveLength(3);
		expect(render({children: 'Save', submitting: false})).toBe(button);
		expect(spinnerParts()).toHaveLength(0);
		expect(container.querySelector(`.${styles.iconWrapper}`)!.classList).not.toContain(styles.hidden);
		expect(button.textContent).toBe('Save');
	});
});
