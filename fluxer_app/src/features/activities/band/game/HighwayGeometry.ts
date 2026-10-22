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
	return planeLayout({
		width,
		height,
		scale,
		frameLeft: offsetX,
		frameTop: offsetY,
		originX: offsetX + (DESIGN_WIDTH / 2) * scale,
		nearY: offsetY + (REGION_TOP + REGION_HEIGHT) * scale,
		highways,
	});
}

// Every measure of the plane follows `scale`, as the design's 480 px region sets them; the near edge sits at `nearY`
// and the vanishing point above `originX`.
function planeLayout({
	width,
	height,
	scale,
	frameLeft,
	frameTop,
	originX,
	nearY,
	highways,
}: {
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly frameLeft: number;
	readonly frameTop: number;
	readonly originX: number;
	readonly nearY: number;
	readonly highways: ReadonlyArray<HighwayLayout>;
}): StageLayout {
	const tilt = (TILT_DEG * Math.PI) / 180;
	return {
		width,
		height,
		scale,
		frameLeft,
		frameTop,
		originX,
		regionTop: nearY - REGION_HEIGHT * scale,
		regionHeight: REGION_HEIGHT * scale,
		planeLength: PLANE_LENGTH * scale,
		perspective: PERSPECTIVE * scale,
		cosTilt: Math.cos(tilt),
		sinTilt: Math.sin(tilt),
		highways,
	};
}

// Focus view: my highway large in the middle, everyone else's smaller on the sides. Laid out on a frame 880 design px
// tall and as wide as the stage allows (at least FOCUS_MIN_WIDTH), so wide stages give the side highways more room.
export const FOCUS_HEIGHT = 880;
const FOCUS_MIN_WIDTH = 1100;
const FOCUS_HEADER_HEIGHT = 72;
const FOCUS_LYRICS_HEIGHT = 56;
const FOCUS_MAIN_NEAR = 770;
const FOCUS_HUD_GAP = 18;
const FOCUS_HUD_HEIGHT = 60;
const FOCUS_MAIN_SHARE = 0.42;
const FOCUS_MAIN_MIN = 440;
const FOCUS_MAIN_MAX = 640;
// With one other player my highway moves left of centre and theirs takes the right, bigger and clearer.
const FOCUS_PAIR_CENTER = 0.44;
const FOCUS_SIDE_MARGIN = 40;
const FOCUS_SIDE_GAP = 56;
const FOCUS_SIDE_HIGHWAY_GAP = 20;
const FOCUS_SIDE_MIN_AREA = 140;
const FOCUS_SIDE_WIDTH = {pair: 380, single: 300, double: 210} as const;
// Side highways start lower and end a little above mine, so they read as further back.
const FOCUS_SIDE_DROP = {pair: 70, other: 120} as const;
const FOCUS_SIDE_NEAR = {pair: 752, other: 736} as const;
const FOCUS_SIDE_LABEL_GAP = 12;
// Room around a side highway's plane inside its canvas, for sparkles over the far end and gems at the near edge.
const FOCUS_SIDE_PAD_TOP = 24;
const FOCUS_SIDE_PAD_BOTTOM = 28;
const FOCUS_VOCAL_HEIGHT = 220;
// Below this stage size (the mini window, a call tile) only my own part shows, without header or side highways.
export const FOCUS_COMPACT_WIDTH = 640;
export const FOCUS_COMPACT_HEIGHT = 400;
const FOCUS_COMPACT_TOP = 40;
const FOCUS_COMPACT_NEAR = 840;
const FOCUS_COMPACT_SHARE = 0.62;
const FOCUS_COMPACT_MAX = 900;
// Gems grow with the lane up to this factor; wider lanes than that keep their gems and gain space between them.
const FOCUS_NOTE_SCALE_MAX = 1.55;
const DESIGN_LANE: Readonly<Record<HighwayKind, number>> = {
	frets: FRET_HIGHWAY_WIDTH / 5,
	drums: DRUM_HIGHWAY_WIDTH / 4,
};

