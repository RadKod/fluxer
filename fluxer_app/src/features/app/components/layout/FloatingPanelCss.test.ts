// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the desktop panels sit flush again, as upstream draws them: no floating cards and one 1px divider between the
// channel list and the content. The floating layout lived only in CSS blocks and two tokens. Only the frame's top-left
// corner, by the channel list, stays round like the former cards (MARKER blocks).
const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MARKER = '/* Micup: rounded frame corner by the channel list */';

function cssFiles(dir: string): Array<string> {
	return readdirSync(dir, {withFileTypes: true, recursive: true})
		.filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
		.map((entry) => `${entry.parentPath}/${entry.name}`);
}

describe('flush desktop panels', () => {
	it('keeps no floating panel rules or tokens', () => {
		const floating = cssFiles(SRC_ROOT).filter((file) =>
			/spec-yuzen-panel|--floating-panel-|html:not\(\.mobile-layout\)/.test(readFileSync(file, 'utf8')),
		);
		expect(floating).toEqual([]);
	});

	it('keeps the upstream frame rules and its 1px divider', () => {
		const read = (file: string) => readFileSync(`${SRC_ROOT}features/app/components/layout/${file}`, 'utf8');
		expect(read('GuildsLayout.module.css')).toMatch(/\.outlineFrame \{\s*--outline-radius: 0px;\s*\}/);
		expect(read('OutlineFrame.module.css')).toMatch(
			/\.frame \{[^}]*border-top-left-radius: var\(--outline-radius, 0px\);/,
		);
		expect(read('OutlineFrame.module.css')).toMatch(/\.divider \{[^}]*width: 0\.0625rem;/);
	});

	it('rounds the frame corner by the channel list 18px, on the web and the desktop app alike', () => {
		// Upstream rounds only the desktop app's frame (clamp 8-14px) and keeps the web square.
		const block = (file: string) =>
			(readFileSync(`${SRC_ROOT}${file}`, 'utf8').split(MARKER)[1] ?? '').replace(/\s+/g, ' ').trim();
		expect(block('app/globals.css')).toBe(':root { --outline-frame-radius-native: 1.125rem; }');
		for (const file of [
			'features/app/components/layout/GuildsLayout.module.css',
			'features/app/components/skeleton/AppSkeleton.module.css',
		]) {
			expect(block(file)).toBe('.outlineFrame { --outline-radius: var(--outline-frame-radius-native); }');
		}
	});
});

// Micup: the user area (voice panel and user row) sits in the channel list column, inside the frame's left line, as in
// v1; upstream stretches it under the server rail too. The rail runs to the bottom on its own surface and stops
// reserving room for the user area; the channel and DM lists keep reserving it (USER_AREA_MARKER blocks).
const USER_AREA_MARKER = '/* Micup: user area in the channel list column */';

function micupSection(file: string, marker: string): string {
	const css = readFileSync(`${SRC_ROOT}${file}`, 'utf8');
	expect(css.split(marker)).toHaveLength(2);
	const after = css.slice(css.indexOf(marker) + marker.length);
	const next = after.indexOf('/* Micup:');
	return (next === -1 ? after : after.slice(0, next)).replace(/\s+/g, ' ').trim();
}

describe('user area in the channel list column', () => {
	const COLUMN =
		'--user-area-avatar-lead: var(--user-area-padding-x); left: calc(var(--layout-guild-list-width) + var(--outline-frame-border-width)); width: var(--layout-sidebar-width);';

	it('starts the user area after the frame line and spans the channel list, the rail reserving nothing', () => {
		expect(micupSection('features/app/components/layout/GuildsLayout.module.css', USER_AREA_MARKER)).toBe(
			`.guildListScrollerWrapper { --layout-user-area-overlay-height: 0px; } .userAreaWrapper { ${COLUMN} }`,
		);
		// The offsets above are the frame's left line and the channel list column (the divider sits at its end).
		const frame = readFileSync(`${SRC_ROOT}features/app/components/layout/OutlineFrame.module.css`, 'utf8');
		expect(frame).toMatch(/\.frame \{[^}]*border: var\(--outline-frame-border-width, 0\.0625rem\) solid/);
		expect(frame).toMatch(/\.divider \{[^}]*left: var\(--layout-sidebar-width\);/);
	});

	it('mirrors it in the startup skeleton', () => {
		expect(micupSection('features/app/components/skeleton/UserAreaSkeleton.module.css', USER_AREA_MARKER)).toBe(
			`.userArea { ${COLUMN} }`,
		);
		expect(micupSection('features/app/components/skeleton/GuildRailSkeleton.module.css', USER_AREA_MARKER)).toBe(
			'.rail { --layout-user-area-overlay-height: 0px; }',
		);
	});

	it.each([
		'features/app/components/layout/ChannelListContent.module.css',
		'features/channel/components/direct_message/DirectMessageList.module.css',
		'features/app/components/skeleton/GuildSidebarSkeleton.module.css',
		'features/app/components/skeleton/DMSidebarSkeleton.module.css',
	])('keeps the last row above the user area in %s', (file) => {
		const css = readFileSync(`${SRC_ROOT}${file}`, 'utf8');
		expect(css).toContain('--layout-user-area-overlay-height');
		expect(css).not.toContain(USER_AREA_MARKER);
	});
});
