// SPDX-License-Identifier: AGPL-3.0-or-later

import {observeResize} from '@app/features/platform/utils/SharedResizeObserver';
import {type CSSProperties, type RefObject, useCallback, useLayoutEffect, useState} from 'react';

type BadgeStyle = CSSProperties & {'--profile-badge-height'?: string};

export function useProfileBadgeMetrics(nameRef: RefObject<HTMLElement | null>, displayName: string) {
	const [height, setHeight] = useState<number>();
	const [name, setName] = useState<HTMLElement | null>(null);
	const bindNameRef = useCallback(
		(node: HTMLElement | null) => {
			nameRef.current = node;
			setName(node);
		},
		[nameRef],
	);
	useLayoutEffect(() => {
		const ownerWindow = name?.ownerDocument.defaultView;
		if (!name || !ownerWindow) return;
		const context = name.ownerDocument.createElement('canvas').getContext('2d');
		let disposed = false;
		const measure = () => {
			if (disposed) return;
			const font = ownerWindow.getComputedStyle(name);
			let inkHeight = Number.parseFloat(font.fontSize) * 0.75;
			if (context) {
				context.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
				let visibleName = displayName;
				if (font.textOverflow === 'ellipsis' && font.whiteSpace === 'nowrap' && name.scrollWidth > name.clientWidth) {
					const availableWidth =
						name.clientWidth - Number.parseFloat(font.paddingLeft || '0') - Number.parseFloat(font.paddingRight || '0');
					visibleName = '';
					const segments =
						typeof Intl.Segmenter === 'function'
							? Array.from(
									new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(displayName),
									({segment}) => segment,
								)
							: Array.from(displayName);
					for (const segment of segments) {
						if (context.measureText(`${visibleName}${segment}…`).width > availableWidth) break;
						visibleName += segment;
					}
					visibleName += '…';
				}
				const metrics = context.measureText(visibleName);
				const measuredHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
				if (measuredHeight > 0) inkHeight = measuredHeight;
			}
			if (inkHeight > 0) setHeight(inkHeight * 0.8);
		};
		measure();
		const unobserve = typeof ResizeObserver !== 'undefined' ? observeResize(name, measure) : undefined;
		const fonts = name.ownerDocument.fonts;
		fonts?.ready?.then(measure);
		fonts?.addEventListener?.('loadingdone', measure);
		return () => {
			disposed = true;
			unobserve?.();
			fonts?.removeEventListener?.('loadingdone', measure);
		};
	}, [displayName, name]);
	const badgeStyle: BadgeStyle = height === undefined ? {} : {'--profile-badge-height': `${height}px`};
	return {badgeStyle, bindNameRef};
}
