// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {loadLazyModule} from '@app/features/platform/utils/LazyModuleLoader';

const logger = new Logger('NameStyleFontLoader');

const requested = new Set<string>();

// Each font is its own stylesheet chunk; it is fetched the first time a name needs it and the name renders in the app
// font until then (font-display: swap).
export function requestNameStyleFont(fontKey: string | null): void {
	if (fontKey === null || requested.has(fontKey)) return;
	requested.add(fontKey);
	loadLazyModule(() => import(`@fluxer/fonts/css/name-styles/${fontKey}.css`)).catch((error: unknown) => {
		requested.delete(fontKey);
		logger.warn(`Failed to load the ${fontKey} name style font; the name keeps the app font:`, error);
	});
}
