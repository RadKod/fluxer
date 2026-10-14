// SPDX-License-Identifier: AGPL-3.0-or-later

import {TABLE_GAME_SOUND_TYPE, type TableGameSoundType} from '@app/features/table_game/sound/TableGameSoundFiles';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const T = TABLE_GAME_SOUND_TYPE;

// Setting labels of the table game sounds (Settings → Notifications → Sounds, "Table game sounds" group).
const TABLE_GAME_SOUND_LABEL_DESCRIPTORS: Record<TableGameSoundType, MessageDescriptor> = {
	[T.TableGameTilePick]: msg({
		message: 'Tile taken from the side',
		comment: 'Table game sound setting label. Okey and 101: a player takes the tile the previous player discarded.',
	}),
	[T.TableGameTilePlace]: msg({
		message: 'Tile placed',
		comment: 'Table game sound setting label. Okey and 101: you place a tile on your own rack.',
	}),
	[T.TableGameTileDrag]: msg({
		message: 'Tile dragged',
		comment: 'Table game sound setting label. Okey and 101: you start dragging a tile.',
	}),
	[T.TableGameTileDraw]: msg({
		message: 'Tile drawn',
		comment: 'Table game sound setting label. Okey and 101: a player draws a tile from the pile.',
	}),
	[T.TableGameTileDiscard]: msg({
		message: 'Tile discarded',
		comment: 'Table game sound setting label. Okey and 101: a player discards a tile.',
	}),
	[T.TableGameShuffle]: msg({
		message: 'Tiles shuffled',
		comment: 'Table game sound setting label. Okey and 101: the tiles are shuffled as the game starts.',
	}),
	[T.TableGameMeldOpen]: msg({
		message: 'Meld laid down',
		comment: 'Table game sound setting label. 101: a player lays sets or pairs on the table, or adds to them.',
	}),
	[T.TableGameOkeyFinish]: msg({
		message: 'Finishing the hand',
		comment: 'Table game sound setting label. Okey and 101: you finish the hand.',
	}),
	[T.TableGameChessMove]: msg({
		message: 'Chess move',
		comment: 'Table game sound setting label. Chess: a piece moves.',
	}),
	[T.TableGameChessCapture]: msg({
		message: 'Chess capture',
		comment: 'Table game sound setting label. Chess: a piece captures another.',
	}),
	[T.TableGameChessCheck]: msg({
		message: 'Check',
		comment: 'Table game sound setting label. Chess: a king is put in check.',
	}),
	[T.TableGameDamaMove]: msg({
		message: 'Draughts move',
		comment: 'Table game sound setting label. Turkish and normal draughts: a piece moves.',
	}),
	[T.TableGameDamaCapture]: msg({
		message: 'Draughts capture',
		comment: 'Table game sound setting label. Turkish and normal draughts: pieces are captured.',
	}),
	[T.TableGameTavlaDice]: msg({
		message: 'Dice roll',
		comment: 'Table game sound setting label. Backgammon: the dice are rolled.',
	}),
	[T.TableGameTavlaChecker]: msg({
		message: 'Checker moved',
		comment: 'Table game sound setting label. Backgammon: checkers are moved.',
	}),
	[T.TableGameTavlaHit]: msg({
		message: 'Checker hit',
		comment: 'Table game sound setting label. Backgammon: a single checker is hit and sent to the bar.',
	}),
	[T.TableGameTavlaBearOff]: msg({
		message: 'Bearing off',
		comment: 'Table game sound setting label. Backgammon: a checker is borne off the board.',
	}),
	[T.TableGameYourTurn]: msg({
		message: 'Your turn',
		comment: 'Table game sound setting label. The turn passes to you.',
	}),
	[T.TableGameTimeLow]: msg({
		message: 'Time running out',
		comment: 'Table game sound setting label. Five seconds or less are left in your turn.',
	}),
	[T.TableGameWon]: msg({
		message: 'You won',
		comment: 'Table game sound setting label. You win a table game.',
	}),
	[T.TableGameEnded]: msg({
		message: 'Game over',
		comment: 'Table game sound setting label. A table game ends without you winning it.',
	}),
};

export function getTableGameSoundLabels(i18n: I18n): Record<TableGameSoundType, string> {
	return Object.fromEntries(
		Object.entries(TABLE_GAME_SOUND_LABEL_DESCRIPTORS).map(([type, descriptor]) => [type, i18n._(descriptor)]),
	) as Record<TableGameSoundType, string>;
}
