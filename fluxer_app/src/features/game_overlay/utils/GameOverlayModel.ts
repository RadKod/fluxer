// SPDX-License-Identifier: AGPL-3.0-or-later

export type GameOverlayMode = 'speaking' | 'room';

interface GameOverlayEntryLike {
	userId: string;
	speaking: boolean;
}

export interface GameOverlaySelection<T> {
	shown: Array<T>;
	overflow: number;
}

export type GameOverlayMicState = 'on' | 'muted' | 'deafened';

export interface GameOverlaySize {
	width: number;
	height: number;
}

const MAX_SHOWN: Record<GameOverlayMode, number> = {speaking: 6, room: 15};

// Keep in sync with GameOverlayHost.module.css.
const PADDING_PX = 6;
const SPEAKING_AVATAR_PX = 28;
const SPEAKING_GAP_PX = 6;
const SPEAKING_WIDTH_PX = SPEAKING_AVATAR_PX + 2 * PADDING_PX;
const ROOM_ROW_PX = 28;
const ROOM_WIDTH_PX = 154;

export function selectGameOverlayEntries<T extends GameOverlayEntryLike>(
	entries: ReadonlyArray<T>,
	mode: GameOverlayMode,
): GameOverlaySelection<T> {
	const byUser = new Map<string, T>();
	for (const entry of entries) {
		// Same rule as deduplicateEntriesByUser in VoiceParticipantAvatarList.tsx: the speaking connection wins whole.
		const existing = byUser.get(entry.userId);
		if (!existing || (entry.speaking && !existing.speaking)) {
			byUser.set(entry.userId, entry);
		}
	}
	const candidates = Array.from(byUser.values()).filter((entry) => mode === 'room' || entry.speaking);
	const limit = MAX_SHOWN[mode];
	return {shown: candidates.slice(0, limit), overflow: Math.max(0, candidates.length - limit)};
}

export function computeGameOverlaySize(mode: GameOverlayMode, shownCount: number, overflow: number): GameOverlaySize {
	const rows = shownCount + (overflow > 0 ? 1 : 0);
	if (mode === 'speaking') {
		return {
			width: SPEAKING_WIDTH_PX,
			height: 2 * PADDING_PX + rows * SPEAKING_AVATAR_PX + Math.max(0, rows - 1) * SPEAKING_GAP_PX,
		};
	}
	return {width: ROOM_WIDTH_PX, height: 2 * PADDING_PX + rows * ROOM_ROW_PX};
}

export function getGameOverlayMicState(entry: {selfMute: boolean; selfDeaf: boolean}): GameOverlayMicState {
	if (entry.selfDeaf) return 'deafened';
	return entry.selfMute ? 'muted' : 'on';
}
