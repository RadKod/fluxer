// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import styles from '@app/features/table_game/components/TableGameResult.module.css';
import {UPDATE_APP_DESCRIPTOR} from '@app/features/table_game/utils/TableGameMessages';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {isKnownTableGameKind} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameResult as TableGameResultValue,
	TableGameSummary,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const WON_DESCRIPTOR = msg({
	message: '{names} won',
	comment: 'Table games: result. {names} is one or more player names.',
});
const DRAW_DESCRIPTOR = msg({message: 'Draw', comment: 'Table games: the game ended without a winner.'});
const CANCELED_DESCRIPTOR = msg({
	message: 'The table was closed',
	comment: 'Table games: the table ended without a result.',
});
const LEFT_DESCRIPTOR = msg({
	message: '{name} left the table and lost',
	comment: 'Table games: result when a player left on purpose. {name} is the player.',
});
const DISCONNECTED_DESCRIPTOR = msg({
	message: '{name} did not come back in time and lost',
	comment: 'Table games: result when a player lost the connection for over 30 seconds. {name} is the player.',
});
const TIMEOUTS_DESCRIPTOR = msg({
	message: '{name} missed two turns in a row and lost',
	comment: 'Table games: result when a player ran out of time twice in a row. {name} is the player.',
});

const DETAIL_DESCRIPTORS: Partial<Record<string, MessageDescriptor>> = {
	checkmate: msg({message: 'Checkmate', comment: 'Table games: chess result detail.'}),
	timeout: msg({
		message: 'On time',
		comment: 'Table games: chess or draughts result detail, the other side ran out of time.',
	}),
	resign: msg({message: 'By resignation', comment: 'Table games: chess result detail.'}),
	pairs: msg({message: 'Finished with pairs', comment: 'Table games: Okey result detail.'}),
	okey: msg({message: 'Finished with the okey', comment: 'Table games: Okey result detail.'}),
	hand: msg({message: 'Finished in one go', comment: 'Table games: 101 Okey, finished without opening earlier.'}),
	score: msg({message: 'Lowest score', comment: 'Table games: 101 Okey result detail.'}),
	pile_empty: msg({message: 'The pile ran out', comment: 'Table games: Okey draw detail.'}),
	stalemate: msg({message: 'Stalemate', comment: 'Table games: chess draw detail.'}),
	insufficient: msg({message: 'Not enough pieces to mate', comment: 'Table games: chess draw detail.'}),
	threefold: msg({message: 'Same position three times', comment: 'Table games: chess draw detail.'}),
	fifty_move: msg({message: 'Fifty moves without a capture', comment: 'Table games: chess draw detail.'}),
	bear_off: msg({message: 'All checkers borne off', comment: 'Table games: backgammon result detail.'}),
	mars: msg({
		message: 'Gammon',
		comment: 'Table games: backgammon, the winner finished before the loser bore off any checker (Mars).',
	}),
	no_pieces: msg({message: 'No pieces left', comment: 'Table games: draughts result detail, every piece was taken.'}),
	blocked: msg({message: 'No moves left', comment: 'Table games: draughts result detail, the loser could not move.'}),
	move_limit: msg({
		message: '25 moves without progress',
		comment: 'Table games: draughts draw detail, 25 moves each without a capture or a man moving forward.',
	}),
	lone_kings: msg({message: 'One king each', comment: 'Table games: Turkish draughts draw detail.'}),
	disabled: msg({message: 'Table games were turned off', comment: 'Table games: why a table closed.'}),
	theme_changed: msg({message: 'The room changed', comment: 'Table games: why a table closed.'}),
	abandoned: msg({message: 'Nobody started the game', comment: 'Table games: why a table closed.'}),
};

function detailKey(result: TableGameResultValue): string {
	if (result.kind === 'win') return result.finish && result.finish !== 'normal' ? result.finish : result.reason;
	return result.reason;
}

export const TableGameResult = observer(function TableGameResult({
	channel,
	summary,
}: {
	channel: Channel;
	summary: TableGameSummary;
}) {
	const {i18n} = useLingui();
	const result = summary.result;
	if (!result) return null;
	if (!isKnownTableGameKind(summary.game)) {
		return (
			<WarningAlert data-flx="table-game.table-game-result.update-notice">{i18n._(UPDATE_APP_DESCRIPTOR)}</WarningAlert>
		);
	}
	const nameAt = (position: number) => {
		const userId = summary.players.find((player) => player.position === position)?.user_id;
		const user = userId ? Users.getUser(userId) : undefined;
		return user ? NicknameUtils.getNickname(user, channel.guildId) : '';
	};
	let title: string;
	switch (result.kind) {
		case 'win':
			title = i18n._(WON_DESCRIPTOR, {names: result.winners.map(nameAt).join(', ')});
			break;
		case 'forfeit': {
			const descriptor =
				result.reason === 'leave'
					? LEFT_DESCRIPTOR
					: result.reason === 'disconnect'
						? DISCONNECTED_DESCRIPTOR
						: TIMEOUTS_DESCRIPTOR;
			title = i18n._(descriptor, {name: nameAt(result.loser)});
			break;
		}
		case 'draw':
			title = i18n._(DRAW_DESCRIPTOR);
			break;
		case 'canceled':
			title = i18n._(CANCELED_DESCRIPTOR);
			break;
	}
	const detail = result.kind === 'forfeit' ? undefined : DETAIL_DESCRIPTORS[detailKey(result)];
	return (
		<output className={styles.banner} data-result={result.kind} data-flx="table-game.table-game-result.banner">
			<span className={styles.title} data-flx="table-game.table-game-result.title">
				{title}
			</span>
			{detail && (
				<span className={styles.detail} data-flx="table-game.table-game-result.detail">
					{i18n._(detail)}
				</span>
			)}
		</output>
	);
});
