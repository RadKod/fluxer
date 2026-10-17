// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure geometry of the play screen, in canvas pixels. The approved design is laid out on a 930x742 game area; every
// measure here is a design pixel scaled to fit, so the canvas and the DOM overlays agree on where things are.
// A highway is a plane tilted back by TILT_DEG and seen through a perspective of PERSPECTIVE px from the top centre
// of the highway region, as the CSS mock-up did with rotateX(44deg) and perspective: 1400px.

export const DESIGN_WIDTH = 930;
export const DESIGN_HEIGHT = 742;
// Highway region: design y 196..676, then the player row under it.
const REGION_TOP = 196;
const REGION_HEIGHT = 480;
const PLANE_LENGTH = 640;
const PERSPECTIVE = 1400;
const TILT_DEG = 44;
const HIGHWAY_GAP = 32;
const FRET_HIGHWAY_WIDTH = 205;
const DRUM_HIGHWAY_WIDTH = 235;
// Gems keep their design size down to this fret lane width (four highways land just above it); in narrower lanes,
// with five highways, they shrink along so neighbours do not touch.
const FULL_SIZE_FRET_LANE = 36;
// Plane distance of the strikeline from the near edge, and where judgement text sits.
export const STRIKE_DISTANCE = 40;
export const FEEDBACK_DISTANCE = 96;
// The top of the plane fades out over this share of its length.
export const FADE_SHARE = 0.32;

export const LOOK_AHEAD_MS = 1_600;
// The last part of the plane stays empty so notes fade in rather than pop.
const TRAVEL_LENGTH = PLANE_LENGTH * (1 - FADE_SHARE / 2) - STRIKE_DISTANCE;

export type HighwayKind = 'frets' | 'drums';

export interface HighwayLayout {
	readonly kind: HighwayKind;
	// Lane count drawn on the surface: 5 for frets, 4 pads for drums (the kick spans them all).
	readonly lanes: number;
	// Near edge, canvas px.
	readonly left: number;
	readonly width: number;
	// Size factor for gems, pads and tails on top of the stage scale; 1 unless the lanes got too narrow.
	readonly noteScale: number;
}

export interface StageLayout {
	readonly width: number;
	readonly height: number;
	// Canvas px per design px.
	readonly scale: number;
	// Top-left of the 930x742 design frame in canvas px; DOM overlays live in that frame, scaled.
	readonly frameLeft: number;
	readonly frameTop: number;
	readonly originX: number;
	readonly regionTop: number;
	readonly regionHeight: number;
	readonly planeLength: number;
	readonly perspective: number;
	readonly cosTilt: number;
	readonly sinTilt: number;
	readonly highways: ReadonlyArray<HighwayLayout>;
}

export interface ProjectedPoint {
	readonly x: number;
	readonly y: number;
	// Size factor at that depth; 1 at the near edge.
	readonly scale: number;
}

export function layoutStage(width: number, height: number, kinds: ReadonlyArray<HighwayKind>): StageLayout {
	const scale = Math.max(0.01, Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT));
	const offsetX = (width - DESIGN_WIDTH * scale) / 2;
	const offsetY = height - DESIGN_HEIGHT * scale;
	const widths = kinds.map((kind) => (kind === 'drums' ? DRUM_HIGHWAY_WIDTH : FRET_HIGHWAY_WIDTH));
	const natural = widths.reduce((sum, w) => sum + w, 0) + HIGHWAY_GAP * Math.max(0, kinds.length - 1);
	// Four or five highways do not fit the design width; they shrink together, gaps included.
	const fit = Math.min(1, (DESIGN_WIDTH * 0.92) / Math.max(natural, 1));
	const noteScale = Math.min(1, ((FRET_HIGHWAY_WIDTH / 5) * fit) / FULL_SIZE_FRET_LANE);
	let cursor = (DESIGN_WIDTH - natural * fit) / 2;
	const highways = kinds.map((kind, index) => {
		const highway: HighwayLayout = {
			kind,
			lanes: kind === 'drums' ? 4 : 5,
			left: offsetX + cursor * scale,
			width: widths[index] * fit * scale,
			noteScale,
		};
		cursor += (widths[index] + HIGHWAY_GAP) * fit;
		return highway;
	});
	const tilt = (TILT_DEG * Math.PI) / 180;
	return {
		width,
		height,
		scale,
		frameLeft: offsetX,
		frameTop: offsetY,
		originX: offsetX + (DESIGN_WIDTH / 2) * scale,
		regionTop: offsetY + REGION_TOP * scale,
		regionHeight: REGION_HEIGHT * scale,
		planeLength: PLANE_LENGTH * scale,
		perspective: PERSPECTIVE * scale,
		cosTilt: Math.cos(tilt),
		sinTilt: Math.sin(tilt),
		highways,
	};
}

// `x` is a canvas x on the near edge; `distance` runs along the plane from the near edge, in canvas px.
export function project(layout: StageLayout, x: number, distance: number): ProjectedPoint {
	const scale = layout.perspective / (layout.perspective + distance * layout.sinTilt);
	return {
		x: layout.originX + (x - layout.originX) * scale,
		y: layout.regionTop + (layout.regionHeight - distance * layout.cosTilt) * scale,
		scale,
	};
}

// Plane distance of a note `deltaMs` ahead of now; negative deltas fall past the strikeline.
export function noteDistance(layout: StageLayout, deltaMs: number): number {
	return (STRIKE_DISTANCE + (deltaMs / LOOK_AHEAD_MS) * TRAVEL_LENGTH) * layout.scale;
}

export function strikeDistance(layout: StageLayout): number {
	return STRIKE_DISTANCE * layout.scale;
}

// Song time window that is visible on the highway at `nowMs`.
export function visibleWindow(nowMs: number): {readonly fromMs: number; readonly toMs: number} {
	const pastMs = (STRIKE_DISTANCE / TRAVEL_LENGTH) * LOOK_AHEAD_MS;
	const aheadMs = ((PLANE_LENGTH - STRIKE_DISTANCE) / TRAVEL_LENGTH) * LOOK_AHEAD_MS;
	return {fromMs: nowMs - pastMs, toMs: nowMs + aheadMs};
}

export function laneCenterX(highway: HighwayLayout, lane: number): number {
	const laneWidth = highway.width / highway.lanes;
	return highway.left + laneWidth * (lane + 0.5);
}

// Lane slot on the surface for a note lane: fret lanes map 1:1 (open spans the highway), drum pads 1..4 to 0..3,
// the kick (0) to null because it is drawn across the whole highway.
export function surfaceLane(kind: HighwayKind, lane: number): number | null {
	if (kind === 'frets') return lane;
	return lane === 0 ? null : lane - 1;
}

// Screen point where a highway's DOM overlays (multiplier badge, player row) are anchored.
export function highwayAnchor(layout: StageLayout, highway: HighwayLayout, distance: number): ProjectedPoint {
	return project(layout, highway.left + highway.width / 2, distance);
}

// Canvas px to design px of the overlay frame.
export function toFrame(layout: StageLayout, x: number, y: number): {readonly x: number; readonly y: number} {
	return {x: (x - layout.frameLeft) / layout.scale, y: (y - layout.frameTop) / layout.scale};
}
