// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@app/features/ui/motion/AnimeElement', () => ({
	AnimePresence: ({children}: {children: unknown}) => children,
	AnimeTweenType: {SPRING: 'spring'},
	createAnimeFlxElement: () => 'div',
}));

const {MentionBadge} = await import('@app/features/ui/components/MentionBadge');

function text(props: {mentionCount: number; max?: number}): string {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement('div');
	const root = createRoot(container);
	act(() => root.render(createElement(MentionBadge, props)));
	const content = container.textContent ?? '';
	act(() => root.unmount());
	return content;
}

describe('MentionBadge max (Micup 2a.9b)', () => {
	it('shows a capped count as its cap with a plus, and nothing at 0', () => {
		expect(text({mentionCount: 9, max: 9})).toBe('9');
		expect(text({mentionCount: 10, max: 9})).toBe('9+');
		expect(text({mentionCount: 0, max: 9})).toBe('');
	});

	it("keeps Fluxer's own format without a cap", () => {
		expect(text({mentionCount: 150})).toBe('99+');
		expect(text({mentionCount: 7})).toBe('7');
	});
});
