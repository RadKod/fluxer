// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	contrastRatio,
	drawOkeyTileAtlas,
	OKEY_ATLAS_CELL,
	OKEY_ATLAS_COLUMNS,
	OKEY_ATLAS_ROWS,
	OKEY_BACK_CELL,
	OKEY_FACE_COLOR,
	OKEY_FAKE_CELL,
	OKEY_FAKE_INK,
	OKEY_INK,
	okeyCellOffset,
	okeyTileCell,
	relativeLuminance,
} from '@app/features/voice_scene/scene/table/OkeyTileAtlas';
import {OKEY_DIGIT_SHARE} from '@app/features/voice_scene/utils/SeatedView';
import {describe, expect, it} from 'vitest';

interface TextCall {
	text: string;
	fontPx: number;
	scaleX: number;
	x: number;
	y: number;
	fillStyle: string;
}

// A 2D context that measures text like a bold sans face: digits 0.72 em tall, 0.6 em wide.
function fakeCanvas() {
	const texts: Array<TextCall> = [];
	const rects: Array<{x: number; y: number; w: number; h: number; fillStyle: string}> = [];
	let font = '10px sans-serif';
	let fillStyle = '#000';
	let scaleX = 1;
	let origin = {x: 0, y: 0};
	const stack: Array<{scaleX: number; origin: {x: number; y: number}}> = [];
	const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]);
	const context = {
		set font(value: string) {
			font = value;
		},
		get font() {
			return font;
		},
		set fillStyle(value: string) {
			fillStyle = value;
		},
		get fillStyle() {
			return fillStyle;
		},
		textAlign: 'start',
		textBaseline: 'alphabetic',
		save: () => stack.push({scaleX, origin}),
		restore: () => ({scaleX, origin} = stack.pop() ?? {scaleX: 1, origin: {x: 0, y: 0}}),
		translate: (x: number, y: number) => {
			origin = {x: origin.x + x, y: origin.y + y};
		},
		scale: (x: number) => {
			scaleX *= x;
		},
		fillRect: (x: number, y: number, w: number, h: number) => rects.push({x, y, w, h, fillStyle}),
		measureText: (text: string) => ({
			width: 0.6 * px() * [...text].length,
			actualBoundingBoxAscent: 0.72 * px(),
			actualBoundingBoxDescent: 0,
		}),
		fillText: (text: string, x: number, y: number) =>
			texts.push({text, fontPx: px(), scaleX, x: origin.x + x * scaleX, y: origin.y + y, fillStyle}),
	};
	const canvas = {width: 0, height: 0, getContext: () => context} as unknown as HTMLCanvasElement;
	return {canvas, texts, rects};
}

const cellOf = (x: number, y: number) =>
	Math.floor(y / OKEY_ATLAS_CELL.height) * OKEY_ATLAS_COLUMNS + Math.floor(x / OKEY_ATLAS_CELL.width);

describe('OkeyTileAtlas', () => {
	it('54 faces (4 colours × 13, fake okey, back) in one atlas; digit height ≥ 55% of the face', () => {
		expect(OKEY_ATLAS_COLUMNS * OKEY_ATLAS_ROWS).toBe(54);
		const {canvas, texts, rects} = fakeCanvas();
		drawOkeyTileAtlas(canvas);
		expect([canvas.width, canvas.height]).toEqual([
			OKEY_ATLAS_COLUMNS * OKEY_ATLAS_CELL.width,
			OKEY_ATLAS_ROWS * OKEY_ATLAS_CELL.height,
		]);
		// Every cell gets its own background.
		expect(new Set(rects.map((rect) => cellOf(rect.x, rect.y))).size).toBe(54);

		const digits = texts.filter((call) => /^\d+$/.test(call.text));
		expect(digits).toHaveLength(52);
		for (const color of [0, 1, 2, 3] as const)
			for (let number = 1; number <= 13; number++) {
				const cell = color * 13 + number - 1;
				const call = digits.find((entry) => cellOf(entry.x, entry.y) === cell);
				expect(call?.text).toBe(String(number));
				expect(call?.fillStyle).toBe(OKEY_INK[color]);
				const height = 0.72 * call!.fontPx;
				expect(height / OKEY_ATLAS_CELL.height).toBeGreaterThanOrEqual(OKEY_DIGIT_SHARE);
				// Two-digit numbers are narrowed, never shrunk: they still fit the face width.
				expect(0.6 * call!.fontPx * call!.text.length * call!.scaleX).toBeLessThanOrEqual(OKEY_ATLAS_CELL.width);
			}

		// The 106 tokens: two of every face, the two fake okeys on the fake cell, a hidden tile on the back.
		const uses = new Map<number, number>();
		for (let id = 0; id < 106; id++) {
			const cell = okeyTileCell(`t${id}`);
			uses.set(cell, (uses.get(cell) ?? 0) + 1);
		}
		for (let cell = 0; cell < 52; cell++) expect(uses.get(cell)).toBe(2);
		expect(uses.get(OKEY_FAKE_CELL)).toBe(2);
		expect(okeyTileCell(null)).toBe(OKEY_BACK_CELL);
		expect(okeyCellOffset(OKEY_BACK_CELL)).toEqual({u: 8 / 9, v: 5 / 6});
	});

	it('okey and fake okey render distinctly', () => {
		const {canvas, texts} = fakeCanvas();
		drawOkeyTileAtlas(canvas);
		// Indicator t5 is yellow 6, so the okey is yellow 7 (t6 / t58); the fake okeys are t104 and t105.
		const okeyCell = okeyTileCell('t6');
		expect(okeyCell).toBe(6);
		expect(okeyTileCell('t58')).toBe(okeyCell);
		expect(okeyTileCell('t104')).toBe(OKEY_FAKE_CELL);
		expect(okeyTileCell('t105')).toBe(OKEY_FAKE_CELL);
		const inCell = (cell: number) => texts.filter((call) => cellOf(call.x, call.y) === cell);
		expect(inCell(okeyCell).map((call) => call.text)).toEqual(['7']);
		const fake = inCell(OKEY_FAKE_CELL);
		expect(fake.map((call) => call.text)).toEqual(['♣']);
		expect(fake[0]!.fillStyle).toBe(OKEY_FAKE_INK);
		expect((0.72 * fake[0]!.fontPx) / OKEY_ATLAS_CELL.height).toBeGreaterThanOrEqual(OKEY_DIGIT_SHARE);
		expect(inCell(OKEY_BACK_CELL)).toEqual([]);
	});

	it('colour contrast digit/face ≥ 4.5:1 (computed from the palette)', () => {
		expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
		expect(relativeLuminance('#000000')).toBe(0);
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		for (const ink of [...OKEY_INK, OKEY_FAKE_INK])
			expect(contrastRatio(ink, OKEY_FACE_COLOR)).toBeGreaterThanOrEqual(4.5);
		// an ivory face this light keeps ≥ 3:1 against any felt the rooms may use (top ≤ 0.26).
		expect((relativeLuminance(OKEY_FACE_COLOR) + 0.05) / (0.26 + 0.05)).toBeGreaterThanOrEqual(3);
	});
});
