// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: every tile on the server rail is a Discord-like rounded square (30%) at rest, on hover and when selected;
// upstream animates circles (50%) into that square. Avatars off the rail (member list, messages) stay round.
const LAYOUT = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(`${LAYOUT}${file}`, 'utf8');

function rule(css: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const body = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1];
	expect(body, selector).toBeDefined();
	return body ?? '';
}

describe('server rail tile shape', () => {
	it.each([
		'DiscoveryButton.tsx',
		'FavoritesButton.tsx',
		'FeedButton.tsx',
		'FluxerButton.tsx',
		'GuildListActionButton.tsx',
		'GuildListDMItem.tsx',
	])('animates %s to the rounded square only', (file) => {
		const source = read(`sidebar_nav/${file}`);
		expect(source).not.toContain("'50%'");
		expect(source).toMatch(/animate=\{\{borderRadius: '30%'\}\}/);
	});

	it('gives guild icons the rounded square in every state', () => {
		const source = read('sidebar_nav/GuildListItemContent.tsx');
		expect(source).not.toContain("'50%'");
		expect(source).toContain('iconBorderRadius="30%"');
	});

	it('starts guild, action and unavailable tiles as rounded squares in CSS', () => {
		const css = read('GuildsLayout.module.css');
		expect(rule(css, '.guildIcon')).toContain('border-radius: 30%;');
		expect(rule(css, '.createGuildButtonIcon')).toContain('border-radius: 30%;');
		expect(rule(css, '.unavailableBadge')).toContain('border-radius: 30%;');
	});

	it('draws the startup rail skeleton with the same squares', () => {
		const css = readFileSync(`${LAYOUT}../skeleton/GuildRailSkeleton.module.css`, 'utf8');
		expect(css).not.toContain("[data-selected='true'] flx-skeleton-circle");
		for (const selector of [
			'.itemSlot flx-skeleton-circle',
			'.item flx-skeleton-circle',
			'.expandedFolderGuild flx-skeleton-circle',
		]) {
			expect(rule(css, selector)).toContain('border-radius: 30%;');
		}
		expect(rule(css, '.fluxerIcon')).toContain('border-radius: 30%;');
	});
});
