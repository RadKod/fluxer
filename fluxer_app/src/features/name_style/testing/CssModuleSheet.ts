// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';

const GLOBAL = ':global(';

// The classes outside :global() take the names the module's import resolves to; the ones inside stay as written.
function resolveClasses(css: string, classes: Readonly<Record<string, string>>): string {
	const local = (part: string) =>
		part.replace(/\.([A-Za-z_][\w-]*)/g, (match, name: string) => (classes[name] ? `.${classes[name]}` : match));
	let out = '';
	let from = 0;
	for (;;) {
		const start = css.indexOf(GLOBAL, from);
		if (start < 0) return out + local(css.slice(from));
		let depth = 1;
		let end = start + GLOBAL.length;
		for (; depth > 0; end++) {
			if (css[end] === '(') depth++;
			else if (css[end] === ')') depth--;
		}
		out += local(css.slice(from, start)) + css.slice(start + GLOBAL.length, end - 1);
		from = end;
	}
}

// Puts a CSS module into the test document, so a test measures the cascade on the rendered DOM. happy-dom drops
// -webkit-text-fill-color, so it is kept under a custom property of the same name, which inherits and cascades the same
// way.
export function mountCssModule(path: string, classes: Readonly<Record<string, string>>): HTMLStyleElement {
	const css = resolveClasses(readFileSync(path, 'utf8'), classes).replaceAll(
		'-webkit-text-fill-color',
		'--webkit-text-fill-color',
	);
	const sheet = document.createElement('style');
	sheet.textContent = css;
	document.head.append(sheet);
	return sheet;
}
