// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/table_game/components/okey/Okey101Melds.module.css';
import type {OkeyFace} from '@app/features/table_game/components/okey/OkeyRackModel';
import {OkeyTile} from '@app/features/table_game/components/okey/OkeyTile';
import {Button} from '@app/features/ui/button/Button';
import type {Okey101View, TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

const MELDS_LABEL_DESCRIPTOR = msg({
	message: 'Sets on the table',
	comment: 'Table games: 101 Okey, the sets players have laid down.',
});
const NO_MELDS_DESCRIPTOR = msg({
	message: 'No one has opened yet.',
	comment: 'Table games: 101 Okey, shown while no sets are on the table.',
});
const MELD_OWNER_DESCRIPTOR = msg({
	message: "{name}'s set",
	comment: 'Table games: 101 Okey, a set on the table and who laid it. {name} is a player.',
});
const ADD_START_DESCRIPTOR = msg({
	message: 'Add to start',
	comment: 'Table games: 101 Okey, put the selected tiles before this set on the table.',
});
const ADD_END_DESCRIPTOR = msg({
	message: 'Add to end',
	comment: 'Table games: 101 Okey, put the selected tiles after this set on the table.',
});
const OPENED_SETS_DESCRIPTOR = msg({
	message: 'Opened',
	comment: 'Table games: 101 Okey badge, the player opened with runs and groups.',
});
const OPENED_PAIRS_DESCRIPTOR = msg({
	message: 'Opened pairs',
	comment: 'Table games: 101 Okey badge, the player opened with pairs.',
});
const PENALTY_DESCRIPTOR = msg({
	message: 'Penalty {points}',
	comment: 'Table games: 101 Okey badge, penalty points from discards. {points} is a number like 101.',
});
const SCORES_LABEL_DESCRIPTOR = msg({
	message: 'Hand score (lowest wins)',
	comment: 'Table games: 101 Okey, caption of the end-of-hand score table.',
});

// Sets on the table. A player who has opened adds the selected rack tiles to either end of a set.
export function Okey101Melds({
	view,
	okey,
	nameOf,
	canAdd,
	onAdd,
}: {
	view: Okey101View;
	okey: OkeyFace | null;
	nameOf: (position: number) => string;
	canAdd: boolean;
	onAdd: ((meldId: number, at: 'start' | 'end') => void) | null;
}) {
	const {i18n} = useLingui();
	return (
		<section
			className={styles.melds}
			aria-label={i18n._(MELDS_LABEL_DESCRIPTOR)}
			data-flx="table-game.okey.okey101-melds.melds"
		>
			{view.melds.length === 0 && (
				<p className={styles.empty} data-flx="table-game.okey.okey101-melds.empty">
					{i18n._(NO_MELDS_DESCRIPTOR)}
				</p>
			)}
			{view.melds.map((meld) => (
				<div
					key={meld.id}
					className={styles.meld}
					role="group"
					aria-label={i18n._(MELD_OWNER_DESCRIPTOR, {name: nameOf(meld.owner)})}
					data-meld={meld.id}
					data-kind={meld.kind}
					data-flx="table-game.okey.okey101-melds.meld"
				>
					{onAdd && (
						<Button
							small
							variant="secondary"
							disabled={!canAdd}
							onClick={() => onAdd(meld.id, 'start')}
							data-action="add-start"
							data-flx="table-game.okey.okey101-melds.button.add-start"
						>
							{i18n._(ADD_START_DESCRIPTOR)}
						</Button>
					)}
					<span className={styles.tiles} data-flx="table-game.okey.okey101-melds.tiles">
						{meld.tiles.map((tile) => (
							<OkeyTile
								key={tile}
								token={tile}
								okey={okey}
								size="small"
								data-flx="table-game.okey.okey101-melds.okey-tile"
							/>
						))}
					</span>
					{onAdd && (
						<Button
							small
							variant="secondary"
							disabled={!canAdd}
							onClick={() => onAdd(meld.id, 'end')}
							data-action="add-end"
							data-flx="table-game.okey.okey101-melds.button.add-end"
						>
							{i18n._(ADD_END_DESCRIPTOR)}
						</Button>
					)}
				</div>
			))}
		</section>
	);
}

export function Okey101SeatBadges({view, position}: {view: Okey101View; position: number}) {
	const {i18n} = useLingui();
	const opened = view.opened[position - 1] ?? 'none';
	const penalty = view.penalties[position - 1] ?? 0;
	if (opened === 'none' && penalty === 0) return null;
	return (
		<span className={styles.badges} data-flx="table-game.okey.okey101-seat-badges.badges">
			{opened !== 'none' && (
				<span className={styles.badge} data-opened={opened} data-flx="table-game.okey.okey101-seat-badges.opened">
					{i18n._(opened === 'pairs' ? OPENED_PAIRS_DESCRIPTOR : OPENED_SETS_DESCRIPTOR)}
				</span>
			)}
			{penalty > 0 && (
				<span className={styles.badge} data-penalty={penalty} data-flx="table-game.okey.okey101-seat-badges.penalty">
					{i18n._(PENALTY_DESCRIPTOR, {points: penalty})}
				</span>
			)}
		</span>
	);
}

// The hand's scores, lowest first; the server's winners are marked (ties share).
export function Okey101Scores({
	view,
	summary,
	nameOf,
}: {
	view: Okey101View;
	summary: TableGameSummary;
	nameOf: (position: number) => string;
}) {
	const {i18n} = useLingui();
	const scores = view.scores;
	if (!scores) return null;
	const winners = summary.result?.kind === 'win' ? summary.result.winners : [];
	const rows = [1, 2, 3, 4].sort((a, b) => scores[a - 1]! - scores[b - 1]!);
	return (
		<table className={styles.scores} data-scores="true" data-flx="table-game.okey.okey101-scores.scores">
			<caption className={styles.caption} data-flx="table-game.okey.okey101-scores.caption">
				{i18n._(SCORES_LABEL_DESCRIPTOR)}
			</caption>
			<tbody data-flx="table-game.okey.okey101-scores.body">
				{rows.map((position) => (
					<tr
						key={position}
						data-score-position={position}
						data-winner={winners.includes(position) ? 'true' : undefined}
						data-flx="table-game.okey.okey101-scores.row"
					>
						<th scope="row" className={styles.scoreName} data-flx="table-game.okey.okey101-scores.name">
							{nameOf(position)}
						</th>
						<td className={styles.scoreValue} data-flx="table-game.okey.okey101-scores.value">
							{scores[position - 1]}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
