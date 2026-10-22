// SPDX-License-Identifier: AGPL-3.0-or-later

import {type RefObject, useEffect, useState} from 'react';

// The element's content box, updated as it resizes; zero until the first measure.
export function useElementSize(ref: RefObject<HTMLElement | null>): {width: number; height: number} {
	const [size, setSize] = useState({width: 0, height: 0});
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			const {width, height} = entry.contentRect;
			setSize((previous) => (previous.width === width && previous.height === height ? previous : {width, height}));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}
