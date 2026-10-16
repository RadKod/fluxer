// SPDX-License-Identifier: AGPL-3.0-or-later

// Colours are 0xRRGGBB sRGB integers, the form the API stores and returns.

export type Lab = readonly [l: number, a: number, b: number];

// coal and dark paint the chat with the same colour; dark_legacy paints hsl(220 13% 5%).
export const NAME_COLOR_DARK_BACKGROUNDS: ReadonlyArray<number> = [0x141519, 0x0b0c0e];
export const NAME_COLOR_LIGHT_BACKGROUND = 0xfbfbfc;
export const NAME_COLOR_MIN_CONTRAST = 4.5;
export const NAME_COLOR_LIGHT_MIN_CONTRAST = 3;
// In a guild a name colour closer than this to a coloured role is drawn in the default colour.
export const NAME_COLOR_ROLE_MIN_DELTA_E = 15;
const NAME_COLOR_MAX_COLORS = 2;

function channel(color: number, shift: number): number {
	return (color >> shift) & 0xff;
}

function linear(value: number): number {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: number): number {
	return 0.2126 * linear(channel(color, 16)) + 0.7152 * linear(channel(color, 8)) + 0.0722 * linear(channel(color, 0));
}

export function contrastRatio(a: number, b: number): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Both stops of a two-stop gradient and every 5 % between them.
export const GRADIENT_SAMPLE_COUNT = 21;

// What the browser paints along a two-stop gradient, which mixes the sRGB channels; a solid colour as it is. A
// gradient can be darker or closer to another colour somewhere between its ends than at them or at its midpoint.
export function gradientSamples(colors: ReadonlyArray<number>): Array<number> {
	if (colors.length !== 2) return [...colors];
	const [a, b] = colors;
	return Array.from({length: GRADIENT_SAMPLE_COUNT}, (_, step) => {
		const t = step / (GRADIENT_SAMPLE_COUNT - 1);
		const mix = (shift: number) => Math.round(channel(a, shift) + (channel(b, shift) - channel(a, shift)) * t);
		return (mix(16) << 16) | (mix(8) << 8) | mix(0);
	});
}

function labF(t: number): number {
	return t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
}

// CIELAB under D65.
export function srgbToLab(color: number): Lab {
	const r = linear(channel(color, 16));
	const g = linear(channel(color, 8));
	const b = linear(channel(color, 0));
	const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
	const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
	const fz = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (deg: number) => (deg * Math.PI) / 180;

function hue(b: number, a: number): number {
	if (a === 0 && b === 0) return 0;
	const h = degrees(Math.atan2(b, a));
	return h < 0 ? h + 360 : h;
}

// CIEDE2000 with kL = kC = kH = 1 (Sharma, Wu and Dalal 2005).
export function labDeltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
	const pow7 = (x: number) => x ** 7;
	const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
	const g = 0.5 * (1 - Math.sqrt(pow7(cBar) / (pow7(cBar) + pow7(25))));
	const a1p = (1 + g) * a1;
	const a2p = (1 + g) * a2;
	const c1p = Math.hypot(a1p, b1);
	const c2p = Math.hypot(a2p, b2);
	const h1p = hue(b1, a1p);
	const h2p = hue(b2, a2p);
	const chromaProduct = c1p * c2p;

	let dhp = 0;
	if (chromaProduct !== 0) {
		dhp = h2p - h1p;
		if (dhp > 180) dhp -= 360;
		else if (dhp < -180) dhp += 360;
	}
	const dLp = l2 - l1;
	const dCp = c2p - c1p;
	const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin(radians(dhp / 2));

	const lBarp = (l1 + l2) / 2;
	const cBarp = (c1p + c2p) / 2;
	let hBarp = h1p + h2p;
	if (chromaProduct !== 0) {
		if (Math.abs(h1p - h2p) > 180) hBarp += hBarp < 360 ? 360 : -360;
		hBarp /= 2;
	}

	const t =
		1 -
		0.17 * Math.cos(radians(hBarp - 30)) +
		0.24 * Math.cos(radians(2 * hBarp)) +
		0.32 * Math.cos(radians(3 * hBarp + 6)) -
		0.2 * Math.cos(radians(4 * hBarp - 63));
	const dTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2));
	const rc = 2 * Math.sqrt(pow7(cBarp) / (pow7(cBarp) + pow7(25)));
	const sl = 1 + (0.015 * (lBarp - 50) ** 2) / Math.sqrt(20 + (lBarp - 50) ** 2);
	const sc = 1 + 0.045 * cBarp;
	const sh = 1 + 0.015 * cBarp * t;
	const rt = -Math.sin(radians(2 * dTheta)) * rc;

	const dl = dLp / sl;
	const dc = dCp / sc;
	const dh = dHp / sh;
	return Math.sqrt(dl * dl + dc * dc + dh * dh + rt * dc * dh);
}

