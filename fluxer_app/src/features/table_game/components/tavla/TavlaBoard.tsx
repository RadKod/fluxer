// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import * as TableGameCommands from '@app/features/table_game/commands/TableGameCommands';
import styles from '@app/features/table_game/components/tavla/TavlaBoard.module.css';
import {tavlaBoardModel} from '@app/features/table_game/components/tavla/TavlaBoardModel';
import TableGames from '@app/features/table_game/state/TableGames';
import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import {tableGameOutcomeDescriptor} from '@app/features/table_game/utils/TableGameMessages';
import {completes, expandTavlaPlays, nextLegalSteps, type TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import {Button} from '@app/features/ui/button/Button';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameView, TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';

const BOARD = msg({message: 'Tavla board', comment: 'Accessible name of the Tavla board.'});
const POINT = msg({
	message: 'Point {point}: {count} {color} checkers',
	comment: 'Tavla point, checker count and color.',
});
const WHITE = msg({message: 'white', comment: 'Tavla checker color.'});
const BLACK = msg({message: 'black', comment: 'Tavla checker color.'});
const BAR = msg({message: 'Bar', comment: 'Tavla: captured checkers waiting to re-enter.'});
const OFF = msg({message: 'Borne off', comment: 'Tavla: checkers removed from the board.'});
const DICE = msg({message: 'Dice: {first} and {second}', comment: 'Tavla server roll.'});
const UNDO = msg({message: 'Undo', comment: 'Tavla: undo your last unsent step.'});
const DONE = msg({
	message: 'Done',
	context: 'table-game-tavla',
	comment: 'Tavla: send your complete turn again after a failed request.',
});
const TIME = msg({message: '{seconds} seconds left', comment: 'Tavla: remaining turn time.'});

export const TavlaBoard = observer(function TavlaBoard({channel, slot}: {channel: Channel; slot: string}) {
	const table = TableGames.getView(channel.id, slot);
	const view = table?.game_view?.game === 'tavla' ? table.game_view : null;
	if (!table || !view) return null;
	// A move invalidates the whole local draft, even when consecutive rolls have identical faces; a version bump that
	// changes no game state (the minute presence check) keeps it.
	const roll = tableDraftKey(table);
	return (
		<TavlaTurn
			key={`${channel.id}:${slot}:${table.viewer_position}:${table.summary.status}:${roll}`}
			channelId={channel.id}
			slot={slot}
			table={table}
			view={view}
			roll={roll}
			data-flx="table-game.tavla-board.turn"
		/>
	);
});

const TavlaTurn = observer(function TavlaTurn({
	channelId,
	slot,
	table,
	view,
	roll,
}: {
	channelId: string;
	slot: string;
	table: TableGameView;
	view: TavlaView;
	roll: string;
}) {
	const {i18n} = useLingui();
	const [steps, setSteps] = useState<Array<TavlaStep>>([]);
	const [selected, setSelected] = useState<number | 'bar' | null>(null);
	const [locked, setLocked] = useState(false);
	const sent = useRef(false);
	const mounted = useRef(true);
	const [error, setError] = useState<MessageDescriptor | null>(null);
	const [now, setNow] = useState(Date.now);
	const boardRef = useRef<HTMLDivElement>(null);
	const running = table.summary.status === 'playing' && view.turn !== null && view.deadline_at !== null;
	const deadline = running ? Date.parse(view.deadline_at!) : null;
	const remaining = deadline === null ? 0 : Math.max(0, deadline - now);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (deadline === null || deadline <= Date.now()) return;
		const timer = setInterval(() => {
			setNow(Date.now());
			if (Date.now() >= deadline) clearInterval(timer);
		}, 250);
		return () => clearInterval(timer);
	}, [deadline]);
	const canPlay =
		table.summary.status === 'playing' &&
		!table.spectating &&
		table.viewer_position !== null &&
		table.viewer_position === view.turn &&
		!locked;
	const model = useMemo(
		() => tavlaBoardModel(view, table.viewer_position, steps),
		[view, table.viewer_position, steps],
	);
	const sign = model.side === 'white' ? 1 : -1;
	const plays = useMemo(() => expandTavlaPlays(view), [view]);
	const next = useMemo(
		() =>
			canPlay
				? nextLegalSteps(plays, steps).filter((step) => {
						// The helper matches multisets: a later chain step is offered only after its source checker exists.
						if (model.bar[model.side] > 0) return step.from === 'bar';
						return step.from !== 'bar' && model.points[step.from - 1]! * sign > 0;
					})
				: [],
		[canPlay, plays, steps, model, sign],
	);
	const targets = new Set(next.filter((step) => step.from === selected).map((step) => step.to));
	const complete = useMemo(() => completes(plays, steps), [plays, steps]);

	const send = async (moves: Array<TavlaStep>) => {
		if (!canPlay || sent.current || !completes(plays, moves)) return;
		sent.current = true;
		setLocked(true);
		setSelected(null);
		setError(null);
		const outcome = await TableGameCommands.act(channelId, slot, {type: 'tavla_move', moves});
		if (!mounted.current) return;
		setError(tableGameOutcomeDescriptor(outcome));
		// Success stays locked until the authoritative next version; failures require an explicit retry.
		if (!outcome.ok) {
			sent.current = false;
			setLocked(false);
		}
	};
	const pick = (point: number | 'bar' | 'off') => {
		if (!canPlay || sent.current) return;
		if (selected !== null && point !== 'bar' && targets.has(point)) {
			const moves = [...steps, {from: selected, to: point}];
			setSteps(moves);
			setSelected(null);
			setError(null);
			if (completes(plays, moves)) void send(moves);
		} else setSelected(point !== 'off' && next.some((step) => step.from === point) ? point : null);
	};
	const keyboard = (event: KeyboardEvent<HTMLButtonElement>, point: number | 'bar' | 'off') => {
		if (event.key === 'Escape') {
			setSelected(null);
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			pick(point);
			return;
		}
		const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
		if (!horizontal && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		const rows: Array<Array<number | 'bar' | 'off'>> = [
			model.order.slice(0, 12),
			['bar', 'off'],
			model.order.slice(12),
		];
		const row = typeof point === 'number' ? (model.order.indexOf(point) < 12 ? 0 : 2) : 1;
		const column = rows[row]!.indexOf(point);
		let target = point;
		if (horizontal) {
			const delta = event.key === 'ArrowLeft' ? -1 : 1;
			target = rows[row]![Math.max(0, Math.min(rows[row]!.length - 1, column + delta))]!;
		} else {
			const nextRow = Math.max(0, Math.min(2, row + (event.key === 'ArrowUp' ? -1 : 1)));
			// Bar and off each span six columns; leaving them lands at the left of their two center points.
			if (row === 1) target = rows[nextRow]![column * 6 + 2]!;
			else if (nextRow === 1) target = rows[1]![Math.floor(column / 6)]!;
		}
		boardRef.current?.querySelector<HTMLButtonElement>(`[data-point="${target}"]`)?.focus();
	};
	const seconds = Math.ceil(remaining / 1000);
	const turnSeconds = TABLE_GAME_TURN_MS.tavla[table.summary.speed] / 1000;
	const opponent = model.side === 'white' ? 'black' : 'white';
	return (
		<div className={styles.root} data-flx="table-game.tavla-board.root">
			<div className={styles.toolbar} data-flx="table-game.tavla-board.toolbar">
				<div
					role="group"
					className={styles.dice}
					data-dice
					data-roll={roll}
					aria-label={view.dice ? i18n._(DICE, {first: view.dice[0], second: view.dice[1]}) : undefined}
					data-flx="table-game.tavla-board.dice"
				>
					{view.dice?.map((die, index) => (
						<span key={`${roll}:${index}`} className={styles.die} data-flx="table-game.tavla-board.die">
							{die}
						</span>
					))}
				</div>
				{running && (
					<div
						className={styles.timer}
						role="progressbar"
						aria-label={i18n._(TIME, {seconds})}
						aria-valuemin={0}
						aria-valuemax={turnSeconds}
						aria-valuenow={Math.min(seconds, turnSeconds)}
						style={{'--remaining': `${Math.min(1, remaining / (turnSeconds * 1000)) * 360}deg`} as CSSProperties}
						data-flx="table-game.tavla-board.timer"
					>
						<span data-flx="table-game.tavla-board.seconds">{seconds}</span>
					</div>
				)}
			</div>
			<div
				ref={boardRef}
				role="group"
				aria-label={i18n._(BOARD)}
				className={styles.board}
				data-flx="table-game.tavla-board.board"
			>
				{model.order.map((point, index) => {
					const count = model.points[point - 1]!;
					const color = count < 0 ? 'black' : 'white';
					return (
						<button
							key={point}
							type="button"
							className={styles.point}
							data-point={point}
							data-count={count}
							data-color={color}
							data-row={index < 12 ? 'top' : 'bottom'}
							data-selected={selected === point ? 'true' : undefined}
							data-target={targets.has(point) ? 'true' : undefined}
							aria-pressed={selected === point}
							aria-label={i18n._(POINT, {
								point,
								count: Math.abs(count),
								color: i18n._(color === 'white' ? WHITE : BLACK),
							})}
							onClick={() => pick(point)}
							onKeyDown={(event) => keyboard(event, point)}
							data-flx="table-game.tavla-board.point"
						>
							<span className={styles.number} data-flx="table-game.tavla-board.number">
								{point}
							</span>
							{Array.from({length: Math.min(Math.abs(count), 5)}, (_, i) => (
								<span
									key={`${point}:${i}`}
									className={styles.checker}
									aria-hidden="true"
									data-flx="table-game.tavla-board.checker"
								/>
							))}
							{Math.abs(count) > 5 && (
								<span className={styles.count} data-flx="table-game.tavla-board.count">
									{Math.abs(count)}
								</span>
							)}
						</button>
					);
				})}
				<button
					type="button"
					className={styles.bar}
					data-point="bar"
					data-selected={selected === 'bar' ? 'true' : undefined}
					aria-pressed={selected === 'bar'}
					onClick={() => pick('bar')}
					onKeyDown={(event) => keyboard(event, 'bar')}
					data-flx="table-game.tavla-board.bar"
				>
					<span data-flx="table-game.tavla-board.bar-label">{i18n._(BAR)}</span>
					<span data-bar={opponent} data-color={opponent} data-flx="table-game.tavla-board.bar-opponent">
						{i18n._(opponent === 'white' ? WHITE : BLACK)}: {model.bar[opponent]}
					</span>
					<span data-bar={model.side} data-color={model.side} data-flx="table-game.tavla-board.bar-own">
						{i18n._(model.side === 'white' ? WHITE : BLACK)}: {model.bar[model.side]}
					</span>
				</button>
				<button
					type="button"
					className={styles.off}
					data-point="off"
					data-target={targets.has('off') ? 'true' : undefined}
					onClick={() => pick('off')}
					onKeyDown={(event) => keyboard(event, 'off')}
					data-flx="table-game.tavla-board.off"
				>
					<span data-flx="table-game.tavla-board.off-label">{i18n._(OFF)}</span>
					<span data-flx="table-game.tavla-board.off-opponent">
						{i18n._(opponent === 'white' ? WHITE : BLACK)}: {model.off[opponent]}
					</span>
					<span data-flx="table-game.tavla-board.off-own">
						{i18n._(model.side === 'white' ? WHITE : BLACK)}: {model.off[model.side]}
					</span>
				</button>
			</div>
			<div className={styles.actions} data-flx="table-game.tavla-board.actions">
				<Button
					small
					disabled={!canPlay || steps.length === 0}
					onClick={() => {
						setSteps(steps.slice(0, -1));
						setSelected(null);
						setError(null);
					}}
					data-flx="table-game.tavla-board.undo"
				>
					{i18n._(UNDO)}
				</Button>
				<Button
					small
					disabled={!canPlay || !complete}
					onClick={() => {
						void send(steps);
					}}
					data-flx="table-game.tavla-board.done"
				>
					{i18n._(DONE)}
				</Button>
			</div>
			{error && (
				<p className={styles.error} role="alert" data-flx="table-game.tavla-board.error">
					{i18n._(error)}
				</p>
			)}
		</div>
	);
});
