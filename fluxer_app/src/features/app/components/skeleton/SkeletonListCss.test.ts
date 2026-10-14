// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: list placeholders (message history filler, member, channel, DM and guild lists, forum posts, GIF results)
// render many skeleton rows at once. A non-composited infinite shimmer on each row (background-position) restyles and
// repaints the list every frame while idle, so these placeholders stay static. Each stylesheet carries its override in
// one block at its end, after MARKER, so upstream merges never touch these lines.
const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SKELETON_DIR = 'features/app/components/skeleton/';
const MARKER = '/* Micup: static list skeletons */';

function read(file: string): string {
	return readFileSync(`${SRC_ROOT}${file}`, 'utf8');
}

function block(file: string): string {
	const parts = read(file).split(MARKER);
	expect(parts).toHaveLength(2);
	return (parts[1] ?? '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

describe('list skeletons', () => {
	it('stop the shared skeleton shimmer on every skeleton surface, list rows included', () => {
		expect(block(`${SKELETON_DIR}Skeleton.module.css`)).toBe('.skeleton { animation: none; background-image: none; }');
	});

	it('stop the mobile member list skeleton shimmer', () => {
		expect(block('features/channel/components/bottomsheets/ChannelDetailsBottomSheet.module.css')).toBe(
			'.skeleton { animation: none; }',
		);
	});

	it('stop the GIF, meme and sticker grid item shimmer', () => {
		expect(block('features/channel/components/GifPicker.module.css')).toBe(
			'.skeletonItem { animation: none; will-change: auto; }',
		);
	});

	it('declare no animation in the list skeleton layouts themselves', () => {
		const layouts = readdirSync(`${SRC_ROOT}${SKELETON_DIR}`)
			.filter((name) => name.endsWith('.module.css') && name !== 'Skeleton.module.css')
			.map((name) => `${SKELETON_DIR}${name}`);
		layouts.push('features/channel/components/MemberListSkeleton.module.css');
		expect(layouts).toContain(`${SKELETON_DIR}ScrollFillerSkeleton.module.css`);
		for (const file of layouts) {
			expect(read(file), file).not.toMatch(/animation|@keyframes/);
		}
	});

	it('keep the off-screen history filler skipped (content-visibility: auto, no transition)', () => {
		const wrapper = /\.wrapper \{([^}]*)\}/.exec(read(`${SKELETON_DIR}ScrollFillerSkeleton.module.css`))?.[1] ?? '';
		expect(wrapper).toMatch(/^\s*content-visibility: auto;$/m);
		expect(wrapper).toMatch(/^\s*transition: none;$/m);
	});
});
