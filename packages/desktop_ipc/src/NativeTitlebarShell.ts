// SPDX-License-Identifier: AGPL-3.0-or-later

export const NATIVE_TITLEBAR_CONTROL_ATTR = 'data-window-control';

export type NativeTitlebarControlName = 'minimize' | 'maximize' | 'close';
export type NativeTitlebarLayout = 'macos' | 'controls';

export const NATIVE_TITLEBAR_CLASS = {
	root: 'fluxer-native-titlebar',
	left: 'fluxer-native-titlebar__left',
	wordmark: 'fluxer-native-titlebar__wordmark',
	spacer: 'fluxer-native-titlebar__spacer',
	controls: 'fluxer-native-titlebar__controls',
	control: 'fluxer-native-titlebar__control',
	controlClose: 'fluxer-native-titlebar__control--close',
} as const;

export const NATIVE_TITLEBAR_WORDMARK_VIEWBOX = '0 0 256 256';

// sanalyer: the startup titlebar draws the sanalyer symbol (three squares and the tilted one) instead of Fluxer's wordmark.
export const NATIVE_TITLEBAR_WORDMARK_PATHS: ReadonlyArray<string> = [
	'M102.30 75.58h45.28a10.29 10.29 0 0 1 10.29 10.29v45.28a10.29 10.29 0 0 1 -10.29 10.29h-45.28a10.29 10.29 0 0 1 -10.29 -10.29v-45.28a10.29 10.29 0 0 1 10.29 -10.29Z',
	'M28.21 149.67h45.28a10.29 10.29 0 0 1 10.29 10.29v45.28a10.29 10.29 0 0 1 -10.29 10.29h-45.28a10.29 10.29 0 0 1 -10.29 -10.29v-45.28a10.29 10.29 0 0 1 10.29 -10.29Z',
	'M102.30 149.67h45.28a10.29 10.29 0 0 1 10.29 10.29v45.28a10.29 10.29 0 0 1 -10.29 10.29h-45.28a10.29 10.29 0 0 1 -10.29 -10.29v-45.28a10.29 10.29 0 0 1 10.29 -10.29Z',
	'M159.97 48.16 L224.39 34.47 L238.08 98.88 L173.66 112.58Z',
];

export const NATIVE_TITLEBAR_CONTROL_ICON_PATH = {
	minimize: 'M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z',
	maximize:
		'M208,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28Zm-4,176H52V52H204Z',
	restore:
		'M180,64H40A12,12,0,0,0,28,76V216a12,12,0,0,0,12,12H180a12,12,0,0,0,12-12V76A12,12,0,0,0,180,64ZM168,204H52V88H168ZM228,40V180a12,12,0,0,1-24,0V52H76a12,12,0,0,1,0-24H216A12,12,0,0,1,228,40Z',
	close:
		'M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z',
} as const;

export type NativeTitlebarControlIconName = keyof typeof NATIVE_TITLEBAR_CONTROL_ICON_PATH;

export function nativeTitlebarControlIconSvg(icon: NativeTitlebarControlIconName): string {
	return (
		'<svg viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		`<path d="${NATIVE_TITLEBAR_CONTROL_ICON_PATH[icon]}"/></svg>`
	);
}

export function nativeTitlebarWordmarkSvg(className: string = NATIVE_TITLEBAR_CLASS.wordmark): string {
	const paths = NATIVE_TITLEBAR_WORDMARK_PATHS.map((d) => `<path fill="currentColor" d="${d}"/>`).join('');
	return (
		`<svg class="${className}" role="img" aria-label="sanalyer" xmlns="http://www.w3.org/2000/svg" ` +
		`fill="none" viewBox="${NATIVE_TITLEBAR_WORDMARK_VIEWBOX}">${paths}</svg>`
	);
}

interface StartupControlLabels {
	readonly minimize: string;
	readonly maximize: string;
	readonly close: string;
}

const DEFAULT_STARTUP_CONTROL_LABELS: StartupControlLabels = {
	minimize: 'Minimize window',
	maximize: 'Maximize window',
	close: 'Close window',
};

function controlButtonHtml(
	name: NativeTitlebarControlName,
	icon: NativeTitlebarControlIconName,
	label: string,
	extraClass?: string,
): string {
	const className = extraClass ? `${NATIVE_TITLEBAR_CLASS.control} ${extraClass}` : NATIVE_TITLEBAR_CLASS.control;
	return (
		`<button type="button" tabindex="-1" class="${className}" ${NATIVE_TITLEBAR_CONTROL_ATTR}="${name}" ` +
		`aria-label="${label}">${nativeTitlebarControlIconSvg(icon)}</button>`
	);
}

export function nativeTitlebarControlsHtml(labels: StartupControlLabels = DEFAULT_STARTUP_CONTROL_LABELS): string {
	return (
		`<div class="${NATIVE_TITLEBAR_CLASS.controls}">` +
		controlButtonHtml('minimize', 'minimize', labels.minimize) +
		controlButtonHtml('maximize', 'maximize', labels.maximize) +
		controlButtonHtml('close', 'close', labels.close, NATIVE_TITLEBAR_CLASS.controlClose) +
		'</div>'
	);
}

export function buildNativeTitlebarStartupHtml(layout: NativeTitlebarLayout): string {
	const brand = `<div class="${NATIVE_TITLEBAR_CLASS.left}">${nativeTitlebarWordmarkSvg()}</div>`;
	const spacer = `<div class="${NATIVE_TITLEBAR_CLASS.spacer}"></div>`;
	if (layout === 'macos') {
		return `${spacer}${brand}`;
	}
	return `${brand}${spacer}${nativeTitlebarControlsHtml()}`;
}
