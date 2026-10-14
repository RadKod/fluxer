// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_MESSAGE_XP} from '@app/api/guild/micupbot/MicupBotConstants';

export function xpToNextLevel(level: number): number {
	return 5 * level * level + 50 * level + 100;
}
export function totalXpForLevel(level: number): number {
	return (5 * (level - 1) * level * (2 * level - 1)) / 6 + 25 * level * (level - 1) + 100 * level;
}
export function levelFromXp(xp: number): {level: number; current: number; next: number} {
	let low = 0,
		high = 1;
	while (totalXpForLevel(high) <= xp) high *= 2;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if (totalXpForLevel(middle) <= xp) low = middle;
		else high = middle;
	}
	return {level: low, current: xp - totalXpForLevel(low), next: xpToNextLevel(low)};
}
export function rollMessageXp(random: () => number): number {
	const {min, max} = MICUPBOT_MESSAGE_XP;
	return min + Math.floor(random() * (max - min + 1));
}
