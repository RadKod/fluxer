// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChessPromotionPicker} from '@app/features/table_game/components/ChessPromotionPicker';
import TableGames from '@app/features/table_game/state/TableGames';
import {Button} from '@app/features/ui/button/Button';
import styles from '@app/features/voice_scene/components/VoiceSceneSeatHud.module.css';
import type {TableSceneHud} from '@app/features/voice_scene/hooks/useTableGameScene';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import type {Ref} from 'react';

const BACK_TO_ROOM_DESCRIPTOR = msg({
	message: 'Back to room',
	comment:
		'3D voice room, seated at a table: leave the close-up table view and look at the whole room. You keep your seat.',
});
const TABLE_PANEL_DESCRIPTOR = msg({
	message: 'Table panel',
	comment:
		'3D voice room, seated at a table: open the flat table panel (the same game as buttons and lists; for keyboard and screen readers).',
});
const OPEN_STAGED_DESCRIPTOR = msg({
	message: 'Open ({count})',
	comment:
		'3D voice room, 101 Okey: lay down the sets placed on the table so far; {count} is how many tiles they hold.',
});
const CANCEL_DESCRIPTOR = msg({
	message: 'Cancel',
	context: 'voice-scene-seat-hud',
	comment: '3D voice room, at a table: drop the pending sets or the path choice and put the pieces back.',
});
const UNDO_STEP_DESCRIPTOR = msg({
	message: 'Undo',
	context: 'voice-scene-seat-hud',
	comment: '3D voice room, tavla: take back the last checker move of this turn (not sent yet).',
});
const DONE_TURN_DESCRIPTOR = msg({
	message: 'Done',
	context: 'voice-scene-seat-hud',
	comment: '3D voice room, tavla: send the moves of this turn.',
});
const CHOOSE_PATH_DESCRIPTOR = msg({
	message: 'Which way?',
	comment: '3D voice room, dama: several capture paths lead to the same square; pick the one to play.',
});

// The seat view's controls, on the right edge so my rack (bottom centre) and the room toolbar (bottom left) stay
// clear. Watchers get only the way out and the panel; the table itself is driven by dragging.
export function VoiceSceneSeatHud({
	hud,
	channelId,
	slot,
	onExit,
	ref,
}: {
	// null while the table has no view yet (a free table, or before the first read).
	hud: TableSceneHud | null;
	channelId: string;
	slot: string;
	onExit: () => void;
	// The table panel opens beside the HUD.
	ref?: Ref<HTMLDivElement>;
}) {
	const {i18n} = useLingui();
	const playing = hud?.role === 'player' && hud.interactive ? hud : null;
	return (
		<div ref={ref} className={styles.hud} data-seat-hud="" data-flx="voice-scene.voice-scene-seat-hud.hud">
			<Button
				small
				compact
				fitContainer
				variant="inverted"
				onClick={onExit}
				data-flx="voice-scene.voice-scene-seat-hud.button.exit"
			>
				{i18n._(BACK_TO_ROOM_DESCRIPTOR)}
			</Button>
			<Button
				small
				compact
				fitContainer
				variant="inverted-outline"
				onClick={() => TableGames.requestPanel(channelId, slot)}
				data-flx="voice-scene.voice-scene-seat-hud.button.request-panel"
			>
				{i18n._(TABLE_PANEL_DESCRIPTOR)}
			</Button>
			{playing?.game === 'okey101' && playing.stage ? (
				<div className={styles.group} data-flx="voice-scene.voice-scene-seat-hud.group">
					<Button
						small
						compact
						fitContainer
						variant="inverted"
						onClick={playing.openStage}
						data-flx="voice-scene.voice-scene-seat-hud.button.open-stage"
					>
						{i18n._(OPEN_STAGED_DESCRIPTOR, {count: playing.stagedCount})}
					</Button>
					<Button
						small
						compact
						fitContainer
						variant="inverted-outline"
						onClick={playing.cancelStage}
						data-flx="voice-scene.voice-scene-seat-hud.button.cancel-stage"
					>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
				</div>
			) : null}
			{playing?.game === 'tavla' && playing.tavlaSteps.length > 0 ? (
				<div className={styles.group} data-flx="voice-scene.voice-scene-seat-hud.group--2">
					<Button
						small
						compact
						fitContainer
						variant="inverted-outline"
						onClick={playing.undoTavla}
						data-flx="voice-scene.voice-scene-seat-hud.button.undo-tavla"
					>
						{i18n._(UNDO_STEP_DESCRIPTOR)}
					</Button>
					<Button
						small
						compact
						fitContainer
						variant="inverted"
						disabled={!playing.tavlaComplete}
						onClick={playing.confirmTavla}
						data-flx="voice-scene.voice-scene-seat-hud.button.confirm-tavla"
					>
						{i18n._(DONE_TURN_DESCRIPTOR)}
					</Button>
				</div>
			) : null}
			{playing?.pathChoice ? (
				<div
					className={styles.group}
					role="group"
					aria-label={i18n._(CHOOSE_PATH_DESCRIPTOR)}
					data-flx="voice-scene.voice-scene-seat-hud.group--3"
				>
					<span className={styles.caption} data-flx="voice-scene.voice-scene-seat-hud.caption">
						{i18n._(CHOOSE_PATH_DESCRIPTOR)}
					</span>
					{playing.pathChoice.map((path) => (
						<Button
							key={path.join('-')}
							small
							compact
							fitContainer
							variant="inverted-outline"
							onClick={() => playing.choosePath(path)}
							onMouseEnter={() => playing.previewPath(path)}
							onMouseLeave={() => playing.previewPath(null)}
							onFocus={() => playing.previewPath(path)}
							onBlur={() => playing.previewPath(null)}
							data-flx="voice-scene.voice-scene-seat-hud.button.choose-path"
						>
							{path.join(' → ')}
						</Button>
					))}
					<Button
						small
						compact
						fitContainer
						variant="inverted-outline"
						onClick={playing.dismissChoice}
						data-flx="voice-scene.voice-scene-seat-hud.button.dismiss-choice"
					>
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
				</div>
			) : null}
			{playing?.promotion ? (
				<ChessPromotionPicker
					side={playing.promotion.side}
					onPick={playing.pickPromotion}
					data-flx="voice-scene.voice-scene-seat-hud.chess-promotion-picker"
				/>
			) : null}
		</div>
	);
}
