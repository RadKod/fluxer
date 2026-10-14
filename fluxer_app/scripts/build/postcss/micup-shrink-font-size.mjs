// SPDX-License-Identifier: AGPL-3.0-or-later

// Micup: every UI text size is 1px under upstream. Rather than edit ~1,670 font-size declarations, the build takes
// 0.0625rem off each one. Row heights come from line-height and padding, so rows keep their size. Untouched: the rem base
// on html/:root, the chat size (var(--font-size), set by the accessibility default), emoji sizes, and em/%/keyword sizes,
// which already follow their parent.
const SHRINK = '0.0625rem';
const KEYWORD =
	/^(?:inherit|initial|unset|revert|revert-layer|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i;
const RELATIVE = /^-?\d*\.?\d+(?:em|%)$/i;
const KEPT_VARIABLE = /var\(--(?:font-size|textarea-font-size)\s*[,)]|emoji/i;
const ROOT_SUBJECT = /^(?:html|:root)(?:[.:[][^\s>+~]*)?$/i;

function isRootRule(rule) {
	return rule?.selectors?.some((selector) => ROOT_SUBJECT.test(selector.trim())) ?? false;
}

/** @returns {import('postcss').Plugin} */
export function micupShrinkFontSize() {
	// PostCSS revisits a declaration it saw change; shrink each one once.
	const shrunk = new WeakSet();
	return {
		postcssPlugin: 'micup-shrink-font-size',
		Declaration: {
			'font-size'(declaration) {
				if (shrunk.has(declaration)) return;
				shrunk.add(declaration);
				const value = declaration.value.trim();
				if (KEYWORD.test(value) || RELATIVE.test(value) || KEPT_VARIABLE.test(value)) return;
				if (declaration.parent?.type === 'rule' && isRootRule(declaration.parent)) return;
				declaration.value = `calc(${value} - ${SHRINK})`;
			},
		},
	};
}
micupShrinkFontSize.postcss = true;
