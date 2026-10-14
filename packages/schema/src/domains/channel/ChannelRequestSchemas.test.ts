// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {ChannelCreateRequest, ChannelUpdateRequest} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {describe, expect, it} from 'vitest';

const THEME = VOICE_ROOM_THEME_IDS[0];

describe('channel room_theme', () => {
	it('update accepts manifest theme ids and null, rejects unknown ones', () => {
		for (const id of VOICE_ROOM_THEME_IDS) {
			expect(ChannelUpdateRequest.parse({type: ChannelTypes.GUILD_VOICE, room_theme: id})).toMatchObject({
				room_theme: id,
			});
		}
		expect(ChannelUpdateRequest.parse({type: ChannelTypes.GUILD_VOICE, room_theme: null})).toMatchObject({
			room_theme: null,
		});
		expect(ChannelUpdateRequest.safeParse({type: ChannelTypes.GUILD_VOICE, room_theme: 'not-a-room'}).success).toBe(
			false,
		);
	});

	it('an update without room_theme leaves it undefined, so it is never written', () => {
		const parsed = ChannelUpdateRequest.parse({type: ChannelTypes.GUILD_VOICE, name: 'renamed'});
		expect('room_theme' in parsed).toBe(false);
	});

	it('none explicitly disables a room theme instead of inheriting the default', () => {
		expect(ChannelUpdateRequest.parse({type: ChannelTypes.GUILD_VOICE, room_theme: 'none'})).toMatchObject({
			room_theme: 'none',
		});
	});

	it('create requests do not carry room_theme', () => {
		const parsed = ChannelCreateRequest.parse({type: ChannelTypes.GUILD_VOICE, name: 'lounge', room_theme: THEME});
		expect('room_theme' in parsed).toBe(false);
	});

	it('responses keep a theme that left the manifest', () => {
		const parsed = ChannelResponse.parse({id: '1', type: ChannelTypes.GUILD_VOICE, room_theme: 'retired-room'});
		expect(parsed.room_theme).toBe('retired-room');
	});
});
