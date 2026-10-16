// SPDX-License-Identifier: AGPL-3.0-or-later
import styles from '@app/features/game_activity/components/GameActivityRowStatus.module.css';
import {getGameIconUrl} from '@app/features/game_activity/utils/GameIconUrls';
import {getListeningTrack} from '@app/features/game_activity/utils/ListeningActivity';
import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';
import {getGameById} from '@fluxer/game_catalog/src/GameCatalog';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {GameControllerIcon, MusicNotesIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {useEffect, useState} from 'react';

const PLAYING = msg({
	message: 'Playing {name}',
	comment: 'Accessible label for the current game shown under a name in the member and direct message lists.',
});
const GAME = msg({message: 'Game', comment: 'Fallback name for an unknown game ID.'});
const LISTENING = msg({
	message: 'Listening to Spotify · {track}',
	comment:
		'Shown under a name in the member and direct message lists while the user plays music in the Spotify app. {track} is "Artist – Song".',
});

export function GameActivityRowStatus({activity, className}: {activity: GameActivity; className?: string}) {
	const {i18n} = useLingui();
	const gameId = 'game_id' in activity ? activity.game_id : null;
	const game = gameId ? getGameById(gameId) : undefined;
	const track = getListeningTrack(activity);
	const name = 'manual_name' in activity ? activity.manual_name : (game?.name ?? i18n._(GAME));
	const [icon, setIcon] = useState<{id: string; url: string} | null>(null);
	useEffect(() => {
		if (!gameId || !game?.icon) return;
		let cancelled = false;
		void getGameIconUrl(gameId, 64)
			.then((url) => {
				if (!cancelled) setIcon(url ? {id: gameId, url} : null);
			})
			.catch(() => {
				if (!cancelled) setIcon(null);
			});
		return () => {
			cancelled = true;
		};
	}, [gameId, game?.icon]);
	if (track) {
		const label = i18n._({...LISTENING, values: {track}});
		return (
			<div
				className={clsx(styles.root, className)}
				role="img"
				aria-label={label}
				data-flx="game-activity.row-status"
				data-kind="listening"
			>
				<MusicNotesIcon className={styles.icon} aria-hidden />
				<span className={styles.name}>{label}</span>
			</div>
		);
	}
	return (
		<div
			className={clsx(styles.root, className)}
			role="img"
			aria-label={i18n._({...PLAYING, values: {name}})}
			data-flx="game-activity.row-status"
		>
			{icon && icon.id === gameId ? (
				<img className={styles.icon} src={icon.url} alt="" width={14} height={14} />
			) : (
				<GameControllerIcon className={styles.icon} aria-hidden />
			)}
			<span className={styles.name}>{name}</span>
		</div>
	);
}
