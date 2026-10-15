// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CAM_ORMANI_CSS,
	DERIN_DENIZ_CSS,
	KAGIT_CSS,
	KEHRIBAR_CSS,
	MOR_GECE_CSS,
} from '@app/features/discovery/themes/catalog/ThemeCatalogCss';
import {parseThemeMetadata} from '@app/features/theme/utils/ThemeCssUtils';

// Library ids of catalog themes carry this prefix, so the page can tell its own entries from the user's files and
// keep a single catalog palette enabled at a time.
export const THEME_CATALOG_ID_PREFIX = 'catalog:';

// The preview card paints these five colours: the server rail, the channel list, the chat, the text and the accent.
export interface ThemeCatalogSwatches {
	rail: string;
	panel: string;
	chat: string;
	text: string;
	brand: string;
}

export interface ThemeCatalogEntry {
	slug: string;
	id: string;
	name: string;
	description: string;
	tags: Array<string>;
	css: string;
	swatches: ThemeCatalogSwatches;
}

function entry(slug: string, css: string): ThemeCatalogEntry {
	const metadata = parseThemeMetadata(css, slug);
	const read = (name: string): string => {
		const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
		return match?.[1]?.trim() ?? 'transparent';
	};
	return {
		slug,
		id: `${THEME_CATALOG_ID_PREFIX}${slug}`,
		name: metadata.name,
		description: metadata.description,
		tags: metadata.tags,
		css,
		swatches: {
			rail: read('--background-secondary'),
			panel: read('--side-panel-background'),
			chat: read('--background-primary'),
			text: read('--text-primary'),
			brand: read('--brand-primary'),
		},
	};
}

// Hand-made palettes shipped with the app; the order is the order on the page.
export const THEME_CATALOG: ReadonlyArray<ThemeCatalogEntry> = [
	entry('mor-gece', MOR_GECE_CSS),
	entry('derin-deniz', DERIN_DENIZ_CSS),
	entry('cam-ormani', CAM_ORMANI_CSS),
	entry('kehribar', KEHRIBAR_CSS),
	entry('kagit', KAGIT_CSS),
];

export function isThemeCatalogId(id: string): boolean {
	return id.startsWith(THEME_CATALOG_ID_PREFIX);
}
