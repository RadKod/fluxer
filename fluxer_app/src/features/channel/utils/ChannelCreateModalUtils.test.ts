// SPDX-License-Identifier: AGPL-3.0-or-later

import {getChannelTypeOptions} from '@app/features/channel/utils/ChannelCreateModalUtils';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {I18n} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectChannel: vi.fn()}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => false}}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({pop: vi.fn()}));

const i18n = {_: (descriptor: {message: string}) => descriptor.message} as unknown as I18n;

describe('getChannelTypeOptions', () => {
	it('does not offer the announcement channel type', () => {
		for (const forums of [false, true]) {
			const types = getChannelTypeOptions(i18n, {forums}).map((option) => option.value);
			expect(types).toContain(ChannelTypes.GUILD_TEXT);
			expect(types).not.toContain(ChannelTypes.GUILD_ANNOUNCEMENT);
		}
	});
});
