// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({defaultTheme: null as string | null}));

vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: vi.fn()}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, default_room_theme: env.defaultTheme}),
}));
vi.mock('@app/features/voice_scene/utils/WebglSupport', () => ({
	getWebglSupport: () => ({webgl2: true, renderer: 'GPU', hardwareConcurrency: 8, deviceMemory: 8}),
}));

const {roomViewFor} = await import('./RoomView');
const {default: settings} = await import('./VoiceSceneSettings');
const {default: fullscreen} = await import('@app/features/voice/state/VoiceCallFullscreen');
const channel = {id: 'c', guildId: 'g', type: ChannelTypes.GUILD_VOICE, roomTheme: 'kahvehane'} as Channel;

beforeEach(() => {
	env.defaultTheme = null;
	settings.retry();
	fullscreen.close();
});

describe('shared room visibility under fullscreen intent', () => {
	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM])('does not inherit a room in channel type %s', (type) => {
		env.defaultTheme = 'kahvehane';
		expect(roomViewFor({...channel, guildId: null, type, roomTheme: null} as unknown as Channel)).toEqual({
			show: false,
			reason: 'no_theme',
		});
	});
	it('makes channels without an override eligible for the instance default room', () => {
		env.defaultTheme = 'kahvehane';
		expect(roomViewFor({...channel, roomTheme: null} as Channel)).toEqual({show: true, reason: 'room'});
	});

	it('keeps an explicit none override flat despite the instance default', () => {
		env.defaultTheme = 'kahvehane';
		expect(roomViewFor({...channel, roomTheme: 'none'} as Channel)).toEqual({show: false, reason: 'no_theme'});
	});
	it.each(['guild-voice:c', 'dm-call:c'])('reports compact %s as flat to every consumer', (scope) => {
		const viewedChannel = {
			id: 'c',
			guildId: scope.startsWith('dm-call') ? null : 'g',
			type: scope.startsWith('dm-call') ? ChannelTypes.DM : ChannelTypes.GUILD_VOICE,
			roomTheme: 'kahvehane',
		} as Channel;
		fullscreen.open(scope, 'call');
		expect(roomViewFor(viewedChannel)).toEqual({show: false, reason: 'user_flat'});
		expect(settings.preferRoom).toBe(true);
		fullscreen.open(scope);
		expect(roomViewFor(viewedChannel)).toEqual({show: true, reason: 'room'});
	});

	it('keeps another channel eligible for its room', () => {
		fullscreen.open('guild-voice:other', 'call');
		expect(roomViewFor(channel)).toEqual({show: true, reason: 'room'});
	});

	it.each(['context_lost', 'load_failed'] as const)('retains %s so the explicit retry remains available', (failure) => {
		fullscreen.open('guild-voice:c', 'call');
		settings.reportFailure(failure);
		expect(roomViewFor(channel)).toEqual({show: false, reason: failure});
	});

	it('retains the missing-theme gate', () => {
		fullscreen.open('guild-voice:c', 'call');
		expect(roomViewFor({...channel, roomTheme: null} as Channel)).toEqual({show: false, reason: 'no_theme'});
	});
});
