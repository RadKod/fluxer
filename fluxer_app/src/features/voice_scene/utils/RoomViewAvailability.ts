// SPDX-License-Identifier: AGPL-3.0-or-later

import {effectiveRoomTheme} from '@app/features/voice_scene/utils/EffectiveRoomTheme';
import type {WebglSupport} from '@app/features/voice_scene/utils/WebglSupport';

export type RoomViewReason =
	| 'room'
	| 'flag_off'
	| 'no_theme'
	| 'mobile'
	| 'no_webgl'
	| 'software_gpu'
	| 'weak_device'
	| 'user_flat'
	| 'context_lost'
	| 'load_failed';

export interface RoomViewInput {
	channelType: number;
	rooms: boolean;
	theme: string | null | undefined;
	defaultTheme?: string | null;
	isMobileLayout: boolean;
	webgl: WebglSupport;
	preferRoom: boolean;
	contextLost: boolean;
	loadFailed: boolean;
}

export interface RoomView {
	show: boolean;
	reason: RoomViewReason;
}

// Electron with GPU acceleration off lands on SwiftShader; Linux without a driver on llvmpipe.
const SOFTWARE_GPU = /swiftshader|llvmpipe|software|microsoft basic render/i;
const WEAK_DEVICE_LIMIT = 2;

function flatReason(input: RoomViewInput): Exclude<RoomViewReason, 'room'> | null {
	if (!input.rooms) return 'flag_off';
	if (!effectiveRoomTheme(input.theme, input.defaultTheme, input.channelType)) return 'no_theme';
	if (input.isMobileLayout) return 'mobile';
	const {webgl} = input;
	if (!webgl.webgl2) return 'no_webgl';
	if (webgl.renderer && SOFTWARE_GPU.test(webgl.renderer)) return 'software_gpu';
	if (
		(webgl.hardwareConcurrency ?? Infinity) <= WEAK_DEVICE_LIMIT ||
		(webgl.deviceMemory ?? Infinity) <= WEAK_DEVICE_LIMIT
	)
		return 'weak_device';
	if (!input.preferRoom) return 'user_flat';
	if (input.contextLost) return 'context_lost';
	if (input.loadFailed) return 'load_failed';
	return null;
}

export function resolveRoomView(input: RoomViewInput): RoomView {
	const reason = flatReason(input);
	return reason ? {show: false, reason} : {show: true, reason: 'room'};
}
