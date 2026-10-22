// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	type Corner,
	clampWidth as clampPaneWidth,
	computeResize,
	type DragBounds,
	type FloatingPaneGeometry,
	getCornerPoint as getCornerOffset,
	getDragBounds as getPaneDragBounds,
	type Point,
	pickCornerForFling,
	type ResizeEdge,
	type ResizeStart,
} from '@app/features/ui/floating_pane';
import type {PiPContent, PiPContentType} from '@app/features/ui/state/PiP';
import type {SpringOptions} from 'framer-motion';
import type {Room} from 'livekit-client';

const EDGE_PADDING = 20;

// The window's proportions and width limits. A stream keeps its video's 16:9; the activity is played in the window,
// so it is taller, for its header, the game and the line under it.
export interface PiPShape {
	readonly aspectRatio: number;
	readonly minWidth: number;
	readonly maxWidth: number;
}

const PIP_SHAPES: Readonly<Record<PiPContentType, PiPShape>> = {
	stream: {aspectRatio: 16 / 9, minWidth: 240, maxWidth: 720},
	activity: {aspectRatio: 5 / 4, minWidth: 360, maxWidth: 720},
};

export function getPiPShape(type: PiPContentType): PiPShape {
	return PIP_SHAPES[type];
}

export type {Corner, ResizeEdge};

export interface CornerPosition {
	x: number;
	y: number;
}

export interface ResizeListeners {
	move: (event: PointerEvent) => void;
	up: (event: PointerEvent) => void;
}

export interface ResizeState {
	pointerId: number;
	edge: ResizeEdge;
	startX: number;
	startY: number;
	startWidth: number;
	startPosX: number;
	startPosY: number;
}

export const SNAP_SPRING: SpringOptions = {
	stiffness: 520,
	damping: 42,
	mass: 0.9,
	bounce: 0.35,
};
export const INTERACTION_SPRING: SpringOptions = {
	stiffness: 520,
	damping: 38,
	mass: 0.8,
};
export const pipOverlayLogger = new Logger('PiPOverlay');

function buildGeometry(
	shape: PiPShape,
	viewportWidth: number,
	viewportHeight: number,
	titlebarHeight: number,
): FloatingPaneGeometry {
	return {
		viewport: {width: viewportWidth, height: viewportHeight},
		edgePadding: EDGE_PADDING,
		topInset: titlebarHeight,
		aspectRatio: shape.aspectRatio,
		minWidth: shape.minWidth,
		maxWidth: shape.maxWidth,
	};
}

export function clampPiPWidth(shape: PiPShape, value: number, viewportWidth: number, viewportHeight: number): number {
	return clampPaneWidth(value, buildGeometry(shape, viewportWidth, viewportHeight, getTitlebarHeight()));
}

export function getTitlebarHeight(): number {
	if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
	const raw = getComputedStyle(document.documentElement).getPropertyValue('--native-titlebar-height').trim();
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function getDragBounds(
	shape: PiPShape,
	viewportWidth: number,
	viewportHeight: number,
	pipWidth: number,
	titlebarHeight = getTitlebarHeight(),
): DragBounds {
	return getPaneDragBounds(buildGeometry(shape, viewportWidth, viewportHeight, titlebarHeight), pipWidth);
}

export function getCornerPositions(
	shape: PiPShape,
	viewportWidth: number,
	viewportHeight: number,
	pipWidth: number,
	titlebarHeight = getTitlebarHeight(),
): Record<Corner, CornerPosition> {
	const bounds = getPaneDragBounds(buildGeometry(shape, viewportWidth, viewportHeight, titlebarHeight), pipWidth);
	return {
		'top-left': getCornerOffset('top-left', bounds),
		'top-right': getCornerOffset('top-right', bounds),
		'bottom-right': getCornerOffset('bottom-right', bounds),
		'bottom-left': getCornerOffset('bottom-left', bounds),
	};
}

export function pickCornerOnRelease(
	currentX: number,
	currentY: number,
	velocityX: number,
	velocityY: number,
	_corners: Record<Corner, CornerPosition>,
	bounds: DragBounds,
): Corner {
	return pickCornerForFling({x: currentX, y: currentY}, {x: velocityX, y: velocityY}, bounds, {
		lookaheadSeconds: 0.25,
		strongVelocity: 550,
		axisVelocityFloor: 180,
	});
}

export function computePiPResize(
	shape: PiPShape,
	state: ResizeState,
	pointerX: number,
	pointerY: number,
	viewportWidth: number,
	viewportHeight: number,
	titlebarHeight = getTitlebarHeight(),
): {width: number; offset: Point} {
	const start: ResizeStart = {
		edge: state.edge,
		startWidth: state.startWidth,
		pointerStartX: state.startX,
		pointerStartY: state.startY,
		paneStartX: state.startPosX,
		paneStartY: state.startPosY,
	};
	return computeResize(start, pointerX, pointerY, buildGeometry(shape, viewportWidth, viewportHeight, titlebarHeight));
}

export interface PiPOverlayInnerProps {
	content: PiPContent;
	room: Room | null;
}
