// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BigRockEnding} from '@app/features/activities/band/engine/BigRockEnding';
import {DrumLane, FretLane, type NoteGroup} from '@app/features/activities/band/engine/ChartModel';
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
import {
	type FeedbackKind,
	isInFinale,
	NoteState,
	type SeatTrack,
} from '@app/features/activities/band/game/PlayController';

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
const FINALE_SURFACE: ReadonlyArray<readonly [number, string]> = [
	[0, '#4A0A41'],
	[0.4, '#2A0726'],
	[1, '#16060F'],
];

const GLOW_MS = 260;
const TARGET_FLASH_MS = 180;
const ZONE_FLASH_MS = 420;
const MISS_DIM_MS = 650;
const FEEDBACK_MS = 700;
// Sustains are drawn from their start; longer ones than this are rare enough to clip.
const LONGEST_SUSTAIN_MS = 8_000;

const GEM_RADIUS = 16;
const PAD_WIDTH = 48;
const PAD_HEIGHT = 18;
const KICK_HEIGHT = 12;
const TAIL_WIDTH = 9;
const GEM_SQUASH = 0.84;

export interface HighwayFrame {
	readonly nowMs: number;
	readonly tracks: ReadonlyArray<SeatTrack>;
	readonly finale: BigRockEnding | null;
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

// Draws every highway of the stage onto one 2D canvas. Holds no game state; each frame is drawn from `HighwayFrame`.
export class HighwayRenderer {
	private layout: StageLayout | null = null;

	constructor(private readonly ctx: CanvasRenderingContext2D) {}

	setLayout(layout: StageLayout): void {
		this.layout = layout;
	}

	draw(frame: HighwayFrame): void {
		const {ctx, layout} = this;
		if (!layout) return;
		ctx.clearRect(0, 0, layout.width, layout.height);
		layout.highways.forEach((highway, index) => {
			const track = frame.tracks[index];
			if (track) this.drawHighway(layout, highway, track, frame);
		});
		this.fadeFarEnd(layout);
		layout.highways.forEach((highway, index) => {
			const track = frame.tracks[index];
			if (track) this.drawFeedback(layout, highway, track, frame);
		});
	}

	private drawHighway(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {ctx} = this;
		const {nowMs, finale} = frame;
		const finaleOn = finale !== null && nowMs >= finale.startMs && nowMs <= finale.endMs + 600;
		const starOn = track.hud.starPowerActive && !finaleOn;
		this.surface(layout, highway, finaleOn ? FINALE_SURFACE : starOn ? STAR_SURFACE : null);
		this.grid(layout, highway, nowMs, finaleOn ? 0.07 : starOn ? 0.09 : 0.045);
		this.laneLines(layout, highway, finaleOn || starOn ? 0.12 : 0.06);
		if (finaleOn) this.zones(layout, highway, track, nowMs);
		else this.glows(layout, highway, track, nowMs);
		const railPulse = finaleOn && !frame.reducedMotion ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(nowMs / 80)) : 1;
		this.rails(layout, highway, starOn ? COLOR.paper : COLOR.plum, railPulse);
		this.strikeline(layout, highway);
		this.targets(layout, highway, track, nowMs, finaleOn);
		this.notes(layout, highway, track, frame);
		if (finale) this.finalBar(layout, highway, finale, nowMs);
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

