// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {COSMETIC_TYPES, type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {detailSurfacesFor, SHOP_SURFACES, type ShopSurface} from '@app/features/shop/utils/ShopSurfaces';
import {parse} from '@babel/parser';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/cosmetics/commands/CosmeticCommands', () => ({}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({}));
vi.mock('@app/features/user/state/Users', () => ({default: {}}));

// Rendering the four surfaces needs most of the app, so this reads their JSX, like AvatarUltraSurfaces.test.ts and
// ProfileEffectSurfaces.test.ts do: the shop shows an item only where the app really draws it.
const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SURFACE_FILES: Record<ShopSurface, string> = {
	profile: 'features/user/components/profile/ProfilePreview.tsx',
	chat: 'features/channel/components/MessageAvatar.tsx',
	member_list: 'features/channel/components/MemberListItem.tsx',
	voice: 'features/voice/components/VoiceParticipantTile.tsx',
};

type Element = {name: string; attributes: Array<string>};

function elements(file: string): Array<Element> {
	const ast = parse(readFileSync(`${SRC_ROOT}${file}`, 'utf8'), {sourceType: 'module', plugins: ['typescript', 'jsx']});
	const found: Array<Element> = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const astNode = node as {type?: string; name?: {name?: string}; attributes?: Array<{name?: {name?: string}}>};
		if (astNode.type === 'JSXOpeningElement') {
			found.push({
				name: astNode.name?.name ?? '',
				attributes: (astNode.attributes ?? []).map((attribute) => attribute.name?.name ?? ''),
			});
		}
		for (const [key, value] of Object.entries(astNode)) {
			if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value);
		}
	};
	visit(ast.program);
	return found;
}

// Every avatar of 32 px and up draws the frame; the ultra decoration needs a named surface; the nameplate and the
// profile effect each have one component.
const isAvatar = (element: Element) => /Avatar$/.test(element.name) || element.name === 'ProfileCardBanner';
const DRAWS: Record<CosmeticType, (element: Element) => boolean> = {
	avatar_decoration: isAvatar,
	avatar_ultra: (element) => isAvatar(element) && element.attributes.includes('decorationSurface'),
	nameplate: (element) => element.name === 'NameplateBackground',
	profile_effect: (element) => element.name === 'ProfileCardLayout' && element.attributes.includes('profileEffect'),
};

describe('SHOP_SURFACES', () => {
	it('does not offer surfaces for unknown catalog types or inherited object keys', () => {
		expect(detailSurfacesFor(['future_cosmetic', 'toString'])).toEqual([]);
		expect(detailSurfacesFor(['future_cosmetic', 'nameplate'])).toEqual(['member_list']);
	});
	it('shows only supported profile, member and chat surfaces without adding voice', () => {
		expect(detailSurfacesFor(['profile_effect'])).toEqual(['profile']);
		expect(detailSurfacesFor(['nameplate'])).toEqual(['member_list']);
		for (const type of ['avatar_decoration', 'avatar_ultra'] as const) {
			expect(detailSurfacesFor([type])).toEqual(['profile', 'member_list', 'chat']);
		}
		expect(detailSurfacesFor(['profile_effect', 'nameplate', 'avatar_ultra'])).toEqual([
			'profile',
			'member_list',
			'chat',
		]);
	});
	it.each(COSMETIC_TYPES)('matches the surfaces the app draws for %s', (type) => {
		const drawn = (Object.keys(SURFACE_FILES) as Array<ShopSurface>).filter((surface) =>
			elements(SURFACE_FILES[surface]).some(DRAWS[type]),
		);
		expect(SHOP_SURFACES[type]).toEqual(drawn);
	});
});
