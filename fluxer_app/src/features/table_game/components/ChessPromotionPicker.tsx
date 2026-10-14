// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/table_game/components/ChessPromotionPicker.module.css';
import {chessGlyph} from '@app/features/table_game/utils/ChessFen';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

export type ChessPromotion = 'q' | 'r' | 'b' | 'n';

const PROMOTION_LABEL_DESCRIPTOR = msg({
	message: 'Promote the pawn to',
	comment: 'Table games: chess, choose the piece a pawn becomes on the last rank.',
});
const PROMOTION_DESCRIPTORS: Record<ChessPromotion, MessageDescriptor> = {
	q: msg({message: 'Queen', comment: 'Table games: chess piece.'}),
	r: msg({message: 'Rook', comment: 'Table games: chess piece.'}),
	b: msg({message: 'Bishop', comment: 'Table games: chess piece.'}),
	n: msg({message: 'Knight', comment: 'Table games: chess piece.'}),
};
const PROMOTION_ORDER: ReadonlyArray<ChessPromotion> = ['q', 'r', 'b', 'n'];

// The four pieces a pawn can become, in the promoting side's colour; the 2D board and the seated 3D view both use it.
export function ChessPromotionPicker({
	side,
	onPick,
}: {
	side: 'white' | 'black';
	onPick: (piece: ChessPromotion) => void;
}) {
	const {i18n} = useLingui();
	return (
		<fieldset className={styles.promotion} data-flx="table-game.chess-promotion-picker.promotion">
			<legend className={styles.promotionLabel} data-flx="table-game.chess-promotion-picker.promotion-label">
				{i18n._(PROMOTION_LABEL_DESCRIPTOR)}
			</legend>
			{PROMOTION_ORDER.map((piece) => (
				<button
					key={piece}
					type="button"
					className={styles.promotionChoice}
					data-promotion={piece}
					data-side={side}
					aria-label={i18n._(PROMOTION_DESCRIPTORS[piece])}
					onClick={() => onPick(piece)}
					data-flx="table-game.chess-promotion-picker.button.promotion"
				>
					{chessGlyph(piece)}
				</button>
			))}
		</fieldset>
	);
}
