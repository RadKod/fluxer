// SPDX-License-Identifier: AGPL-3.0-or-later

import {isFreePlayGroup, type PartFinale} from '@app/features/activities/band/engine/BigRockEnding';
import {DrumLane, FretLane, type NoteGroup} from '@app/features/activities/band/engine/ChartModel';
import {isFreestyleGroup, type SoloCue, type SoloCueRegion} from '@app/features/activities/band/engine/FreestyleSolo';
import {
	FADE_SHARE,
	FEEDBACK_DISTANCE,
	type HighwayLayout,
	LOOK_AHEAD_MS,
	laneCenterX,
	noteDistance,
	project,
	type StageLayout,
	strikeDistance,
	surfaceLane,
	visibleWindow,
} from '@app/features/activities/band/game/HighwayGeometry';
import {type FeedbackKind, NoteState, type SeatTrack} from '@app/features/activities/band/game/PlayController';
import {WHAMMY} from '@app/features/activities/band/game/Whammy';

// Brand and lane colours from the approved design tokens.
const COLOR = {
	night: '#0C0D0F',
	plum: '#B5179E',
	plumLight: '#D64BBF',
	paper: '#F7F5F0',
	green: '#36C25F',
	red: '#E8484F',
	yellow: '#F4CF1C',
	blue: '#3D8BFF',
	orange: '#FF8A2A',
} as const;
const FRET_COLORS = [COLOR.green, COLOR.red, COLOR.yellow, COLOR.blue, COLOR.orange];
// Drum pads left to right: red, yellow, blue, green.
const PAD_COLORS = [COLOR.red, COLOR.yellow, COLOR.blue, COLOR.green];

const SURFACE = 'rgba(22, 23, 29, 0.96)';
const STAR_SURFACE: ReadonlyArray<readonly [number, string]> = [
	[0, '#A3168F'],
	[0.3, '#6B0E5E'],
	[0.62, '#3A0833'],
	[1, '#1E0619'],
];

const GLOW_MS = 260;
const TARGET_FLASH_MS = 180;
// Big Rock Ending lanes: a bar per lane in its colour, brightening on each press.
const FINALE_FLASH_MS = 420;
const FINALE_BAR_SHARE = 0.62;
const FINALE_BAR_ALPHA = 0.34;
const FINALE_FLASH_ALPHA = 0.56;
const MISS_DIM_MS = 650;
// Sparkles out of a target box: a burst on every hit and a steady stream while a sustain is held.
const SPARK_BURST_MS = 460;
const SPARK_BURST_COUNT = 11;
const SPARK_STREAM_EVERY_MS = 40;
const SPARK_STREAM_LIFE_MS = 380;
const SPARK_GRAVITY = 520;
const FEEDBACK_MS = 700;
// Side highways in the focus view are blurred and dimmed, so a miss there also jolts the highway sideways.
const SHAKE_MS = 320;
const SHAKE_PX = 7;
const SHAKE_HZ = 22;
// Sustains are drawn from their start; longer ones than this are rare enough to clip.
const LONGEST_SUSTAIN_MS = 8_000;
// Freestyle solo cues, Rock Band 4 style: a band over the right-hand lanes in blue or the left-hand ones in orange
// (free play spans the highway in plum), filled solid for a held note, striped for fast playing, dotted for tapping
// and starred for free play. Stripes, dots and stars sit at fixed song times, so they travel with the highway.
const CUE_COLORS: Readonly<Record<SoloCueRegion, string>> = {high: COLOR.blue, low: COLOR.orange};
const CUE_INSET_SHARE = 0.08;
const CUE_FILL_ALPHA = 0.2;
const CUE_SUSTAIN_ALPHA = 0.46;
const CUE_STRIPE_MS = 120;
const CUE_STRIPE_SHARE = 0.4;
const CUE_DOT_MS = 120;
const CUE_STAR_MS = 45;
// A whammied tail sways side to side, this many design pixels at full depth, and glows; it settles over the
// whammy's release.
const WHAMMY_SWAY_PX = 7;
const WHAMMY_WAVE_PX = 64;
const WHAMMY_STEP_PX = 6;

const GEM_RADIUS = 16;
const PAD_WIDTH = 48;
const PAD_HEIGHT = 18;
const KICK_HEIGHT = 12;
const TAIL_WIDTH = 9;
const GEM_SQUASH = 0.84;

interface WhammySway {
	readonly strength: number;
	readonly phase: number;
}

export interface HighwayFrame {
	readonly nowMs: number;
	readonly tracks: ReadonlyArray<SeatTrack>;
	readonly reducedMotion: boolean;
	readonly feedbackLabels: Readonly<Record<FeedbackKind, string>>;
	readonly fontFamily: string;
}

