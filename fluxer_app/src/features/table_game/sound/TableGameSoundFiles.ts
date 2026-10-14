// SPDX-License-Identifier: AGPL-3.0-or-later

import damaCaptureSound from '@app/media/sounds/table-game/dama-al.mp3';
import damaMoveSound from '@app/media/sounds/table-game/dama-hamle.mp3';
// Micup: the table game sound types and files, spread into Fluxer's SoundType, SOUND_FILES and the one-shot policies
// (notification/utils/SoundUtils, ui/state/Sound). A leaf module: it imports nothing from those files.
import okeyFinishSound from '@app/media/sounds/table-game/okey-bitir.mp3';
import shuffleSound from '@app/media/sounds/table-game/okey-karistir.mp3';
import meldOpenSound from '@app/media/sounds/table-game/okey-per-ac.mp3';
import tilePickSound from '@app/media/sounds/table-game/okey-tas-al.mp3';
import tileDiscardSound from '@app/media/sounds/table-game/okey-tas-at.mp3';
import tileDrawSound from '@app/media/sounds/table-game/okey-tas-cek.mp3';
import tileDragSound from '@app/media/sounds/table-game/okey-tas-surukle.mp3';
import tilePlaceSound from '@app/media/sounds/table-game/okey-tas-yerlestir.mp3';
import endedSound from '@app/media/sounds/table-game/oyun-bitti.mp3';
import wonSound from '@app/media/sounds/table-game/oyun-kazandin.mp3';
import chessCaptureSound from '@app/media/sounds/table-game/satranc-al.mp3';
import chessMoveSound from '@app/media/sounds/table-game/satranc-hamle.mp3';
import chessCheckSound from '@app/media/sounds/table-game/satranc-sah.mp3';
import yourTurnSound from '@app/media/sounds/table-game/sira-sende.mp3';
import timeLowSound from '@app/media/sounds/table-game/sure-azaldi.mp3';
import tavlaHitSound from '@app/media/sounds/table-game/tavla-kir.mp3';
import tavlaCheckerSound from '@app/media/sounds/table-game/tavla-pul.mp3';
import tavlaBearOffSound from '@app/media/sounds/table-game/tavla-topla.mp3';
import tavlaDiceSound from '@app/media/sounds/table-game/tavla-zar.mp3';
import type {ValueOf} from '@fluxer/constants/src/ValueOf';

export const TABLE_GAME_SOUND_TYPE = {
	TableGameTilePick: 'table-game-tile-pick',
	TableGameTilePlace: 'table-game-tile-place',
	TableGameTileDrag: 'table-game-tile-drag',
	TableGameTileDraw: 'table-game-tile-draw',
	TableGameTileDiscard: 'table-game-tile-discard',
	TableGameShuffle: 'table-game-shuffle',
	TableGameMeldOpen: 'table-game-meld-open',
	TableGameOkeyFinish: 'table-game-okey-finish',
	TableGameChessMove: 'table-game-chess-move',
	TableGameChessCapture: 'table-game-chess-capture',
	TableGameChessCheck: 'table-game-chess-check',
	TableGameDamaMove: 'table-game-dama-move',
	TableGameDamaCapture: 'table-game-dama-capture',
	TableGameTavlaDice: 'table-game-tavla-dice',
	TableGameTavlaChecker: 'table-game-tavla-checker',
	TableGameTavlaHit: 'table-game-tavla-hit',
	TableGameTavlaBearOff: 'table-game-tavla-bear-off',
	TableGameYourTurn: 'table-game-your-turn',
	TableGameTimeLow: 'table-game-time-low',
	TableGameWon: 'table-game-won',
	TableGameEnded: 'table-game-ended',
} as const;

export type TableGameSoundType = ValueOf<typeof TABLE_GAME_SOUND_TYPE>;

// The files are URLs (the bundler emits them as assets): each is fetched the first time it plays.
export const TABLE_GAME_SOUND_FILES: Record<TableGameSoundType, string> = {
	[TABLE_GAME_SOUND_TYPE.TableGameTilePick]: tilePickSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTilePlace]: tilePlaceSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTileDrag]: tileDragSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTileDraw]: tileDrawSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTileDiscard]: tileDiscardSound,
	[TABLE_GAME_SOUND_TYPE.TableGameShuffle]: shuffleSound,
	[TABLE_GAME_SOUND_TYPE.TableGameMeldOpen]: meldOpenSound,
	[TABLE_GAME_SOUND_TYPE.TableGameOkeyFinish]: okeyFinishSound,
	[TABLE_GAME_SOUND_TYPE.TableGameChessMove]: chessMoveSound,
	[TABLE_GAME_SOUND_TYPE.TableGameChessCapture]: chessCaptureSound,
	[TABLE_GAME_SOUND_TYPE.TableGameChessCheck]: chessCheckSound,
	[TABLE_GAME_SOUND_TYPE.TableGameDamaMove]: damaMoveSound,
	[TABLE_GAME_SOUND_TYPE.TableGameDamaCapture]: damaCaptureSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTavlaDice]: tavlaDiceSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTavlaChecker]: tavlaCheckerSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTavlaHit]: tavlaHitSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTavlaBearOff]: tavlaBearOffSound,
	[TABLE_GAME_SOUND_TYPE.TableGameYourTurn]: yourTurnSound,
	[TABLE_GAME_SOUND_TYPE.TableGameTimeLow]: timeLowSound,
	[TABLE_GAME_SOUND_TYPE.TableGameWon]: wonSound,
	[TABLE_GAME_SOUND_TYPE.TableGameEnded]: endedSound,
};

export const TABLE_GAME_SOUND_TYPES: ReadonlyArray<TableGameSoundType> = Object.values(TABLE_GAME_SOUND_TYPE);

const TABLE_GAME_SOUND_TYPE_SET: ReadonlySet<string> = new Set(TABLE_GAME_SOUND_TYPES);

export function isTableGameSoundType(type: string): type is TableGameSoundType {
	return TABLE_GAME_SOUND_TYPE_SET.has(type);
}

// One Fluxer one-shot group for every table sound: a burst plays once.
const TABLE_GAME_ONE_SHOT_SOUND_POLICY = {
	group: 'table-game',
	debounceMs: 60,
	cooldownMs: 120,
	maxWaitMs: 400,
	priority: 15,
};

export const TABLE_GAME_ONE_SHOT_SOUND_POLICIES = Object.fromEntries(
	TABLE_GAME_SOUND_TYPES.map((type) => [type, TABLE_GAME_ONE_SHOT_SOUND_POLICY]),
) as Record<TableGameSoundType, typeof TABLE_GAME_ONE_SHOT_SOUND_POLICY>;

// Table sounds sit at half the level of the other sounds.
export function tableGameSoundVolumeScale(type: string): number {
	return isTableGameSoundType(type) ? 0.5 : 1;
}