export function deltaE2000(a: number, b: number): number {
	return labDeltaE2000(srgbToLab(a), srgbToLab(b));
}

// The colours a solid (one) or gradient (two) name paints; none for any other count.
export function paintedNameColors(colors: ReadonlyArray<number>): ReadonlyArray<number> {
	if (colors.length === 0 || colors.length > NAME_COLOR_MAX_COLORS) return [];
	return gradientSamples(colors);
}

export function isNameColorsReadableOn(
	colors: ReadonlyArray<number>,
	backgrounds: ReadonlyArray<number>,
	minimum: number,
): boolean {
	const painted = paintedNameColors(colors);
	return (
		painted.length > 0 &&
		painted.every((color) => backgrounds.every((background) => contrastRatio(color, background) >= minimum))
	);
}

// The server rejects name colours that fail this.
export function isNameColorsReadableOnDark(colors: ReadonlyArray<number>): boolean {
	return isNameColorsReadableOn(colors, NAME_COLOR_DARK_BACKGROUNDS, NAME_COLOR_MIN_CONTRAST);
}

// The light theme draws a name whose colours fail this in the default text colour.
export function isNameColorsReadableOnLight(colors: ReadonlyArray<number>): boolean {
	return isNameColorsReadableOn(colors, [NAME_COLOR_LIGHT_BACKGROUND], NAME_COLOR_LIGHT_MIN_CONTRAST);
}

// sanalyer: role colours are drawn as stored on the light theme; on the dark themes a colour that fails the name
// floor is lifted toward white until it passes. The chat and member-list surfaces of coal/dark and dark_legacy.
export const ROLE_COLOR_DARK_BACKGROUNDS: ReadonlyArray<number> = [
	...NAME_COLOR_DARK_BACKGROUNDS,
	0x0c0c0f,
	0x0e0e12,
	0x1d2026,
];
export const ROLE_COLOR_DARK_MIN_CONTRAST = NAME_COLOR_MIN_CONTRAST;

function mixTowardWhite(color: number, t: number): number {
	const mix = (shift: number) => Math.round(channel(color, shift) + (255 - channel(color, shift)) * t);
	return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

function meetsContrast(color: number, backgrounds: ReadonlyArray<number>, minimum: number): boolean {
	return backgrounds.every((background) => contrastRatio(color, background) >= minimum);
}

// The least lift toward white (same hue, mixed in sRGB) that makes the colour reach `minimum` against every
// background; a colour that already does comes back unchanged. Only for drawing, never for stored colours.
export function liftColorForContrast(color: number, backgrounds: ReadonlyArray<number>, minimum: number): number {
	const base = color & 0xffffff;
	if (meetsContrast(base, backgrounds, minimum)) return base;
	if (!meetsContrast(0xffffff, backgrounds, minimum)) return 0xffffff;
	let low = 0;
	let high = 1;
	for (let step = 0; step < 20; step++) {
		const mid = (low + high) / 2;
		if (meetsContrast(mixTowardWhite(base, mid), backgrounds, minimum)) high = mid;
		else low = mid;
	}
	let lifted = mixTowardWhite(base, high);
	while (!meetsContrast(lifted, backgrounds, minimum) && lifted !== 0xffffff) {
		high = Math.min(1, high + 1 / 255);
		lifted = mixTowardWhite(base, high);
	}
	return lifted;
}

export function roleColorOnDark(color: number): number {
	return liftColorForContrast(color, ROLE_COLOR_DARK_BACKGROUNDS, ROLE_COLOR_DARK_MIN_CONTRAST);
}
