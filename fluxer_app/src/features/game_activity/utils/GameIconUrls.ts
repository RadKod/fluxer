// SPDX-License-Identifier: AGPL-3.0-or-later

import {getGameById} from '@fluxer/game_catalog/src/GameCatalog';

export async function getGameIconUrl(gameId: string, size: 64 | 128): Promise<string | null> {
	const game = getGameById(gameId);
	if (!game?.icon) return null;
	const {gameIconUrls} = await import('./GameIconAssets');
	return gameIconUrls[game.icon]?.[size] ?? null;
}