// Design px of the focus frame.
export interface FocusRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface FocusSide {
	readonly side: 'left' | 'right';
	// Where the side's canvas sits, design px.
	readonly rect: FocusRect;
	// Inside that canvas, canvas px (at scale, before any resolution reduction).
	readonly layout: StageLayout;
	// Index of each drawn highway in the `others` given to layoutFocus.
	readonly others: ReadonlyArray<number>;
	// Name tag under each highway, design px; same order as `others`.
	readonly labels: ReadonlyArray<FocusRect>;
	// The only other player: bigger and less dimmed.
	readonly pair: boolean;
}

export interface FocusLayout {
	readonly width: number;
	readonly height: number;
	// Canvas px per design px; the frame starts at the stage's top-left corner.
	readonly scale: number;
	readonly frameWidth: number;
	readonly compact: boolean;
	// My highway on the stage-size canvas; null when I sing and the middle is the vocal lane.
	readonly main: StageLayout | null;
	// My highway's near edge, or the vocal lane, design px; the HUD lines up under it.
	readonly mainRect: FocusRect;
	readonly vocalLane: FocusRect | null;
	// The thin lyrics strip over everything, when someone else sings.
	readonly lyrics: FocusRect | null;
	readonly hud: FocusRect | null;
	readonly sides: ReadonlyArray<FocusSide>;
}

