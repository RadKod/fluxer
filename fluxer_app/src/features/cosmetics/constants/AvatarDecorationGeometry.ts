// SPDX-License-Identifier: AGPL-3.0-or-later

export const DECORATION_SCALE = 1.2;
// The scales were chosen on the 635.6 px preview canvas; the images use a 648.4 px canvas.
export const CANVAS_RATIO = 648.4 / 635.6;
export const ULTRA_BOX_SCALE = {
	compact: 2.3 * CANVAS_RATIO,
	voice: 3.2 * CANVAS_RATIO,
	profile: 3.4 * CANVAS_RATIO,
} as const;
export const FRONT_SCALE = 3.468;
