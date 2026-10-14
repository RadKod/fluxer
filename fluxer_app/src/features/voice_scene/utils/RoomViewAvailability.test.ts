// SPDX-License-Identifier: AGPL-3.0-or-later

import {type RoomViewInput, resolveRoomView} from '@app/features/voice_scene/utils/RoomViewAvailability';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {isVoiceRoomTheme} from '@fluxer/constants/src/VoiceRoomThemes';
import {describe, expect, it} from 'vitest';

const ROOM: RoomViewInput = {
	channelType: ChannelTypes.GUILD_VOICE,
	rooms: true,
	theme: 'gece-lounge',
	isMobileLayout: false,
	webgl: {
		webgl2: true,
		renderer: 'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)',
		hardwareConcurrency: 8,
		deviceMemory: 8,
	},
	preferRoom: true,
	contextLost: false,
	loadFailed: false,
};

function reasonFor(overrides: Partial<RoomViewInput>): string {
	const view = resolveRoomView({...ROOM, ...overrides});
	expect(view.show).toBe(view.reason === 'room');
	return view.reason;
}

describe('resolveRoomView', () => {
	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM])(
		'keeps channel type %s flat with a default theme',
		(channelType) => {
			expect(reasonFor({channelType, theme: null, defaultTheme: 'kahvehane'})).toBe('no_theme');
		},
	);
	it('flag off → flat flag_off', () => {
		expect(reasonFor({rooms: false})).toBe('flag_off');
	});

	it('no or unknown theme → flat', () => {
		expect(reasonFor({theme: null})).toBe('no_theme');
		expect(reasonFor({theme: undefined})).toBe('no_theme');
		expect(reasonFor({theme: 'uzay-gemisi'})).toBe('no_theme');
	});

	it('inherits the instance default for null or absent channel themes', () => {
		expect(reasonFor({theme: null, defaultTheme: 'kahvehane'})).toBe('room');
		expect(reasonFor({theme: undefined, defaultTheme: 'oyun-odasi'})).toBe('room');
	});

	it('explicit none disables an inherited room', () => {
		expect(reasonFor({theme: 'none', defaultTheme: 'kahvehane'})).toBe('no_theme');
		expect(isVoiceRoomTheme('none')).toBe(false);
	});

	it('an explicit channel theme overrides a disabled instance default', () => {
		expect(reasonFor({theme: 'oyun-odasi', defaultTheme: null})).toBe('room');
	});

	it('mobile layout → flat mobile', () => {
		expect(reasonFor({isMobileLayout: true})).toBe('mobile');
	});

	it('no webgl2 → flat no_webgl', () => {
		expect(reasonFor({webgl: {...ROOM.webgl, webgl2: false, renderer: null}})).toBe('no_webgl');
	});

	it('SwiftShader/llvmpipe/Software/Microsoft Basic Render → flat software_gpu', () => {
		for (const renderer of [
			'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
			'llvmpipe (LLVM 15.0.7, 256 bits)',
			'Software Rasterizer',
			'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)',
		]) {
			expect(reasonFor({webgl: {...ROOM.webgl, renderer}})).toBe('software_gpu');
		}
	});

	it('hardwareConcurrency ≤ 2 or deviceMemory ≤ 2 → flat weak_device', () => {
		expect(reasonFor({webgl: {...ROOM.webgl, hardwareConcurrency: 2}})).toBe('weak_device');
		expect(reasonFor({webgl: {...ROOM.webgl, deviceMemory: 2}})).toBe('weak_device');
		expect(reasonFor({webgl: {...ROOM.webgl, hardwareConcurrency: null, deviceMemory: null}})).toBe('room');
	});

	it('user prefers flat → flat user_flat', () => {
		expect(reasonFor({preferRoom: false})).toBe('user_flat');
	});

	it('context lost → flat context_lost', () => {
		expect(reasonFor({contextLost: true})).toBe('context_lost');
	});

	it('room chunk or file failed to load → flat load_failed', () => {
		expect(reasonFor({loadFailed: true})).toBe('load_failed');
	});

	it('otherwise room', () => {
		expect(resolveRoomView(ROOM)).toEqual({show: true, reason: 'room'});
	});
});
