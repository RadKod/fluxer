// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DesktopGameOverlayCorner, DesktopGameOverlayLayout} from '@electron/common/Types';

interface GameOverlayRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const GAME_OVERLAY_MARGIN = 16;
const GAME_OVERLAY_MIN_SIZE = 32;
const GAME_OVERLAY_MAX_WIDTH = 360;
const GAME_OVERLAY_MAX_HEIGHT = 720;
const GAME_OVERLAY_LAYOUT_KEYS = new Set(['visible', 'corner', 'width', 'height']);
const GAME_OVERLAY_CORNERS = new Set<string>(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

function clampSize(value: number, max: number): number {
	return Math.min(max, Math.max(GAME_OVERLAY_MIN_SIZE, Math.round(value)));
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeGameOverlayLayout(raw: unknown): DesktopGameOverlayLayout | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const keys = Object.keys(raw);
	if (keys.length !== GAME_OVERLAY_LAYOUT_KEYS.size || !keys.every((key) => GAME_OVERLAY_LAYOUT_KEYS.has(key))) {
		return null;
	}
	const {visible, corner, width, height} = raw as Record<string, unknown>;
	if (typeof visible !== 'boolean' || typeof corner !== 'string' || !GAME_OVERLAY_CORNERS.has(corner)) {
		return null;
	}
	if (!isFiniteNumber(width) || !isFiniteNumber(height)) {
		return null;
	}
	return {
		visible,
		corner: corner as DesktopGameOverlayCorner,
		width: clampSize(width, GAME_OVERLAY_MAX_WIDTH),
		height: clampSize(height, GAME_OVERLAY_MAX_HEIGHT),
	};
}

export function computeGameOverlayBounds(
	displayBounds: GameOverlayRect,
	layout: DesktopGameOverlayLayout,
): GameOverlayRect {
	const width = Math.min(layout.width, displayBounds.width - 2 * GAME_OVERLAY_MARGIN);
	const height = Math.min(layout.height, displayBounds.height - 2 * GAME_OVERLAY_MARGIN);
	const x = layout.corner.endsWith('left')
		? displayBounds.x + GAME_OVERLAY_MARGIN
		: displayBounds.x + displayBounds.width - GAME_OVERLAY_MARGIN - width;
	const y = layout.corner.startsWith('top')
		? displayBounds.y + GAME_OVERLAY_MARGIN
		: displayBounds.y + displayBounds.height - GAME_OVERLAY_MARGIN - height;
	return {x, y, width, height};
}
