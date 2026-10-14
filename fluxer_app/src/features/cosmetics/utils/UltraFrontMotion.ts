// SPDX-License-Identifier: AGPL-3.0-or-later

// Frame stepping of an ultra decoration drawn in front. Each layer keeps its own state.
export interface UltraFrontMotion {
	frame: number;
	opening: boolean;
	looping: boolean;
}

export const FRONT_AT_REST: UltraFrontMotion = Object.freeze({frame: 0, opening: false, looping: false});
export const FRONT_FRAME_MS = 33; // 30 fps, the opening was cut at this rate (NOTLAR.md)

export function requestFront(state: UltraFrontMotion, open: boolean, lastFrame: number): UltraFrontMotion {
	if (open) return state.opening ? state : {...state, opening: true};
	if (!state.opening) return state;
	return {frame: state.looping ? lastFrame : state.frame, opening: false, looping: false};
}

export function stepFront(state: UltraFrontMotion, lastFrame: number): UltraFrontMotion {
	if (state.looping) return state;
	if (state.opening) return state.frame >= lastFrame ? {...state, looping: true} : {...state, frame: state.frame + 1};
	return state.frame > 0 ? {...state, frame: state.frame - 1} : state;
}

export function isFrontMoving(state: UltraFrontMotion): boolean {
	return !state.looping && (state.opening || state.frame > 0);
}
