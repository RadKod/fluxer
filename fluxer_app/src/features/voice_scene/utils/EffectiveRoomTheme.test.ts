// SPDX-License-Identifier: AGPL-3.0-or-later

import {effectiveRoomTheme} from '@app/features/voice_scene/utils/EffectiveRoomTheme';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';

describe('effectiveRoomTheme', () => {
	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM, ChannelTypes.GUILD_TEXT])(
		'does not inherit the instance default for channel type %s',
		(channelType) => {
			expect(effectiveRoomTheme(null, 'kahvehane', channelType)).toBeNull();
			expect(effectiveRoomTheme(undefined, 'oyun-odasi', channelType)).toBeNull();
		},
	);
	it('inherits the current instance default for null and absent overrides', () => {
		expect(effectiveRoomTheme(null, 'kahvehane', ChannelTypes.GUILD_VOICE)).toBe('kahvehane');
		expect(effectiveRoomTheme(undefined, 'oyun-odasi', ChannelTypes.GUILD_VOICE)).toBe('oyun-odasi');
		expect(effectiveRoomTheme(null, null, ChannelTypes.GUILD_VOICE)).toBeNull();
	});

	it('an explicit none override remains flat', () => {
		expect(effectiveRoomTheme('none', 'kahvehane', ChannelTypes.GUILD_VOICE)).toBeNull();
	});

	it('uses explicit theme IDs without applying the default', () => {
		expect(effectiveRoomTheme('gece-lounge', 'kahvehane', ChannelTypes.GUILD_VOICE)).toBe('gece-lounge');
		expect(effectiveRoomTheme('oyun-odasi', null, ChannelTypes.GUILD_VOICE)).toBe('oyun-odasi');
		expect(effectiveRoomTheme('unknown', 'kahvehane', ChannelTypes.GUILD_VOICE)).toBeNull();
	});
});
