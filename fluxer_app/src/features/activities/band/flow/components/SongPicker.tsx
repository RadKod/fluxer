// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandQueueEntry} from '@app/features/activities/band/BandProtocol';
import {
	PICKER_ADD_DESCRIPTOR,
	PICKER_CLOSE_DESCRIPTOR,
	PICKER_EMPTY_DESCRIPTOR,
	PICKER_QUEUED_DESCRIPTOR,
	PICKER_SEARCH_DESCRIPTOR,
	PICKER_TITLE_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import styles from '@app/features/activities/band/flow/components/SongPicker.module.css';
import {formatSongLength} from '@app/features/activities/band/flow/components/useBandNow';
import {useLingui} from '@lingui/react/macro';
import {XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useId, useRef, useState} from 'react';

interface SongPickerProps {
	readonly room: BandRoom;
	readonly queue: ReadonlyArray<BandQueueEntry>;
	readonly onClose: () => void;
}

function matches(text: string, query: string, locale: string): boolean {
	return text.toLocaleLowerCase(locale).includes(query);
}

export const SongPicker = observer(function SongPicker({room, queue, onClose}: SongPickerProps) {
	const {i18n} = useLingui();
	const titleId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	useEffect(() => searchRef.current?.focus(), []);

	const needle = query.trim().toLocaleLowerCase(i18n.locale);
	const songs = room.library.songs.filter(
		(song) => !needle || matches(song.name, needle, i18n.locale) || matches(song.artist, needle, i18n.locale),
	);
	const queued = new Set(queue.map((entry) => entry.songId));
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		onClose();
	};

	return (
		<div
			className={styles.picker}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onKeyDown={onKeyDown}
			data-flx="activities.band.flow.song-picker.picker.key-down"
		>
			<header className={styles.header} data-flx="activities.band.flow.song-picker.header">
				<h3 id={titleId} className={styles.title} data-flx="activities.band.flow.song-picker.title">
					{i18n._(PICKER_TITLE_DESCRIPTOR)}
				</h3>
				<button
					type="button"
					className={styles.close}
					onClick={onClose}
					aria-label={i18n._(PICKER_CLOSE_DESCRIPTOR)}
					data-flx="activities.band.flow.song-picker.close.button"
				>
					<XIcon weight="bold" data-flx="activities.band.flow.song-picker.x-icon" />
				</button>
			</header>
			<input
				ref={searchRef}
				className={styles.search}
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={i18n._(PICKER_SEARCH_DESCRIPTOR)}
				aria-label={i18n._(PICKER_SEARCH_DESCRIPTOR)}
				data-flx="activities.band.flow.song-picker.search.set-query"
			/>
			{songs.length === 0 ? (
				<p className={styles.empty} data-flx="activities.band.flow.song-picker.empty">
					{i18n._(PICKER_EMPTY_DESCRIPTOR)}
				</p>
			) : (
				<ul className={styles.list} data-flx="activities.band.flow.song-picker.list">
					{songs.map((song) => (
						<li key={song.id} className={styles.row} data-flx="activities.band.flow.song-picker.row">
							<BandSongCover
								song={song}
								sizeRem={2.75}
								showArtist={false}
								data-flx="activities.band.flow.song-picker.band-song-cover"
							/>
							<span className={styles.text} data-flx="activities.band.flow.song-picker.text">
								<b data-flx="activities.band.flow.song-picker.b">{song.name}</b>
								<span data-flx="activities.band.flow.song-picker.span">{song.artist}</span>
							</span>
							<span className={styles.length} data-flx="activities.band.flow.song-picker.length">
								{formatSongLength(song.lengthMs)}
							</span>
							{queued.has(song.id) ? (
								<span className={styles.queued} data-flx="activities.band.flow.song-picker.queued">
									{i18n._(PICKER_QUEUED_DESCRIPTOR)}
								</span>
							) : (
								<button
									type="button"
									className={styles.add}
									onClick={() => room.send({t: 'band.queueAdd', songId: song.id})}
									data-flx="activities.band.flow.song-picker.add.send.button"
								>
									{i18n._(PICKER_ADD_DESCRIPTOR)}
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
});