export interface FocusInput {
	// My highway's kind, or null when I am the singer.
	readonly mine: HighwayKind | null;
	readonly others: ReadonlyArray<HighwayKind>;
	// Someone else sings: the lyrics run along the top.
	readonly lyrics: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function noteScaleFor(kind: HighwayKind, widthPx: number, planeScale: number): number {
	const lanes = kind === 'drums' ? 4 : 5;
	return clamp(widthPx / lanes / (DESIGN_LANE[kind] * planeScale), 0.5, FOCUS_NOTE_SCALE_MAX);
}

// Others split between the sides, the extra one to the right: 1 -> 0+1, 2 -> 1+1, 3 -> 1+2, 4 -> 2+2.
export function splitSides(count: number): {readonly left: number; readonly right: number} {
	const left = Math.floor(count / 2);
	return {left, right: count - left};
}

export function layoutFocus(width: number, height: number, input: FocusInput): FocusLayout {
	const compact = width < FOCUS_COMPACT_WIDTH || height < FOCUS_COMPACT_HEIGHT;
	const scale = Math.max(
		0.01,
		Math.min(height / FOCUS_HEIGHT, compact ? Number.POSITIVE_INFINITY : width / FOCUS_MIN_WIDTH),
	);
	const frameWidth = width / scale;
	const pair = !compact && input.others.length === 1;
	const lyrics = input.lyrics && !compact && input.mine !== null;
	const mainTop = compact ? FOCUS_COMPACT_TOP : FOCUS_HEADER_HEIGHT + (lyrics ? FOCUS_LYRICS_HEIGHT + 20 : 32);
	const mainNear = compact ? FOCUS_COMPACT_NEAR : FOCUS_MAIN_NEAR;
	const centerX = frameWidth * (pair ? FOCUS_PAIR_CENTER : 0.5);

	// The singer's vocal lane takes the place and width of a highway, so the sides keep the same room.
	const mainWidth = compact
		? clamp(frameWidth * FOCUS_COMPACT_SHARE, FOCUS_MAIN_MIN, FOCUS_COMPACT_MAX)
		: clamp(frameWidth * FOCUS_MAIN_SHARE, FOCUS_MAIN_MIN, FOCUS_MAIN_MAX);
	const mainLeft = centerX - mainWidth / 2;
	const mainRect: FocusRect = {left: mainLeft, top: mainTop, width: mainWidth, height: mainNear - mainTop};
	const planeScale = ((mainNear - mainTop) * scale) / REGION_HEIGHT;
	const main =
		input.mine === null
			? null
			: planeLayout({
					width,
					height,
					scale: planeScale,
					frameLeft: 0,
					frameTop: 0,
					originX: centerX * scale,
					nearY: mainNear * scale,
					highways: [
						{
							kind: input.mine,
							lanes: input.mine === 'drums' ? 4 : 5,
							left: mainLeft * scale,
							width: mainWidth * scale,
							noteScale: noteScaleFor(input.mine, mainWidth * scale, planeScale),
						},
					],
				});
	const vocalLane =
		input.mine === null
			? {
					left: mainLeft,
					top: (mainTop + mainNear - FOCUS_VOCAL_HEIGHT) / 2,
					width: mainWidth,
					height: FOCUS_VOCAL_HEIGHT,
				}
			: null;

	const sides: Array<FocusSide> = [];
	if (!compact && input.others.length > 0) {
		const {left: leftCount, right: rightCount} = splitSides(input.others.length);
		const areas = {
			left: {from: FOCUS_SIDE_MARGIN, to: mainLeft - FOCUS_SIDE_GAP},
			right: {from: mainLeft + mainWidth + FOCUS_SIDE_GAP, to: frameWidth - FOCUS_SIDE_MARGIN},
		};
		const placements: ReadonlyArray<readonly ['left' | 'right', ReadonlyArray<number>]> = [
			['left', Array.from({length: leftCount}, (_, index) => index)],
			['right', Array.from({length: rightCount}, (_, index) => leftCount + index)],
		];
		for (const [side, others] of placements) {
			const area = areas[side];
			const room = area.to - area.from;
			if (others.length === 0 || room < FOCUS_SIDE_MIN_AREA) continue;
			const cap = pair
				? FOCUS_SIDE_WIDTH.pair
				: others.length === 1
					? FOCUS_SIDE_WIDTH.single
					: FOCUS_SIDE_WIDTH.double;
			const each = Math.min(cap, (room - FOCUS_SIDE_HIGHWAY_GAP * (others.length - 1)) / others.length);
			const groupWidth = each * others.length + FOCUS_SIDE_HIGHWAY_GAP * (others.length - 1);
			const groupLeft = area.from + (room - groupWidth) / 2;
			const top = mainTop + (pair ? FOCUS_SIDE_DROP.pair : FOCUS_SIDE_DROP.other);
			const near = pair ? FOCUS_SIDE_NEAR.pair : FOCUS_SIDE_NEAR.other;
			const rect: FocusRect = {
				left: groupLeft - FOCUS_SIDE_HIGHWAY_GAP,
				top: top - FOCUS_SIDE_PAD_TOP,
				width: groupWidth + FOCUS_SIDE_HIGHWAY_GAP * 2,
				height: near - top + FOCUS_SIDE_PAD_TOP + FOCUS_SIDE_PAD_BOTTOM,
			};
			const sideScale = ((near - top) * scale) / REGION_HEIGHT;
			const highways = others.map((other, slot): HighwayLayout => {
				const kind = input.others[other];
				const left = (groupLeft - rect.left + slot * (each + FOCUS_SIDE_HIGHWAY_GAP)) * scale;
				return {
					kind,
					lanes: kind === 'drums' ? 4 : 5,
					left,
					width: each * scale,
					noteScale: noteScaleFor(kind, each * scale, sideScale),
				};
			});
			sides.push({
				side,
				rect,
				layout: planeLayout({
					width: rect.width * scale,
					height: rect.height * scale,
					scale: sideScale,
					frameLeft: 0,
					frameTop: 0,
					originX: (rect.width / 2) * scale,
					nearY: (near - rect.top) * scale,
					highways,
				}),
				others,
				labels: others.map((_, slot) => ({
					left: groupLeft + slot * (each + FOCUS_SIDE_HIGHWAY_GAP) - FOCUS_SIDE_HIGHWAY_GAP / 2,
					top: near + FOCUS_SIDE_LABEL_GAP,
					width: each + FOCUS_SIDE_HIGHWAY_GAP,
					height: FOCUS_HUD_HEIGHT - FOCUS_SIDE_LABEL_GAP,
				})),
				pair,
			});
		}
	}

	return {
		width,
		height,
		scale,
		frameWidth,
		compact,
		main,
		mainRect,
		vocalLane,
		lyrics: lyrics
			? {
					left: FOCUS_SIDE_MARGIN / 2,
					top: FOCUS_HEADER_HEIGHT,
					width: frameWidth - FOCUS_SIDE_MARGIN,
					height: FOCUS_LYRICS_HEIGHT,
				}
			: null,
		hud: compact ? null : {left: mainLeft, top: mainNear + FOCUS_HUD_GAP, width: mainWidth, height: FOCUS_HUD_HEIGHT},
		sides,
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