// First group that can still be on screen at `fromMs`, by binary search over sorted note times.
export function firstVisibleGroup(groups: ReadonlyArray<NoteGroup>, fromMs: number): number {
	const target = fromMs - LONGEST_SUSTAIN_MS;
	let low = 0;
	let high = groups.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (groups[middle].msTime < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

// Deterministic 0..1 from an integer, so a sparkle looks the same on every frame of its life.
export function hash(n: number): number {
	const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

// Linear 1 -> 0 over `durationMs` after `atMs`; 0 outside.
export function fadeAfter(nowMs: number, atMs: number, durationMs: number): number {
	const elapsed = nowMs - atMs;
	if (elapsed < 0 || elapsed >= durationMs) return 0;
	return 1 - elapsed / durationMs;
}

function laneColor(highway: HighwayLayout, lane: number): string {
	if (highway.kind === 'drums') return lane === DrumLane.Kick ? COLOR.orange : PAD_COLORS[lane - 1];
	return lane === FretLane.Open ? COLOR.plumLight : FRET_COLORS[lane];
}

function surfaceLaneColor(highway: HighwayLayout, slot: number): string {
	return highway.kind === 'drums' ? PAD_COLORS[slot] : FRET_COLORS[slot];
}

// Sideways offset of a highway `sinceMissMs` after a miss: a fast decaying wobble, 0 once it settles.
export function missShake(sinceMissMs: number): number {
	if (sinceMissMs < 0 || sinceMissMs >= SHAKE_MS) return 0;
	const decay = 1 - sinceMissMs / SHAKE_MS;
	return Math.sin((sinceMissMs / 1000) * SHAKE_HZ * 2 * Math.PI) * SHAKE_PX * decay * decay;
}

export interface HighwayRendererOptions {
	readonly shakeOnMiss?: boolean;
}

// Draws every highway of the stage onto one 2D canvas. Holds no game state; each frame is drawn from `HighwayFrame`.
export class HighwayRenderer {
	private layout: StageLayout | null = null;
	private readonly shakeOnMiss: boolean;

	constructor(
		private readonly ctx: CanvasRenderingContext2D,
		{shakeOnMiss = false}: HighwayRendererOptions = {},
	) {
		this.shakeOnMiss = shakeOnMiss;
	}

	setLayout(layout: StageLayout): void {
		this.layout = layout;
	}

	draw(frame: HighwayFrame): void {
		const {ctx, layout} = this;
		if (!layout) return;
		ctx.clearRect(0, 0, layout.width, layout.height);
		layout.highways.forEach((highway, index) => {
			const track = frame.tracks[index];
			if (track) this.shaken(layout, track, frame, () => this.drawHighway(layout, highway, track, frame));
		});
		this.fadeFarEnd(layout);
		layout.highways.forEach((highway, index) => {
			const track = frame.tracks[index];
			if (track) this.shaken(layout, track, frame, () => this.drawFeedback(layout, highway, track, frame));
		});
	}

	private shaken(layout: StageLayout, track: SeatTrack, frame: HighwayFrame, draw: () => void): void {
		const offset = this.shakeOnMiss && !frame.reducedMotion ? missShake(frame.nowMs - track.missAtMs) : 0;
		if (offset === 0) {
			draw();
			return;
		}
		const {ctx} = this;
		ctx.save();
		ctx.translate(offset * layout.scale, 0);
		draw();
		ctx.restore();
	}

	private drawHighway(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {ctx} = this;
		const {nowMs} = frame;
		const {finale} = track;
		const finaleOn = track.hud.finaleOn;
		const starOn = track.hud.starPowerActive;
		this.surface(layout, highway, starOn ? STAR_SURFACE : null);
		this.grid(layout, highway, nowMs, starOn ? 0.09 : 0.045);
		this.laneLines(layout, highway, starOn ? 0.12 : 0.06);
		if (finale) this.finaleLanes(layout, highway, track, finale, nowMs);
		if (track.freestyle.length > 0) this.soloCues(layout, highway, track, nowMs, frame.reducedMotion);
		if (!finaleOn) this.glows(layout, highway, track, nowMs);
		const railPulse = finaleOn && !frame.reducedMotion ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(nowMs / 80)) : 1;
		this.rails(layout, highway, starOn ? COLOR.paper : COLOR.plum, railPulse);
		this.strikeline(layout, highway);
		this.targets(layout, highway, track, nowMs, finaleOn);
		if (finale) this.finalBar(layout, highway, track, finale, nowMs, frame.reducedMotion);
		this.notes(layout, highway, track, frame);
		if (!frame.reducedMotion) this.sparkles(layout, highway, track, nowMs);
		const dim = fadeAfter(nowMs, track.missAtMs, MISS_DIM_MS);
		if (dim > 0) {
			ctx.save();
			ctx.globalAlpha = 0.58 * dim;
			ctx.fillStyle = '#050506';
			this.trapezoid(layout, highway, 0, layout.planeLength);
			ctx.fill();
			ctx.restore();
		}
	}

	private trapezoid(layout: StageLayout, highway: HighwayLayout, near: number, far: number, x0?: number, x1?: number) {
		const left = x0 ?? highway.left;
		const right = x1 ?? highway.left + highway.width;
		const a = project(layout, left, near);
		const b = project(layout, right, near);
		const c = project(layout, right, far);
		const d = project(layout, left, far);
		const {ctx} = this;
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.lineTo(c.x, c.y);
		ctx.lineTo(d.x, d.y);
		ctx.closePath();
		return {near: a.y, far: d.y};
	}

	private surface(
		layout: StageLayout,
		highway: HighwayLayout,
		stops: ReadonlyArray<readonly [number, string]> | null,
	): void {
		const {ctx} = this;
		const {near, far} = this.trapezoid(layout, highway, 0, layout.planeLength);
		if (stops) {
			const gradient = ctx.createLinearGradient(0, near, 0, far);
			for (const [offset, color] of stops) gradient.addColorStop(offset, color);
			ctx.fillStyle = gradient;
		} else {
			ctx.fillStyle = SURFACE;
		}
		ctx.fill();
	}

	// The brand's rounded-square texture, one square per lane width, scrolling with the notes.
	private grid(layout: StageLayout, highway: HighwayLayout, nowMs: number, opacity: number): void {
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		const speed = noteDistance(layout, LOOK_AHEAD_MS) - strikeDistance(layout);
		const scroll = ((((nowMs / LOOK_AHEAD_MS) * speed) % cell) + cell) % cell;
		const inset = cell * (12.5 / 41);
		const size = cell * (16 / 41);
		ctx.save();
		ctx.strokeStyle = `rgba(247, 245, 240, ${opacity})`;
		ctx.lineWidth = Math.max(0.75, 1.2 * layout.scale);
		ctx.beginPath();
		for (let row = -1; row * cell < layout.planeLength; row++) {
			const near = row * cell - scroll + inset;
			const far = near + size;
			if (far < 0 || near > layout.planeLength) continue;
			for (let lane = 0; lane < highway.lanes; lane++) {
				const x0 = highway.left + lane * cell + inset;
				const a = project(layout, x0, near);
				const b = project(layout, x0 + size, near);
				const c = project(layout, x0 + size, far);
				const d = project(layout, x0, far);
				ctx.moveTo(a.x, a.y);
				ctx.lineTo(b.x, b.y);
				ctx.lineTo(c.x, c.y);
				ctx.lineTo(d.x, d.y);
				ctx.closePath();
			}
		}
		ctx.stroke();
		ctx.restore();
	}

	private laneLines(layout: StageLayout, highway: HighwayLayout, opacity: number): void {
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		ctx.save();
		ctx.strokeStyle = `rgba(247, 245, 240, ${opacity})`;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let lane = 1; lane < highway.lanes; lane++) {
			const x = highway.left + lane * cell;
			const a = project(layout, x, 0);
			const b = project(layout, x, layout.planeLength);
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
		}
		ctx.stroke();
		ctx.restore();
	}

	private rails(layout: StageLayout, highway: HighwayLayout, color: string, alpha: number): void {
		const {ctx} = this;
		const width = 3 * layout.scale;
		for (const x of [highway.left, highway.left + highway.width]) {
			const near = project(layout, x, 0);
			const far = project(layout, x, layout.planeLength);
			const gradient = ctx.createLinearGradient(0, near.y, 0, far.y);
			gradient.addColorStop(0, color);
			gradient.addColorStop(1, color === COLOR.paper ? 'rgba(247, 245, 240, 0.25)' : 'rgba(181, 23, 158, 0.35)');
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.strokeStyle = gradient;
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(near.x, near.y);
			ctx.lineTo(far.x, far.y);
			ctx.stroke();
			ctx.restore();
		}
	}

	private strikeline(layout: StageLayout, highway: HighwayLayout): void {
		const {ctx} = this;
		const distance = strikeDistance(layout);
		const a = project(layout, highway.left, distance);
		const b = project(layout, highway.left + highway.width, distance);
		ctx.save();
		ctx.strokeStyle = 'rgba(247, 245, 240, 0.55)';
		ctx.lineWidth = 2 * layout.scale;
		ctx.shadowColor = 'rgba(181, 23, 158, 0.55)';
		ctx.shadowBlur = 14 * layout.scale;
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		ctx.restore();
	}

	private glows(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, nowMs: number): void {
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		for (let slot = 0; slot < highway.lanes; slot++) {
			const lane = highway.kind === 'drums' ? slot + 1 : slot;
			const strength = fadeAfter(nowMs, track.laneFlashMs[lane], GLOW_MS);
			if (strength <= 0) continue;
			const x0 = highway.left + slot * cell + cell * 0.06;
			const x1 = highway.left + (slot + 1) * cell - cell * 0.06;
			const near = 40 * layout.scale;
			const {near: y0, far: y1} = this.trapezoid(layout, highway, near, near + 120 * layout.scale, x0, x1);
			const gradient = ctx.createLinearGradient(0, y0, 0, y1);
			gradient.addColorStop(0, surfaceLaneColor(highway, slot));
			gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
			ctx.save();
			ctx.globalAlpha = 0.8 * strength;
			ctx.fillStyle = gradient;
			ctx.fill();
			ctx.restore();
		}
	}

	// Free play: from the start of the lanes to their end, every lane is one solid bar in its colour, coming down the
	// highway like a long note. A press lights its bar up; on drums the kick lights all four.
	private finaleLanes(
		layout: StageLayout,
		highway: HighwayLayout,
		track: SeatTrack,
		finale: PartFinale,
		nowMs: number,
	): void {
		const near = Math.max(0, noteDistance(layout, finale.startMs - nowMs));
		const far = Math.min(layout.planeLength, noteDistance(layout, finale.endMs - nowMs));
		if (far <= near) return;
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		const half = (cell * FINALE_BAR_SHARE) / 2;
		const kick = highway.kind === 'drums' ? fadeAfter(nowMs, track.laneFlashMs[DrumLane.Kick], FINALE_FLASH_MS) : 0;
		for (let slot = 0; slot < highway.lanes; slot++) {
			const lane = highway.kind === 'drums' ? slot + 1 : slot;
			const flash = Math.max(fadeAfter(nowMs, track.laneFlashMs[lane], FINALE_FLASH_MS), kick * 0.6);
			const color = surfaceLaneColor(highway, slot);
			const x = laneCenterX(highway, slot);
			ctx.save();
			this.trapezoid(layout, highway, near, far, x - half, x + half);
			ctx.shadowColor = color;
			ctx.shadowBlur = (10 + 14 * flash) * layout.scale;
			ctx.globalAlpha = FINALE_BAR_ALPHA + FINALE_FLASH_ALPHA * flash;
			ctx.fillStyle = color;
			ctx.fill();
			ctx.shadowBlur = 0;
			ctx.globalAlpha = 0.9;
			ctx.lineWidth = 1.5 * layout.scale;
			ctx.strokeStyle = color;
			ctx.stroke();
			// A paper core down the middle reads as light inside the bar rather than paint on the highway.
			const core = half * 0.22;
			this.trapezoid(layout, highway, near, far, x - core, x + core);
			ctx.globalAlpha = 0.18 + 0.5 * flash;
			ctx.fillStyle = COLOR.paper;
			ctx.fill();
			ctx.restore();
		}
	}

	private soloCues(
		layout: StageLayout,
		highway: HighwayLayout,
		track: SeatTrack,
		nowMs: number,
		reducedMotion: boolean,
	): void {
		const {fromMs, toMs} = visibleWindow(nowMs);
		for (const section of track.freestyle) {
			if (section.endMs < fromMs || section.startMs > toMs) continue;
			for (const cue of section.cues) {
				if (cue.endMs < fromMs || cue.startMs > toMs) continue;
				this.soloCue(layout, highway, cue, nowMs, fromMs, reducedMotion);
			}
		}
	}

	private soloCue(
		layout: StageLayout,
		highway: HighwayLayout,
		cue: SoloCue,
		nowMs: number,
		fromMs: number,
		reducedMotion: boolean,
	): void {
		const near = Math.max(0, noteDistance(layout, cue.startMs - nowMs));
		const far = Math.min(layout.planeLength, noteDistance(layout, cue.endMs - nowMs));
		if (far <= near) return;
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		const firstLane = cue.region === 'high' ? 2 : 0;
		const lanes = cue.region === null ? highway.lanes : 3;
		const inset = cell * CUE_INSET_SHARE;
		const x0 = highway.left + firstLane * cell + inset;
		const x1 = highway.left + (firstLane + lanes) * cell - inset;
		const color = cue.region ? CUE_COLORS[cue.region] : COLOR.plum;
		ctx.save();
		this.trapezoid(layout, highway, near, far, x0, x1);
		ctx.globalAlpha = cue.style === 'sustain' ? CUE_SUSTAIN_ALPHA : CUE_FILL_ALPHA;
		ctx.fillStyle = color;
		ctx.fill();
		ctx.globalAlpha = 0.85;
		ctx.lineWidth = 1.5 * layout.scale;
		ctx.strokeStyle = color;
		ctx.stroke();
		const at = (stepMs: number, draw: (distance: number, timeMs: number) => void) => {
			const first = cue.startMs + Math.max(0, Math.ceil((fromMs - cue.startMs) / stepMs)) * stepMs;
			for (let timeMs = first; timeMs < cue.endMs; timeMs += stepMs) {
				const distance = noteDistance(layout, timeMs - nowMs);
				if (distance > far) break;
				if (distance >= near) draw(distance, timeMs);
			}
		};
		switch (cue.style) {
			case 'sustain': {
				const centre = (x0 + x1) / 2;
				const core = (x1 - x0) * 0.08;
				this.trapezoid(layout, highway, near, far, centre - core, centre + core);
				ctx.globalAlpha = 0.6;
				ctx.fillStyle = COLOR.paper;
				ctx.fill();
				break;
			}
			case 'strum': {
				ctx.globalAlpha = 0.8;
				ctx.fillStyle = color;
				const stripe = noteDistance(layout, CUE_STRIPE_MS * CUE_STRIPE_SHARE) - noteDistance(layout, 0);
				at(CUE_STRIPE_MS, (distance) => {
					this.trapezoid(layout, highway, distance, Math.min(far, distance + stripe), x0, x1);
					ctx.fill();
				});
				break;
			}
			case 'tap': {
				ctx.globalAlpha = 0.9;
				ctx.fillStyle = COLOR.paper;
				at(CUE_DOT_MS, (distance) => {
					for (let lane = firstLane; lane < firstLane + lanes; lane++) {
						const point = project(layout, laneCenterX(highway, lane), distance);
						const r = 3.2 * layout.scale * point.scale * highway.noteScale;
						ctx.beginPath();
						ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
						ctx.fill();
					}
				});
				break;
			}
			case 'free': {
				ctx.fillStyle = COLOR.paper;
				at(CUE_STAR_MS, (distance, timeMs) => {
					const seed = hash(timeMs);
					const point = project(layout, x0 + (x1 - x0) * seed, distance);
					const size = (1.6 + 2.6 * hash(timeMs * 3 + 1)) * layout.scale * point.scale * highway.noteScale;
					const twinkle = reducedMotion ? 0.8 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(nowMs / 140 + seed * 12));
					ctx.globalAlpha = twinkle;
					ctx.beginPath();
					ctx.moveTo(point.x, point.y - size * 1.8);
					ctx.lineTo(point.x + size * 0.45, point.y);
					ctx.lineTo(point.x, point.y + size * 1.8);
					ctx.lineTo(point.x - size * 0.45, point.y);
					ctx.closePath();
					ctx.moveTo(point.x - size * 1.8, point.y);
					ctx.lineTo(point.x, point.y + size * 0.45);
					ctx.lineTo(point.x + size * 1.8, point.y);
					ctx.lineTo(point.x, point.y - size * 0.45);
					ctx.closePath();
					ctx.fill();
				});
				break;
			}
		}
		ctx.restore();
	}

	private targets(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, nowMs: number, finaleOn: boolean) {
		const {ctx} = this;
		const distance = strikeDistance(layout);
		for (let slot = 0; slot < highway.lanes; slot++) {
			const lane = highway.kind === 'drums' ? slot + 1 : slot;
			const color = surfaceLaneColor(highway, slot);
			const point = project(layout, laneCenterX(highway, slot), distance);
			const s = layout.scale * point.scale * highway.noteScale;
			const flash = fadeAfter(nowMs, track.laneFlashMs[lane], TARGET_FLASH_MS);
			ctx.save();
			ctx.lineWidth = 3 * s;
			ctx.strokeStyle = color;
			ctx.fillStyle = finaleOn ? 'rgba(12, 13, 15, 0.5)' : 'rgba(12, 13, 15, 0.85)';
			ctx.beginPath();
			if (highway.kind === 'drums') {
				ctx.roundRect(
					point.x - (PAD_WIDTH / 2) * s,
					point.y - (PAD_HEIGHT / 2) * s,
					PAD_WIDTH * s,
					PAD_HEIGHT * s,
					6 * s,
				);
			} else {
				ctx.ellipse(point.x, point.y, GEM_RADIUS * s, GEM_RADIUS * s * GEM_SQUASH, 0, 0, Math.PI * 2);
			}
			ctx.fill();
			if (flash > 0) {
				ctx.globalAlpha = flash;
				ctx.fillStyle = color;
				ctx.fill();
				ctx.globalAlpha = 1;
			}
			ctx.stroke();
			ctx.restore();
		}
	}

	// Lane slots whose note is being held right now (a hit sustain that has not run out).
	private heldSlots(highway: HighwayLayout, track: SeatTrack, nowMs: number): Set<number> {
		const held = new Set<number>();
		const {groups} = track.chart;
		for (let index = firstVisibleGroup(groups, nowMs); index < groups.length; index++) {
			const group = groups[index];
			if (group.msTime > nowMs) break;
			if (track.noteStates[index] !== NoteState.Hit || track.heldUntilMs[index] <= nowMs) continue;
			for (const lane of group.lanes) {
				const slot = highway.kind === 'drums' ? lane - 1 : lane;
				if (slot >= 0 && slot < highway.lanes) held.add(slot);
			}
		}
		return held;
	}

	private sparkles(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, nowMs: number): void {
		const {ctx} = this;
		const distance = strikeDistance(layout);
		const held = this.heldSlots(highway, track, nowMs);
		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		for (let slot = 0; slot < highway.lanes; slot++) {
			const lane = highway.kind === 'drums' ? slot + 1 : slot;
			const color = surfaceLaneColor(highway, slot);
			const point = project(layout, laneCenterX(highway, slot), distance);
			const s = layout.scale * point.scale * highway.noteScale;
			const hitAt = track.laneFlashMs[lane];
			const sinceHit = nowMs - hitAt;
			if (sinceHit >= 0 && sinceHit < SPARK_BURST_MS) {
				for (let k = 0; k < SPARK_BURST_COUNT; k++) {
					this.spark(
						point.x,
						point.y,
						s,
						sinceHit / 1000,
						SPARK_BURST_MS,
						color,
						hash(slot * 977 + Math.floor(hitAt) * 13 + k),
						1,
					);
				}
			}
			if (!held.has(slot)) continue;
			const newest = Math.floor(nowMs / SPARK_STREAM_EVERY_MS);
			const count = Math.ceil(SPARK_STREAM_LIFE_MS / SPARK_STREAM_EVERY_MS);
			for (let bucket = newest; bucket > newest - count; bucket--) {
				const age = nowMs - bucket * SPARK_STREAM_EVERY_MS;
				if (age < 0 || age >= SPARK_STREAM_LIFE_MS) continue;
				this.spark(point.x, point.y, s, age / 1000, SPARK_STREAM_LIFE_MS, color, hash(slot * 31 + bucket * 7919), 0.65);
			}
		}
		ctx.restore();
	}

	// One four-point twinkle thrown up out of the box: position from launch speed and gravity, so no state is kept.
	private spark(
		x: number,
		y: number,
		s: number,
		t: number,
		lifeMs: number,
		color: string,
		seed: number,
		power: number,
	) {
		const {ctx} = this;
		const angle = -Math.PI / 2 + (seed - 0.5) * 2.2;
		const speed = (110 + 190 * hash(seed * 7 + 1)) * power * s;
		const px = x + Math.cos(angle) * speed * t;
		const py = y + Math.sin(angle) * speed * t + 0.5 * SPARK_GRAVITY * s * t * t;
		const life = 1 - (t * 1000) / lifeMs;
		const size = (2 + 3 * hash(seed * 13 + 2)) * s * (0.5 + 0.5 * life);
		ctx.globalAlpha = Math.max(0, life);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(px, py - size * 1.8);
		ctx.lineTo(px + size * 0.45, py);
		ctx.lineTo(px, py + size * 1.8);
		ctx.lineTo(px - size * 0.45, py);
		ctx.closePath();
		ctx.moveTo(px - size * 1.8, py);
		ctx.lineTo(px, py + size * 0.45);
		ctx.lineTo(px + size * 1.8, py);
		ctx.lineTo(px, py - size * 0.45);
		ctx.closePath();
		ctx.fill();
		ctx.fillStyle = COLOR.paper;
		ctx.beginPath();
		ctx.arc(px, py, size * 0.35, 0, Math.PI * 2);
		ctx.fill();
	}

	private notes(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {groups} = track.chart;
		const {finale} = track;
		const {nowMs} = frame;
		const finalIndex = finale?.finalIndex ?? null;
		const {fromMs, toMs} = visibleWindow(nowMs);
		const first = firstVisibleGroup(groups, fromMs);
		let last = first;
		while (last < groups.length && groups[last].msTime <= toMs) last++;
		const strike = strikeDistance(layout);
		const hidden = (index: number) => isFreePlayGroup(finale, index) || isFreestyleGroup(track.freestyle, index);
		const sway = frame.reducedMotion ? null : this.whammySway(track, nowMs);
		// Tails under gems, far notes under near ones.
		for (let index = last - 1; index >= first; index--) {
			const group = groups[index];
			if (group.msLength <= 0 || hidden(index)) continue;
			const state = track.noteStates[index];
			const held = state === NoteState.Hit && track.heldUntilMs[index] > nowMs;
			if (state === NoteState.Hit && !held) continue;
			const start = held ? strike : Math.max(0, noteDistance(layout, group.msTime - nowMs));
			const end = noteDistance(layout, group.msTime + group.msLength - nowMs);
			if (end <= start) continue;
			for (const lane of group.lanes) {
				this.tail(layout, highway, lane, start, end, state === NoteState.Missed, held ? sway : null);
			}
		}
		for (let index = last - 1; index >= first; index--) {
			const group = groups[index];
			if (hidden(index)) continue;
			const state = track.noteStates[index];
			if (state === NoteState.Hit) continue;
			const distance = noteDistance(layout, group.msTime - nowMs);
			if (distance < 0 || distance > layout.planeLength) continue;
			const star = group.inStarPower && !track.brokenStarGroups.has(index);
			const faded = state === NoteState.Missed;
			const final = index === finalIndex;
			for (const lane of group.lanes)
				this.gem(layout, highway, group, lane, distance, {star, faded, final}, frame.reducedMotion);
		}
	}

	// How hard a held tail sways under the whammy (0..1) and where its wave is; null when it does not.
	private whammySway(track: SeatTrack, nowMs: number): WhammySway | null {
		const {whammy} = track;
		const strength =
			whammy.depthCents > 0
				? 0.4 + (0.6 * whammy.depthCents) / WHAMMY.maxDepthCents
				: 0.4 * fadeAfter(nowMs, whammy.atMs, WHAMMY.releaseS * 1000);
		if (strength <= 0) return null;
		return {strength, phase: (nowMs / 1000) * whammy.rateHz * 2 * Math.PI};
	}

	private tail(
		layout: StageLayout,
		highway: HighwayLayout,
		lane: number,
		start: number,
		end: number,
		faded: boolean,
		sway: WhammySway | null,
	) {
		const slot = surfaceLane(highway.kind, lane);
		if (slot === null) return;
		const x = lane === FretLane.Open ? highway.left + highway.width / 2 : laneCenterX(highway, slot);
		const half = (TAIL_WIDTH / 2) * layout.scale * highway.noteScale;
		const far = Math.min(end, layout.planeLength);
		const {ctx} = this;
		const color = laneColor(highway, lane);
		ctx.save();
		if (sway) {
			this.swayingTail(layout, highway, x, half, start, far, sway);
			ctx.shadowColor = color;
			ctx.shadowBlur = 16 * sway.strength * layout.scale;
			ctx.globalAlpha = 0.95;
		} else {
			this.trapezoid(layout, highway, start, far, x - half, x + half);
			ctx.globalAlpha = faded ? 0.3 : 0.8;
		}
		ctx.fillStyle = color;
		ctx.fill();
		ctx.restore();
	}

	// The tail as a wave travelling up the highway, its width kept.
	private swayingTail(
		layout: StageLayout,
		highway: HighwayLayout,
		x: number,
		half: number,
		start: number,
		far: number,
		sway: WhammySway,
	): void {
		const amplitude = WHAMMY_SWAY_PX * sway.strength * layout.scale * highway.noteScale;
		const wavelength = WHAMMY_WAVE_PX * layout.scale;
		const step = WHAMMY_STEP_PX * layout.scale;
		const left: Array<{x: number; y: number}> = [];
		const right: Array<{x: number; y: number}> = [];
		for (let distance = start; ; distance = Math.min(far, distance + step)) {
			// Pinned at the strike line, free further up, like a string held at the fret.
			const reach = Math.min(1, (distance - start) / (wavelength * 0.75));
			const offset = Math.sin(sway.phase - (distance / wavelength) * 2 * Math.PI) * amplitude * reach;
			left.push(project(layout, x + offset - half, distance));
			right.push(project(layout, x + offset + half, distance));
			if (distance >= far) break;
		}
		const {ctx} = this;
		ctx.beginPath();
		ctx.moveTo(left[0].x, left[0].y);
		for (const point of left.slice(1)) ctx.lineTo(point.x, point.y);
		for (const point of right.reverse()) ctx.lineTo(point.x, point.y);
		ctx.closePath();
	}

	private gem(
		layout: StageLayout,
		highway: HighwayLayout,
		group: NoteGroup,
		lane: number,
		distance: number,
		{star, faded, final}: {readonly star: boolean; readonly faded: boolean; readonly final: boolean},
		reducedMotion: boolean,
	): void {
		const {ctx} = this;
		const color = laneColor(highway, lane);
		ctx.save();
		ctx.globalAlpha = faded ? 0.35 : 1;
		if (highway.kind === 'drums' && lane === DrumLane.Kick) {
			const inset = 6 * layout.scale;
			const point = project(layout, highway.left, distance);
			const s = layout.scale * point.scale * highway.noteScale;
			const a = project(layout, highway.left + inset, distance);
			const b = project(layout, highway.left + highway.width - inset, distance);
			ctx.fillStyle = star ? COLOR.paper : color;
			ctx.strokeStyle = final && !faded ? COLOR.paper : 'rgba(12, 13, 15, 0.9)';
			ctx.lineWidth = (final ? 2.5 : 1.5) * s;
			ctx.beginPath();
			ctx.roundRect(a.x, a.y - (KICK_HEIGHT / 2) * s, b.x - a.x, KICK_HEIGHT * s, 4 * s);
			ctx.fill();
			ctx.stroke();
			ctx.restore();
			return;
		}
		if (highway.kind === 'frets' && lane === FretLane.Open) {
			const a = project(layout, highway.left + 4 * layout.scale, distance);
			const b = project(layout, highway.left + highway.width - 4 * layout.scale, distance);
			const s = layout.scale * a.scale * highway.noteScale;
			ctx.fillStyle = star ? COLOR.paper : color;
			ctx.beginPath();
			ctx.roundRect(a.x, a.y - 5 * s, b.x - a.x, 10 * s, 5 * s);
			ctx.fill();
			ctx.restore();
			return;
		}
		const slot = surfaceLane(highway.kind, lane) ?? 0;
		const point = project(layout, laneCenterX(highway, slot), distance);
		const s = layout.scale * point.scale * highway.noteScale;
		if (final && !faded) this.finalHalo(highway, point.x, point.y, s, reducedMotion);
		if (star && !reducedMotion) {
			ctx.shadowColor = 'rgba(247, 245, 240, 0.55)';
			ctx.shadowBlur = 16 * s;
		}
		ctx.beginPath();
		if (highway.kind === 'drums') {
			const isCymbal = group.cymbals.includes(lane);
			ctx.roundRect(
				point.x - (PAD_WIDTH / 2) * s,
				point.y - (PAD_HEIGHT / 2) * s,
				PAD_WIDTH * s,
				PAD_HEIGHT * s,
				(isCymbal ? PAD_HEIGHT / 2 : 6) * s,
			);
		} else if (star) {
			const r = GEM_RADIUS * s;
			ctx.roundRect(point.x - r, point.y - r * GEM_SQUASH, r * 2, r * 2 * GEM_SQUASH, r * 0.48);
		} else {
			ctx.ellipse(point.x, point.y, GEM_RADIUS * s, GEM_RADIUS * s * GEM_SQUASH, 0, 0, Math.PI * 2);
		}
		ctx.fillStyle = color;
		ctx.fill();
		ctx.shadowBlur = 0;
		ctx.lineWidth = (star ? 2.5 : 1.5) * s;
		ctx.strokeStyle = star ? COLOR.paper : color;
		ctx.stroke();
		if (highway.kind === 'drums') {
			ctx.fillStyle = 'rgba(247, 245, 240, 0.9)';
			ctx.fillRect(point.x - (PAD_WIDTH / 6) * s, point.y - 2 * s, (PAD_WIDTH / 3) * s, 4 * s);
		} else {
			// Hammer-ons get a larger white core, taps a dark one: a quiet marker, not a different note shape.
			const core = group.isHopo ? 0.42 : 0.26;
			ctx.fillStyle = group.isTap ? COLOR.night : COLOR.paper;
			ctx.beginPath();
			ctx.ellipse(point.x, point.y, GEM_RADIUS * s * core, GEM_RADIUS * s * core * GEM_SQUASH, 0, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.restore();
	}

	// The bar the band's final hit sits on: across the highway at the part's final hit, or where the lanes end when it
	// has none. Drawn under the gems.
	private finalBar(
		layout: StageLayout,
		highway: HighwayLayout,
		track: SeatTrack,
		finale: PartFinale,
		nowMs: number,
		reducedMotion: boolean,
	): void {
		const {finalIndex} = finale;
		if (finalIndex !== null && track.noteStates[finalIndex] !== NoteState.Pending) return;
		const atMs = finalIndex === null ? finale.endMs : track.chart.groups[finalIndex].msTime;
		const distance = noteDistance(layout, atMs - nowMs);
		if (distance < 0 || distance > layout.planeLength) return;
		const {ctx} = this;
		const a = project(layout, highway.left - 2 * layout.scale, distance);
		const b = project(layout, highway.left + highway.width + 2 * layout.scale, distance);
		const s = layout.scale * a.scale;
		ctx.save();
		ctx.fillStyle = COLOR.paper;
		if (!reducedMotion) {
			ctx.shadowColor = 'rgba(247, 245, 240, 0.45)';
			ctx.shadowBlur = 22 * s;
		}
		ctx.beginPath();
		ctx.roundRect(a.x, a.y - 5 * s, b.x - a.x, 10 * s, 5 * s);
		ctx.fill();
		ctx.restore();
	}

	// A paper ring around a gem of the final hit, so it reads as the one that banks the bonus.
	private finalHalo(highway: HighwayLayout, x: number, y: number, s: number, reducedMotion: boolean): void {
		const {ctx} = this;
		ctx.save();
		ctx.strokeStyle = COLOR.paper;
		ctx.lineWidth = 2.5 * s;
		if (!reducedMotion) {
			ctx.shadowColor = 'rgba(247, 245, 240, 0.7)';
			ctx.shadowBlur = 14 * s;
		}
		ctx.beginPath();
		if (highway.kind === 'drums') {
			const pad = 5 * s;
			ctx.roundRect(
				x - (PAD_WIDTH / 2) * s - pad,
				y - (PAD_HEIGHT / 2) * s - pad,
				PAD_WIDTH * s + pad * 2,
				PAD_HEIGHT * s + pad * 2,
				10 * s,
			);
		} else {
			const r = GEM_RADIUS * s * 1.32;
			ctx.ellipse(x, y, r, r * GEM_SQUASH, 0, 0, Math.PI * 2);
		}
		ctx.stroke();
		ctx.restore();
	}

	// The far end of every highway fades into the panel, as the design's mask did.
	private fadeFarEnd(layout: StageLayout): void {
		const {ctx} = this;
		const top = project(layout, layout.originX, layout.planeLength).y;
		const bottom = project(layout, layout.originX, layout.planeLength * (1 - FADE_SHARE)).y;
		const gradient = ctx.createLinearGradient(0, top, 0, bottom);
		gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
		gradient.addColorStop(0.4, 'rgba(0, 0, 0, 0.72)');
		gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
		ctx.save();
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = gradient;
		// From the canvas top down: a gem drawn at the far edge pokes above `top`, and the gradient clamps there to
		// fully erased, so nothing shows above the highway's end and notes rise out of the dark.
		ctx.fillRect(0, 0, layout.width, bottom);
		ctx.restore();
	}

	private drawFeedback(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {ctx} = this;
		const point = project(layout, highway.left + highway.width / 2, FEEDBACK_DISTANCE * layout.scale);
		// Wide focus-view lanes carry bigger gems; the combo and judgement grow along, more slowly.
		const s = layout.scale * Math.max(1, highway.noteScale * 0.75);
		ctx.save();
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';
		ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
		ctx.shadowBlur = 6 * s;
		const {feedback} = track;
		const strength = feedback ? fadeAfter(frame.nowMs, feedback.atMs, FEEDBACK_MS) : 0;
		if (feedback && strength > 0) {
			ctx.globalAlpha = Math.min(1, strength * 1.6);
			ctx.font = `600 ${12 * s}px ${frame.fontFamily}`;
			ctx.fillStyle =
				feedback.kind === 'miss'
					? 'rgba(247, 245, 240, 0.42)'
					: feedback.kind === 'perfect'
						? COLOR.paper
						: 'rgba(247, 245, 240, 0.66)';
			ctx.fillText(frame.feedbackLabels[feedback.kind], point.x, point.y - 22 * s);
		}
		if (track.hud.combo > 0) {
			ctx.globalAlpha = 1;
			ctx.font = `800 ${15 * s}px ${frame.fontFamily}`;
			ctx.fillStyle = COLOR.paper;
			ctx.fillText(String(track.hud.combo), point.x, point.y - 4 * s);
		}
		ctx.restore();
	}
}