	// Free play: every lane glows faintly in its colour and lights up on each press.
	private zones(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, nowMs: number): void {
		const {ctx} = this;
		const cell = highway.width / highway.lanes;
		for (let slot = 0; slot < highway.lanes; slot++) {
			const lane = highway.kind === 'drums' ? slot + 1 : slot;
			const flash = Math.max(
				fadeAfter(nowMs, track.laneFlashMs[lane], ZONE_FLASH_MS),
				highway.kind === 'drums' ? fadeAfter(nowMs, track.laneFlashMs[DrumLane.Kick], ZONE_FLASH_MS) * 0.5 : 0,
			);
			const x0 = highway.left + slot * cell;
			const {near, far} = this.trapezoid(layout, highway, 0, layout.planeLength * 0.46, x0, x0 + cell);
			const gradient = ctx.createLinearGradient(0, near, 0, far);
			gradient.addColorStop(0, surfaceLaneColor(highway, slot));
			gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
			ctx.save();
			ctx.globalAlpha = 0.07 + 0.48 * flash;
			ctx.fillStyle = gradient;
			ctx.fill();
			ctx.restore();
		}
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

	private notes(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {groups} = track.chart;
		const {nowMs, finale} = frame;
		const {fromMs, toMs} = visibleWindow(nowMs);
		const first = firstVisibleGroup(groups, fromMs);
		let last = first;
		while (last < groups.length && groups[last].msTime <= toMs) last++;
		const strike = strikeDistance(layout);
		// Tails under gems, far notes under near ones.
		for (let index = last - 1; index >= first; index--) {
			const group = groups[index];
			if (group.msLength <= 0 || isInFinale(finale, group.msTime)) continue;
			const state = track.noteStates[index];
			const held = state === NoteState.Hit && track.heldUntilMs[index] > nowMs;
			if (state === NoteState.Hit && !held) continue;
			const start = held ? strike : Math.max(0, noteDistance(layout, group.msTime - nowMs));
			const end = noteDistance(layout, group.msTime + group.msLength - nowMs);
			if (end <= start) continue;
			for (const lane of group.lanes) this.tail(layout, highway, lane, start, end, state === NoteState.Missed);
		}
		for (let index = last - 1; index >= first; index--) {
			const group = groups[index];
			if (isInFinale(finale, group.msTime)) continue;
			const state = track.noteStates[index];
			if (state === NoteState.Hit) continue;
			const distance = noteDistance(layout, group.msTime - nowMs);
			if (distance < 0 || distance > layout.planeLength) continue;
			const star = group.inStarPower && !track.brokenStarGroups.has(index);
			const faded = state === NoteState.Missed;
			for (const lane of group.lanes)
				this.gem(layout, highway, group, lane, distance, star, faded, frame.reducedMotion);
		}
	}

	private tail(layout: StageLayout, highway: HighwayLayout, lane: number, start: number, end: number, faded: boolean) {
		const slot = surfaceLane(highway.kind, lane);
		if (slot === null) return;
		const x = lane === FretLane.Open ? highway.left + highway.width / 2 : laneCenterX(highway, slot);
		const half = (TAIL_WIDTH / 2) * layout.scale * highway.noteScale;
		const far = Math.min(end, layout.planeLength);
		this.trapezoid(layout, highway, start, far, x - half, x + half);
		const {ctx} = this;
		ctx.save();
		ctx.globalAlpha = faded ? 0.3 : 0.8;
		ctx.fillStyle = laneColor(highway, lane);
		ctx.fill();
		ctx.restore();
	}

	private gem(
		layout: StageLayout,
		highway: HighwayLayout,
		group: NoteGroup,
		lane: number,
		distance: number,
		star: boolean,
		faded: boolean,
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
			ctx.strokeStyle = 'rgba(12, 13, 15, 0.9)';
			ctx.lineWidth = 1.5 * s;
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

	private finalBar(layout: StageLayout, highway: HighwayLayout, finale: BigRockEnding, nowMs: number): void {
		if (nowMs < finale.startMs) return;
		const distance = noteDistance(layout, finale.endMs - nowMs);
		if (distance < 0 || distance > layout.planeLength) return;
		const {ctx} = this;
		const a = project(layout, highway.left - 2 * layout.scale, distance);
		const b = project(layout, highway.left + highway.width + 2 * layout.scale, distance);
		const s = layout.scale * a.scale;
		ctx.save();
		ctx.fillStyle = COLOR.paper;
		ctx.shadowColor = 'rgba(247, 245, 240, 0.45)';
		ctx.shadowBlur = 22 * s;
		ctx.beginPath();
		ctx.roundRect(a.x, a.y - 5 * s, b.x - a.x, 10 * s, 5 * s);
		ctx.fill();
		ctx.restore();
	}

	// The far end of every highway fades into the panel, as the design's mask did.
	private fadeFarEnd(layout: StageLayout): void {
		const {ctx} = this;
		const top = project(layout, layout.originX, layout.planeLength).y;
		const bottom = project(layout, layout.originX, layout.planeLength * (1 - FADE_SHARE)).y;
		const gradient = ctx.createLinearGradient(0, top, 0, bottom);
		gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');
		gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
		ctx.save();
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = gradient;
		ctx.fillRect(0, top - 4, layout.width, bottom - top + 4);
		ctx.restore();
	}

	private drawFeedback(layout: StageLayout, highway: HighwayLayout, track: SeatTrack, frame: HighwayFrame): void {
		const {ctx} = this;
		const point = project(layout, highway.left + highway.width / 2, FEEDBACK_DISTANCE * layout.scale);
		const s = layout.scale;
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
