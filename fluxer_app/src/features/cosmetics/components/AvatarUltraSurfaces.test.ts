// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {describe, expect, it} from 'vitest';

// Rendering every avatar surface needs most of the app, so this reads the JSX instead: ultra decorations stay on
// the supported surfaces, and a new surface that asks for them or an upstream merge that drops one fails here.
interface AstNode {
	type?: string;
	[key: string]: unknown;
}

interface SurfaceUse {
	file: string;
	element: string;
	value: string;
}

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function listTsxFiles(directory: string): Array<string> {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listTsxFiles(path);
		return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
	});
}

function surfaceUses(file: string): Array<SurfaceUse> {
	const ast = parse(readFileSync(file, 'utf8'), {sourceType: 'module', plugins: ['typescript', 'jsx']});
	const uses: Array<SurfaceUse> = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const astNode = node as AstNode & {
			name?: {name?: string};
			attributes?: Array<{name?: {name?: string}; value?: {type?: string; value?: string}}>;
		};
		if (astNode.type === 'JSXOpeningElement') {
			let hasSurface = false;
			for (const attribute of astNode.attributes ?? []) {
				if (attribute.name?.name !== 'decorationSurface') continue;
				hasSurface = true;
				uses.push({
					file: relative(SRC_ROOT, file).replaceAll('\\', '/'),
					element: astNode.name?.name ?? '',
					value: attribute.value?.type === 'StringLiteral' ? (attribute.value.value ?? '') : '{…}',
				});
			}
			if (!hasSurface && (astNode.name?.name === 'ProfileCardBanner' || astNode.name?.name === 'ProfilePreview')) {
				uses.push({
					file: relative(SRC_ROOT, file).replaceAll('\\', '/'),
					element: astNode.name.name,
					value: 'default profile',
				});
			}
		}
		for (const [key, value] of Object.entries(astNode)) {
			if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value);
		}
	};
	visit(ast.program);
	return uses;
}

const uses = listTsxFiles(SRC_ROOT).flatMap(surfaceUses);

describe('ultra decoration surfaces', () => {
	it.each([
		['features/channel/components/MessageAvatar.tsx', 'Avatar', 'compact'],
		['features/channel/components/MemberListItem.tsx', 'ListStatusAwareAvatar', 'compact'],
		['features/user/components/modals/user_profile_modal/ProfileMediaHeader.tsx', 'StatusAwareAvatar', 'profile'],
		['features/user/components/modals/CustomStatusModal.tsx', 'ProfilePreview', 'none'],
		['features/voice/components/VoiceParticipantTile.tsx', 'Avatar', 'voice'],
		['features/shop/components/previews/ShopVoiceTilePreview.tsx', 'Avatar', 'voice'],
	])('%s asks %s for the %s ultra surface', (file, element, value) => {
		expect(uses).toContainEqual({file, element, value});
	});

	it('names an ultra surface nowhere else and passes it through only the avatar and profile card chain', () => {
		expect(uses.map((use) => `${use.file} ${use.element} ${use.value}`).sort()).toEqual(
			[
				'features/channel/components/MemberListItem.tsx ListStatusAwareAvatar compact',
				'features/channel/components/MessageAvatar.tsx Avatar compact',
				'features/app/components/floating/UserAreaPopout.tsx ProfileCardBanner default profile',
				'features/cosmetics/components/CosmeticsSettingsTab.tsx ProfilePreview default profile',
				'features/ui/components/StatusAwareAvatar.tsx Avatar {…}',
				'features/user/components/modals/CustomStatusModal.tsx ProfilePreview none',
				'features/user/components/modals/tabs/MyProfileTab.tsx ProfilePreview default profile',
				'features/user/components/modals/user_profile_modal/ProfileMediaHeader.tsx StatusAwareAvatar profile',
				'features/user/components/profile/ProfilePreview.tsx ProfileCardBanner {…}',
				'features/user/components/profile/profile_card/ProfileCardBanner.tsx StatusAwareAvatar {…}',
				'features/user/components/popouts/UserProfilePopout.tsx ProfileCardBanner default profile',
				'features/voice/components/VoiceParticipantTile.tsx Avatar voice',
				'features/voice_scene/components/VoiceSceneAvatar.tsx Avatar voice',
				'features/premium/components/PremiumPerkTiles.tsx ProfilePreview default profile',
				'features/shop/components/ShopItemStage.tsx Avatar compact',
				'features/shop/components/ShopItemStage.tsx Avatar profile',
				'features/shop/components/ShopItemStage.tsx Avatar profile',
				'features/shop/components/ShopItemStage.tsx ProfilePreview default profile',
				'features/shop/components/ShopItemStage.tsx ProfilePreview default profile',
				'features/shop/components/previews/ShopVoiceTilePreview.tsx Avatar voice',
			].sort(),
		);
	});
});
