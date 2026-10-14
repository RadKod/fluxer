// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
	MEMBER_LIST_GROUP_HEADER_HEIGHT_PX,
	MEMBER_LIST_ITEM_HEIGHT_PX,
	MEMBER_LIST_METRICS_STYLE,
} from '@app/features/channel/components/MemberListMetrics';
import {buildMemberListLayout, buildMemberListRowOffsets} from '@app/features/member/utils/MemberListLayout';
import {describe, expect, it} from 'vitest';

// Micup: compact channel rows, 28px tall and 2px apart (upstream 32px and 1px), category names at weight 500. Tokens
// in globals.css; each stylesheet carries its override in one block at its end, after MARKER, so upstream merges never
// touch these lines.
const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MARKER = '/* Micup: Discord-like channel rows */';

function block(file: string): string {
	const parts = readFileSync(`${SRC_ROOT}${file}`, 'utf8').split(MARKER);
	expect(parts).toHaveLength(2);
	return (parts[1] ?? '').replace(/\s+/g, ' ').trim();
}

describe('channel rows', () => {
	it('declares the row padding and the row and category gaps in globals.css', () => {
		expect(block('app/globals.css')).toMatch(
			/^:root \{ --channel-item-padding-block: 0\.25rem; --channel-item-gap: 0\.125rem; --channel-category-gap: 0\.375rem; \}/,
		);
	});

	it('applies them to channel rows, not to category headers or voice participants', () => {
		expect(block('features/app/components/layout/ChannelItem.module.css')).toBe(
			'.channelItemCore, .channelItemRegular { padding-top: var(--channel-item-padding-block); padding-bottom: var(--channel-item-padding-block); } .channelReorderTarget:not(.channelCategoryReorderTarget) { padding-top: var(--channel-item-gap); } .channelCategoryReorderTarget { padding-top: var(--channel-category-gap); } .categoryName { font-weight: 500; }',
		);
	});

	it('keeps the upstream Discord-sized name weight, line height and icon (1rem/1.25rem/500, 1.25rem icon)', () => {
		const css = readFileSync(`${SRC_ROOT}features/app/components/layout/ChannelItem.module.css`, 'utf8');
		const [upstream = ''] = css.split(MARKER);
		const lastRule = (name: string) =>
			[...upstream.matchAll(new RegExp(`\\.${name} \\{([^}]*)\\}`, 'g'))].at(-1)?.[1] ?? '';
		expect(lastRule('channelName')).toMatch(/font-weight: 500;\s*font-size: 1rem;\s*line-height: 1\.25rem;/);
		expect(lastRule('channelItemLabel')).toMatch(/font-weight: 500;\s*font-size: 1rem;\s*line-height: 1\.25rem;/);
		expect(lastRule('channelItemIcon')).toMatch(/height: 1\.25rem;\s*width: 1\.25rem;/);
		expect(lastRule('categoryName')).toMatch(/font-weight: 600;/);
	});

	it('mirrors them in the startup skeleton', () => {
		expect(block('features/app/components/skeleton/GuildSidebarSkeleton.module.css')).toBe(
			'.rowChannel { margin-top: var(--channel-item-gap); padding-top: var(--channel-item-padding-block); padding-bottom: var(--channel-item-padding-block); } .rowCategory { margin-top: var(--channel-category-gap); }',
		);
	});
});

// Micup: the coal and dark themes share the v1 palette (GenerateColorSystem.ts, MicupV1Palette.test.ts): the server rail
// on the frame color, the chat on the body color, and the channel list, DM list, user area and member list panels on
// --side-panel-background; each panel re-scopes the surface variable its descendants read, so light stays upstream.
// The channel header takes the palette's channel header color.
const PANELS_MARKER = '/* Micup: lighter side panels in the coal theme */';
const COAL_HEADER_MARKER = '/* Micup: coal channel header on its own step */';
// Every Micup coal rule steps aside while a custom theme (Theme Studio or the theme library) is applied, so the theme's
// own surface variables paint the panels, header and chat as upstream.
const COAL_OR_DARK = ':global(html:is(.theme-coal, .theme-dark):not(:has(#fluxer-custom-theme-style)))';

function section(file: string, marker: string): string {
	const css = readFileSync(`${SRC_ROOT}${file}`, 'utf8');
	expect(css.split(marker)).toHaveLength(2);
	const after = css.slice(css.indexOf(marker) + marker.length);
	const next = after.indexOf('/* Micup:');
	return (next === -1 ? after : after.slice(0, next)).replace(/\s+/g, ' ').trim();
}

