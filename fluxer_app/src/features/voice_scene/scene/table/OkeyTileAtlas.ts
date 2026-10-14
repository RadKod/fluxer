// SPDX-License-Identifier: AGPL-3.0-or-later

import {OKEY_DIGIT_SHARE} from '@app/features/voice_scene/utils/SeatedView';
import {okeyTileFace, parseOkeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import {CanvasTexture, SRGBColorSpace} from 'three';

// One atlas for every okey face: 4 colours × 13 numbers, the fake okey and the back of a hidden tile.
export const OKEY_ATLAS_COLUMNS = 9;
export const OKEY_ATLAS_ROWS = 6;
// The okey_face quad is 34 × 48 mm; a cell keeps that shape.
export const OKEY_ATLAS_CELL = {width: 96, height: 136} as const;
export const OKEY_FAKE_CELL = 52;
export const OKEY_BACK_CELL = 53;

// Ivory faces with the 2D tiles' colour order (0 yellow, 1 blue, 2 black, 3 red), each ink ≥ 4.5:1 on the face.
export const OKEY_FACE_COLOR = '#f7f1e1';
export const OKEY_BACK_COLOR = '#e6dbc1';
export const OKEY_INK = ['#8a5a00', '#1d4fa8', '#1f1d1a', '#b3202a'] as const;
export const OKEY_FAKE_INK = '#1f6b3a';

// Drawn a little over the 55% floor (SeatedView's readability uses 55%), narrowed to fit the face width.
const DIGIT_SHARE = Math.max(OKEY_DIGIT_SHARE, 0.6);
const MAX_TEXT_WIDTH_SHARE = 0.86;
const fontAt = (px: number) => `800 ${px}px system-ui, "Segoe UI", Arial, sans-serif`;

const channel = (value: number): number => {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// WCAG 2 relative luminance of a #rrggbb colour.
export function relativeLuminance(hex: string): number {
	const value = Number.parseInt(hex.slice(1), 16);
	return 0.2126 * channel(value >> 16) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

export function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
}

// A tile's own face (the okey shows its real face; the 3D model marks it on the body), the fake okey's clover, or
// the back for a tile this viewer may not see (null: other racks and the pile).
export function okeyTileCell(token: string | null): number {
	const id = token === null ? null : parseOkeyTileToken(token);
	if (id === null) return OKEY_BACK_CELL;
	const face = okeyTileFace(id);
	return 'fake' in face ? OKEY_FAKE_CELL : face.color * 13 + face.number - 1;
}

// Top-left of the cell in texture space; v runs down because the atlas is uploaded with flipY off (glTF UVs).
export function okeyCellOffset(cell: number): {u: number; v: number} {
	return {
		u: (cell % OKEY_ATLAS_COLUMNS) / OKEY_ATLAS_COLUMNS,
		v: Math.floor(cell / OKEY_ATLAS_COLUMNS) / OKEY_ATLAS_ROWS,
	};
}

// The text sized so its glyphs are DIGIT_SHARE of the face tall, centred, narrowed (never shrunk) to the face width.
function drawText(context: CanvasRenderingContext2D, text: string, cx: number, cy: number): void {
	const {width, height} = OKEY_ATLAS_CELL;
	context.font = fontAt(100);
	const sample = context.measureText(text);
	const px = (100 * DIGIT_SHARE * height) / (sample.actualBoundingBoxAscent + sample.actualBoundingBoxDescent);
	context.font = fontAt(px);
	const metrics = context.measureText(text);
	context.save();
	context.translate(cx, cy);
	context.scale(Math.min(1, (MAX_TEXT_WIDTH_SHARE * width) / metrics.width), 1);
	context.textAlign = 'center';
	context.textBaseline = 'alphabetic';
	context.fillText(text, 0, (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
	context.restore();
}

export function drawOkeyTileAtlas(canvas: HTMLCanvasElement): void {
	const {width, height} = OKEY_ATLAS_CELL;
	canvas.width = OKEY_ATLAS_COLUMNS * width;
	canvas.height = OKEY_ATLAS_ROWS * height;
	const context = canvas.getContext('2d');
	if (!context) return;
	for (let cell = 0; cell < OKEY_ATLAS_COLUMNS * OKEY_ATLAS_ROWS; cell++) {
		const x = (cell % OKEY_ATLAS_COLUMNS) * width;
		const y = Math.floor(cell / OKEY_ATLAS_COLUMNS) * height;
		context.fillStyle = cell === OKEY_BACK_CELL ? OKEY_BACK_COLOR : OKEY_FACE_COLOR;
		context.fillRect(x, y, width, height);
		if (cell === OKEY_BACK_CELL) continue;
		context.fillStyle = cell === OKEY_FAKE_CELL ? OKEY_FAKE_INK : OKEY_INK[Math.floor(cell / 13)]!;
		drawText(context, cell === OKEY_FAKE_CELL ? '♣' : String((cell % 13) + 1), x + width / 2, y + height / 2);
	}
}

// One texture per mounted okey table; its owner disposes it.
export function createOkeyTileAtlas(canvas: HTMLCanvasElement = document.createElement('canvas')): CanvasTexture {
	drawOkeyTileAtlas(canvas);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.flipY = false;
	texture.anisotropy = 4;
	return texture;
}
