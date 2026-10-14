// SPDX-License-Identifier: AGPL-3.0-or-later

import type {I18n} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({})}));
vi.mock('@app/features/ui/action_menu/ContextMenuIcons', () => ({
	DeleteIcon: () => null,
	ReportMessageIcon: () => null,
}));
vi.mock('@app/features/ui/action_menu/MenuGroup', () => ({MenuGroup: () => null}));
vi.mock('@app/features/ui/action_menu/MenuItem', () => ({MenuItem: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn()}));

const {toastFeedFailure} = await import('@app/features/feed/components/FeedItemMenu');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');

const i18n = {_: (descriptor: {message: string}) => descriptor.message} as unknown as I18n;

describe('toastFeedFailure', () => {
	// 'invalid' is also the server's 400 (a poll it refuses after normalizing the options), so it is said, not swallowed.
	it('names every refused feed action and stays silent when it went through', () => {
		for (const outcome of ['ok', 'gone', 'forbidden', 'failed', 'invalid'] as const) toastFeedFailure(i18n, outcome);
		expect(vi.mocked(ToastCommands.error).mock.calls).toEqual([
			['This post is no longer available.'],
			["You can't do that here."],
			['Try again in a moment.'],
			['Check what you wrote and try again.'],
		]);
	});
});