describe('coal side panels', () => {
	it('leaves the panel surface to the coal and dark palette, not to globals.css', () => {
		expect(readFileSync(`${SRC_ROOT}app/globals.css`, 'utf8')).not.toContain('--side-panel-background');
	});

	it.each([
		['features/app/components/layout/GuildNavbar.module.css', 'guildNavbarContainer', '--background-secondary'],
		[
			'features/channel/components/direct_message/DirectMessageList.module.css',
			'dmListContainer',
			'--background-secondary',
		],
		['features/app/components/layout/GuildsLayout.module.css', 'userAreaWrapper', '--background-secondary'],
		[
			'features/channel/components/MemberListContainer.module.css',
			'memberListContainer',
			'--background-secondary-lighter',
		],
		['features/app/components/skeleton/SidebarShellSkeleton.module.css', 'container', '--background-secondary'],
		['features/app/components/skeleton/DMSidebarSkeleton.module.css', 'container', '--background-secondary'],
		['features/app/components/skeleton/UserAreaSkeleton.module.css', 'userArea', '--background-secondary'],
	])('re-scopes the surface in %s', (file, className, variable) => {
		expect(section(file, PANELS_MARKER)).toBe(
			`${COAL_OR_DARK} .${className} { ${variable}: var(--side-panel-background); }`,
		);
	});

	it('gives the chat skeleton the same coal header and member list surfaces', () => {
		expect(section('features/app/components/skeleton/ChatSkeleton.module.css', PANELS_MARKER)).toBe(
			`${COAL_OR_DARK} .header { --background-secondary-lighter: var(--background-channel-header); } ${COAL_OR_DARK} .memberList { --background-secondary-lighter: var(--side-panel-background); }`,
		);
	});
});

// Keep Fluxer's 32px role header and 12px top padding in both the virtual list and its skeleton.
const ROLE_GAP_MARKER = '/* Micup: role group gap in the member list */';

describe('member list role groups', () => {
	it('keeps the virtual row offsets and CSS header height aligned at the upstream size', () => {
		expect(MEMBER_LIST_GROUP_HEADER_HEIGHT_PX).toBe(32);
		expect(
			MEMBER_LIST_METRICS_STYLE['--member-list-group-header-height' as keyof typeof MEMBER_LIST_METRICS_STYLE],
		).toBe('2rem');
		const layouts = buildMemberListLayout([
			{id: 'role', count: 1},
			{id: 'online', count: 1},
		]);
		expect(
			buildMemberListRowOffsets(layouts, 4, {
				memberHeight: MEMBER_LIST_ITEM_HEIGHT_PX,
				headerHeight: MEMBER_LIST_GROUP_HEADER_HEIGHT_PX,
			}),
		).toEqual([0, 32, 76, 108, 152]);
		const css = readFileSync(`${SRC_ROOT}features/channel/components/ChannelMembers.module.css`, 'utf8');
		expect(css).toMatch(/\.groupHeader,\s*\.virtualGroupRow \{[^}]*line-height: 1rem;/);
		expect(css).toMatch(/\.virtualGroupRow \{[^}]*padding-bottom: 0\.25rem;/);
	});

	it.each([
		['features/channel/components/ChannelMembers.module.css', 'virtualGroupRow'],
		['features/channel/components/MemberListSkeleton.module.css', 'groupHeader'],
	])('keeps the upstream top padding without a sanalyer gap override in %s', (file, className) => {
		const css = readFileSync(`${SRC_ROOT}${file}`, 'utf8');
		expect(css).not.toContain(ROLE_GAP_MARKER);
		expect(css).toMatch(new RegExp(`\\.${className} \\{[^}]*padding(?:-top)?: 0\\.75rem`));
	});
});

// Micup: the chat area (guild and DM) keeps a plain surface; only the Add Friend page paints upstream's inline glow.
describe('friends page glow', () => {
	it('stays on the Add Friend page only, as upstream', () => {
		const read = (file: string) => readFileSync(`${SRC_ROOT}${file}`, 'utf8');
		expect(read('app/globals.css')).not.toContain('--friends-glow-background');
		expect(read('features/channel/components/ChannelChatLayout.module.css')).not.toContain('background-image');
		expect(read('features/channel/components/direct_message/AddFriendView.module.css')).toMatch(
			/\.friendRequestContainer \{[^}]*background: radial-gradient\(/,
		);
	});
});

describe('coal palette', () => {
	const generator = readFileSync(`${SRC_ROOT}../scripts/GenerateColorSystem.ts`, 'utf8');
	const coalTokens = /\n\t\tcoal: \[([\s\S]*?)\n\t\t\],/.exec(generator)?.[1] ?? '';

	it('puts the rail, chat and side panels on their own v1 steps and drops the purple family', () => {
		expect(coalTokens).toContain("{name: '--background-secondary', value: '#060608'},");
		expect(coalTokens).toContain("{name: '--background-secondary-lighter', value: '#0c0c0f'},");
		expect(coalTokens).toContain("{name: '--side-panel-background', value: '#0e0e12'},");
		expect(coalTokens).not.toContain('neutralDark');
		expect(coalTokens).not.toContain('hsl(258');
	});

	it('paints the channel header with the palette channel header color in the coal and dark themes', () => {
		expect(section('features/channel/components/ChannelHeader.module.css', COAL_HEADER_MARKER)).toBe(
			`${COAL_OR_DARK} .headerContainer, ${COAL_OR_DARK} .headerWrapper { --background-secondary-lighter: var(--background-channel-header); }`,
		);
	});

	it("applies upstream's coal quick switcher surfaces to dark as well", () => {
		const css = readFileSync(
			`${SRC_ROOT}features/search/components/quick_switcher/QuickSwitcherModal.module.css`,
			'utf8',
		);
		expect(css).not.toContain(':global(html.theme-coal)');
		expect(css.match(/:global\(html:is\(\.theme-coal, \.theme-dark\)\)/g)).toHaveLength(4);
	});
});
