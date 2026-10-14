// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// happy-dom has no layout and never clamps scrollTop, so the stylesheets are read (like FeedPostCardCss.test.ts).
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
// The declarations of the rule whose whole selector is `selector`, at the top level.
const rule = (css: string, selector: string) =>
	css.match(new RegExp(`(?:^|\\n)\\${selector} \\{([^}]*)\\}`))?.[1] ?? '';

describe('feed timeline list layout', () => {
	// The Scroller lays its content out as a flex column the height of the view. A shrinking rows box is only as tall as
	// the view, so the scroll range ends at the last mounted post: a list mounted again (back from a server) has none
	// mounted when it restores its place, the browser clamps the restored offset to 0 and the posts are drawn below it.
	it('keeps the rows at the full height of the list inside the Scroller', () => {
		expect(rule(read('../../ui/components/Scroller.module.css'), '.scrollerChildren')).toMatch(
			/display: flex;[\s\S]*flex-direction: column;/,
		);
		expect(rule(read('./FeedTimelineList.module.css'), '.rows')).toContain('flex-shrink: 0;');
	});
});
