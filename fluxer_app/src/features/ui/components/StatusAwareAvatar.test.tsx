// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';

vi.mock('@app/features/presence/state/Presence', () => ({default: {getStatus: () => 'online', isMobile: () => false}}));
vi.mock('@app/features/presence/state/TransientPresence', () => ({default: {getStatus: () => 'offline'}}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({decorationSurface}: {decorationSurface?: string}) =>
		createElement('i', {'data-surface': decorationSurface ?? 'unset'}),
}));

const {StatusAwareAvatar, ListStatusAwareAvatar} = await import('@app/features/ui/components/StatusAwareAvatar');

it('hands the decoration surface to the avatar, from the list variant too', () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement('div');
	const root = createRoot(container);
	const user = {id: '1', system: false} as never;
	act(() => root.render(createElement(StatusAwareAvatar, {user, size: 80, decorationSurface: 'profile'})));
	expect(container.querySelector('i')?.getAttribute('data-surface')).toBe('profile');
	act(() => root.render(createElement(ListStatusAwareAvatar, {user, size: 32, decorationSurface: 'compact'})));
	expect(container.querySelector('i')?.getAttribute('data-surface')).toBe('compact');
	act(() => root.unmount());
});
