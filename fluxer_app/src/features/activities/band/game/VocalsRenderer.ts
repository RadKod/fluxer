// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VocalNote, VocalsChart} from '@app/features/activities/band/engine/VocalsParser';

// The thin vocals strip over the highways: pitch tubes scroll left past a "now" line, and the current phrase's
// lyrics sit under them, lighting up as they are sung. Sizes are design px scaled by the strip height (84 px).
const DESIGN_HEIGHT = 84;
const NOW_X = 90;
const PX_PER_MS = 0.118;
const TUBE_TOP = 6;
const TUBE_RANGE = 34;
const TUBE_HEIGHT = 9;
const LYRIC_BASELINE = 70;
const LYRIC_SIZE = 17;
const LYRIC_LEFT = 16;
const WORD_GAP = 6;

const SUNG = '#F7F5F0';
const UNSUNG = 'rgba(247, 245, 240, 0.42)';
const TUBE = 'rgba(247, 245, 240, 0.22)';
const TUBE_SUNG = 'rgba(214, 75, 191, 0.75)';

export interface PitchRange {
	readonly min: number;
	readonly max: number;
}

export function pitchRange(notes: ReadonlyArray<VocalNote>): PitchRange {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const note of notes) {
		if (note.pitch === null) continue;
		min = Math.min(min, note.pitch);
		max = Math.max(max, note.pitch);
	}
	if (!Number.isFinite(min)) return {min: 60, max: 60};
	return {min, max};
}

// Top of a tube, in design px: high notes near the top of the strip, unpitched notes in the middle.
export function tubeTop(pitch: number | null, range: PitchRange): number {
	if (pitch === null || range.max === range.min) return TUBE_TOP + TUBE_RANGE / 2;
	return TUBE_TOP + (1 - (pitch - range.min) / (range.max - range.min)) * TUBE_RANGE;
}

// The phrase to show: the one being sung, else the next one; -1 after the last.
export function currentPhrase(chart: VocalsChart, nowMs: number): number {
	const {phrases} = chart;
	for (let index = 0; index < phrases.length; index++) {
		if (phrases[index].msTime + phrases[index].msLength >= nowMs) return index;
	}
	return -1;
}

export class VocalsRenderer {
	private readonly range: PitchRange;
	private readonly notesByPhrase = new Map<number, Array<VocalNote>>();

	constructor(
		private readonly ctx: CanvasRenderingContext2D,
		private readonly chart: VocalsChart,
	) {
		this.range = pitchRange(chart.notes);
		for (const note of chart.notes) {
			const list = this.notesByPhrase.get(note.phraseIndex) ?? [];
			list.push(note);
			this.notesByPhrase.set(note.phraseIndex, list);
		}
	}

	draw(width: number, height: number, nowMs: number, fontFamily: string): void {
		const {ctx, chart} = this;
		const s = height / DESIGN_HEIGHT;
		ctx.clearRect(0, 0, width, height);
		const nowX = NOW_X * s;
		const fromMs = nowMs - nowX / (PX_PER_MS * s);
		const toMs = nowMs + (width - nowX) / (PX_PER_MS * s);
		for (const note of chart.notes) {
			if (note.msTime + note.msLength < fromMs) continue;
			if (note.msTime > toMs) break;
			const x0 = nowX + (note.msTime - nowMs) * PX_PER_MS * s;
			const x1 = nowX + (note.msTime + note.msLength - nowMs) * PX_PER_MS * s;
			const y = tubeTop(note.pitch, this.range) * s;
			const w = Math.max(x1 - x0, TUBE_HEIGHT * s);
			ctx.beginPath();
			ctx.roundRect(x0, y, w, TUBE_HEIGHT * s, (TUBE_HEIGHT / 2) * s);
			ctx.fillStyle = note.isSpoken ? 'rgba(247, 245, 240, 0.12)' : TUBE;
			ctx.fill();
			if (x0 < nowX) {
				ctx.save();
				ctx.clip();
				ctx.fillStyle = TUBE_SUNG;
				ctx.fillRect(x0, y, Math.min(nowX, x0 + w) - x0, TUBE_HEIGHT * s);
				ctx.restore();
			}
		}
		ctx.fillStyle = 'rgba(247, 245, 240, 0.6)';
		ctx.fillRect(nowX - s, 4 * s, 2 * s, (LYRIC_BASELINE - 22) * s);
		this.drawLyrics(width, s, nowMs, fontFamily);
	}

	private drawLyrics(width: number, s: number, nowMs: number, fontFamily: string): void {
		const phrase = currentPhrase(this.chart, nowMs);
		const notes = this.notesByPhrase.get(phrase);
		if (!notes) return;
		const {ctx} = this;
		const syllables = notes.filter((note) => note.lyric.length > 0);
		let size = LYRIC_SIZE * s;
		ctx.font = `500 ${size}px ${fontFamily}`;
		const gap = WORD_GAP * s;
		const total = syllables.reduce(
			(sum, note) => sum + ctx.measureText(note.lyric).width + (note.joinsNext ? 0 : gap),
			0,
		);
		const room = width - LYRIC_LEFT * s * 2;
		if (total > room) {
			size *= room / total;
			ctx.font = `500 ${size}px ${fontFamily}`;
		}
		const ratio = size / (LYRIC_SIZE * s);
		let x = LYRIC_LEFT * s;
		ctx.textBaseline = 'alphabetic';
		for (const note of syllables) {
			ctx.fillStyle = note.msTime <= nowMs ? SUNG : UNSUNG;
			ctx.fillText(note.lyric, x, LYRIC_BASELINE * s);
			x += ctx.measureText(note.lyric).width + (note.joinsNext ? 0 : gap * ratio);
		}
	}
}
