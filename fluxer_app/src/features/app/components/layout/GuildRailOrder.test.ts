// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the feed button leads the guild rail (upstream puts it after the guilds). GuildsLayout.tsx pulls in most of the
// app, so the row builder's source is read: the order of the rows it pushes is the rail order.
const SOURCE = readFileSync(fileURLToPath(new URL('./GuildsLayout.tsx', import.meta.url)), 'utf8');

function builderKinds(): Array<string> {
	const start = SOURCE.indexOf('function createGuildNavigationRows(');
	const end = SOURCE.indexOf('\treturn rows;\n}', start);
	return [...SOURCE.slice(start, end).matchAll(/kind: '([a-z-]+)'/g)].map((match) => match[1] ?? '');
}

describe('guild rail order', () => {
	it('puts the feed button first, then home, favorites, DMs and the divider', () => {
		expect(builderKinds()).toEqual([
			'feed',
			'fluxer',
			'favorites',
			'dm',
			'divider',
			'outage',
			'organized-item',
			'bottom-drop-zone',
			'discovery',
			'add-guild',
			'download',
			'help',
		]);
	});

	it('shows the feed button while the rail switch is on, keeping the feed limit check', () => {
		expect(SOURCE).toContain('const FEED_RAIL_BUTTON_ENABLED = true;');
		expect(SOURCE).toContain(
			"const feedVisible = FEED_RAIL_BUTTON_ENABLED && LimitResolver.resolve({key: 'feature_feed', fallback: 0}) > 0;",
		);
	});

	// The feed's own pages (/feed/posts/…, /feed/premium…) keep the feed button selected too.
	it('keeps the gap after the feed button and its selected state on the feed routes', () => {
		expect(SOURCE).toMatch(/case 'fluxer':\s*case 'feed':[^}]*return true;/);
		expect(SOURCE).toContain("if (visibility.feedVisible && Routes.isFeedRoute(pathname)) return 'feed';");
	});
});
