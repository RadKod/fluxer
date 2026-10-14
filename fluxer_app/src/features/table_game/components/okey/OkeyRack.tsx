// SPDX-License-Identifier: AGPL-3.0-or-later

import {SoundType} from '@app/features/notification/utils/SoundUtils';
import styles from '@app/features/table_game/components/okey/OkeyRack.module.css';
import {type OkeyFace, RACK_COLUMNS} from '@app/features/table_game/components/okey/OkeyRackModel';
import {OkeyTile} from '@app/features/table_game/components/okey/OkeyTile';
import {playTableUiSound} from '@app/features/table_game/sound/TableGameSounds';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import type React from 'react';
import {useCallback, useRef, useState} from 'react';
import {useDrag, useDrop} from 'react-dnd';

const RACK_LABEL_DESCRIPTOR = msg({
	message: 'Your rack. Arrow keys move between cells, Shift with an arrow carries the tile.',
	comment: 'Table games: Okey, accessible name and keyboard help of the player own tile rack.',
});
const EMPTY_CELL_DESCRIPTOR = msg({
	message: 'Empty cell',
	comment: 'Table games: Okey, an empty place on the rack; a selected tile can be moved here.',
});

const OKEY_TILE_DND_TYPE = 'okey-rack-tile';
const ARROW_STEPS: Partial<Record<string, number>> = {
	ArrowLeft: -1,
	ArrowRight: 1,
	ArrowUp: -RACK_COLUMNS,
	ArrowDown: RACK_COLUMNS,
};

interface RackCellProps {
	index: number;
	tile: RackSlot;
	okey: OkeyFace | null;
	selected: boolean;
	pending: boolean;
	focusable: boolean;
	register: (index: number, node: HTMLButtonElement | null) => void;
	onClick: (index: number) => void;
	onFocus: (index: number) => void;
	onMove: (from: number, to: number) => void;
}

function RackCell({
	index,
	tile,
	okey,
	selected,
	pending,
	focusable,
	register,
	onClick,
	onFocus,
	onMove,
}: RackCellProps) {
	const {i18n} = useLingui();
	const [{dragging}, drag] = useDrag(
		() => ({
			type: OKEY_TILE_DND_TYPE,
			item: () => {
				playTableUiSound(SoundType.TableGameTileDrag);
				return {index};
			},
			canDrag: tile !== null,
			collect: (monitor) => ({dragging: monitor.isDragging()}),
		}),
		[index, tile],
	);
	const [{over}, drop] = useDrop(
		() => ({
			accept: OKEY_TILE_DND_TYPE,
			drop: (item: {index: number}) => {
				if (item.index !== index) onMove(item.index, index);
			},
			collect: (monitor) => ({over: monitor.isOver()}),
		}),
		[index, onMove],
	);
	const ref = useCallback(
		(node: HTMLButtonElement | null) => {
			drag(drop(node));
			register(index, node);
		},
		[drag, drop, register, index],
	);
	return (
		<button
			type="button"
			ref={ref}
			className={styles.cell}
			tabIndex={focusable ? 0 : -1}
			aria-pressed={tile === null ? undefined : selected}
			aria-label={tile === null ? i18n._(EMPTY_CELL_DESCRIPTOR) : undefined}
			data-rack-cell={index}
			data-tile={tile ?? undefined}
			data-pending={pending ? 'true' : undefined}
			data-dragging={dragging ? 'true' : undefined}
			data-over={over ? 'true' : undefined}
			onClick={() => onClick(index)}
			onFocus={() => onFocus(index)}
			data-flx="table-game.okey.okey-rack.rack-cell.cell"
		>
			{tile !== null && <OkeyTile token={tile} okey={okey} data-flx="table-game.okey.okey-rack.rack-cell.okey-tile" />}
		</button>
	);
}

// The player's own rack: two rows of cells, arranged by dragging, by clicking a tile then an empty cell, or from
// the keyboard. Arranging never reaches the server; only actions do.
export function OkeyRack({
	cells,
	okey,
	selected,
	pending,
	onCellClick,
	onMove,
}: {
	cells: ReadonlyArray<RackSlot>;
	okey: OkeyFace | null;
	selected: ReadonlySet<string>;
	pending: string | null;
	onCellClick: (index: number) => void;
	onMove: (from: number, to: number) => void;
}) {
	const {i18n} = useLingui();
	const [focusIndex, setFocusIndex] = useState(0);
	// Arranging stays local (no request); only its sound plays.
	const place = useCallback(
		(from: number, to: number) => {
			playTableUiSound(SoundType.TableGameTilePlace);
			onMove(from, to);
		},
		[onMove],
	);
	const nodes = useRef<Array<HTMLButtonElement | null>>([]);
	const register = useCallback((index: number, node: HTMLButtonElement | null) => {
		nodes.current[index] = node;
	}, []);
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const step = ARROW_STEPS[event.key];
		const from = Number((event.target as HTMLElement).dataset.rackCell);
		if (step === undefined || Number.isNaN(from)) return;
		event.preventDefault();
		const to = from + step;
		if (to < 0 || to >= cells.length) return;
		if (event.shiftKey && cells[from] !== null) place(from, to);
		setFocusIndex(to);
		nodes.current[to]?.focus();
	};
	const rows = [cells.slice(0, RACK_COLUMNS), cells.slice(RACK_COLUMNS)];
	return (
		<div
			className={styles.rack}
			role="group"
			aria-label={i18n._(RACK_LABEL_DESCRIPTOR)}
			onKeyDown={onKeyDown}
			data-flx="table-game.okey.okey-rack.rack"
		>
			{rows.map((row, rowIndex) => (
				<div key={rowIndex} className={styles.row} data-rack-row={rowIndex} data-flx="table-game.okey.okey-rack.row">
					{row.map((tile, column) => {
						const index = rowIndex * RACK_COLUMNS + column;
						return (
							<RackCell
								key={index}
								index={index}
								tile={tile}
								okey={okey}
								selected={tile !== null && selected.has(tile)}
								pending={tile !== null && tile === pending}
								focusable={index === focusIndex}
								register={register}
								onClick={onCellClick}
								onFocus={setFocusIndex}
								onMove={place}
								data-flx="table-game.okey.okey-rack.rack-cell.cell-click"
							/>
						);
					})}
				</div>
			))}
		</div>
	);
}
