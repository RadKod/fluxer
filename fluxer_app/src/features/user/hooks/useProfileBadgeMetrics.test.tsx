// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {observeResize} from '@app/features/platform/utils/SharedResizeObserver';
import {useProfileBadgeMetrics} from '@app/features/user/hooks/useProfileBadgeMetrics';
import {act, createElement, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/SharedResizeObserver', () => ({observeResize: vi.fn(() => vi.fn())}));
beforeEach(() => vi.clearAllMocks());

it('uses the actual name ink and remeasures when its font finishes loading', async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	let inkHeight = 15;
	const measureText = vi.fn(() => ({actualBoundingBoxAscent: inkHeight - 3, actualBoundingBoxDescent: 3}));
	const context = {measureText, font: ''};
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
		context as unknown as ReturnType<HTMLCanvasElement['getContext']>,
	);
	const fonts = new EventTarget();
	Object.defineProperty(document, 'fonts', {configurable: true, value: fonts});
	function Name() {
		const nameRef = useRef<HTMLSpanElement>(null);
		const {badgeStyle: style, bindNameRef} = useProfileBadgeMetrics(nameRef, 'Çağrı');
		return createElement(
			'div',
			{style},
			createElement('span', {ref: bindNameRef, style: {fontSize: '24px', fontWeight: 600}}, 'Çağrı'),
		);
	}
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	try {
		act(() => root.render(createElement(Name)));
		expect(container.firstElementChild?.getAttribute('style')).toContain('--profile-badge-height: 12px');
		expect(measureText).toHaveBeenCalledWith('Çağrı');
		expect(context.font).toContain('24px');
		inkHeight = 20;
		act(() => fonts.dispatchEvent(new Event('loadingdone')));
		expect(container.firstElementChild?.getAttribute('style')).toContain('--profile-badge-height: 16px');
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	}
});

it.each(['loaded', 'replaced'] as const)(
	'measures and observes the actual node when it is %s with the same name',
	(mode) => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		let inkHeight = 15;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			measureText: () => ({actualBoundingBoxAscent: inkHeight, actualBoundingBoxDescent: 0}),
		} as unknown as ReturnType<HTMLCanvasElement['getContext']>);
		function Name({shown, kind}: {shown: boolean; kind: 'span' | 'strong'}) {
			const nameRef = useRef<HTMLElement>(null);
			const {badgeStyle: style, bindNameRef} = useProfileBadgeMetrics(nameRef, 'Akdo');
			return createElement(
				'div',
				{style},
				shown ? createElement(kind, {ref: bindNameRef, style: {fontSize: '24px'}}, 'Akdo') : null,
			);
		}
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		try {
			act(() => root.render(createElement(Name, {shown: mode === 'replaced', kind: 'span'})));
			const oldNode = container.querySelector('span');
			const oldCleanup = vi.mocked(observeResize).mock.results.at(-1)?.value;
			inkHeight = 20;
			act(() => root.render(createElement(Name, {shown: true, kind: 'strong'})));
			expect(container.firstElementChild?.getAttribute('style')).toContain('--profile-badge-height: 16px');
			expect(observeResize).toHaveBeenLastCalledWith(container.querySelector('strong'), expect.any(Function));
			if (oldNode) expect(oldCleanup).toHaveBeenCalledOnce();
		} finally {
			act(() => root.unmount());
			container.remove();
			vi.restoreAllMocks();
		}
	},
);

it.each([true, false])('excludes the hidden emoji suffix when the name is clipped, Segmenter=%s', (hasSegmenter) => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
	if (!hasSegmenter) Object.defineProperty(Intl, 'Segmenter', {configurable: true, value: undefined});
	const displayName = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM😀';
	const measureText = vi.fn((text: string) => ({
		width: [...text].length * 10,
		actualBoundingBoxAscent: text.includes('😀') ? 18 : 13,
		actualBoundingBoxDescent: 0,
	}));
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({measureText} as unknown as ReturnType<
		HTMLCanvasElement['getContext']
	>);
	const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
	const scroll = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(310);
	function Name() {
		const nameRef = useRef<HTMLSpanElement>(null);
		const {badgeStyle: style, bindNameRef} = useProfileBadgeMetrics(nameRef, displayName);
		return createElement(
			'div',
			{style},
			createElement(
				'span',
				{
					ref: bindNameRef,
					style: {fontSize: '17px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
				},
				displayName,
			),
		);
	}
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	try {
		act(() => root.render(createElement(Name)));
		expect(container.firstElementChild?.getAttribute('style')).toContain('--profile-badge-height: 10.4px');
		expect(measureText).toHaveBeenCalledWith('MMMMMMMMM…');
	} finally {
		act(() => root.unmount());
		container.remove();
		if (segmenterDescriptor) Object.defineProperty(Intl, 'Segmenter', segmenterDescriptor);
		width.mockRestore();
		scroll.mockRestore();
		vi.restoreAllMocks();
	}
});
