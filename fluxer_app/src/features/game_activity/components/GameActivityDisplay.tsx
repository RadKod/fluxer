// SPDX-License-Identifier: AGPL-3.0-or-later
import styles from '@app/features/game_activity/components/GameActivityDisplay.module.css';
import {useGameActivity} from '@app/features/game_activity/hooks/useGameActivity';
import GameActivityMinuteClock, {
	getGameActivityElapsed,
} from '@app/features/game_activity/state/GameActivityMinuteClock';
import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import DesktopGameActivityBridge from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import {getGameIconUrl} from '@app/features/game_activity/utils/GameIconUrls';
import {getListeningTrack} from '@app/features/game_activity/utils/ListeningActivity';
import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';
import Relationships from '@app/features/relationship/state/Relationships';
import Users from '@app/features/user/state/Users';
import {getGameById} from '@fluxer/game_catalog/src/GameCatalog';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {GameControllerIcon, MusicNotesIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';

const PLAYING = msg({message: 'Playing now', comment: 'Profile label above the current game.'});
const LOCAL = msg({
	message: 'Local preview',
	comment: 'Self profile game preview from this device, not proof of sharing.',
});
const GAME = msg({message: 'Game', comment: 'Fallback name for an unknown game ID.'});
const MINUTES = msg({message: '{minutes} min', comment: 'Elapsed game duration in minutes.'});
const LISTENING = msg({
	message: 'Listening to Spotify',
	comment: 'Profile label above the song the user is playing in the Spotify app (shown instead of Playing now).',
});

export const GameActivityDisplay = observer(({userId, visible = true}: {userId: string; visible?: boolean}) => {
	const ref = useRef<HTMLDivElement>(null);
	const [intersecting, setIntersecting] = useState(typeof IntersectionObserver === 'undefined');
	const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden');
	const self = userId === Users.currentUser?.id;
	const allowed = GameActivityStore.enabled && (self || !Relationships.isBlocked(userId));
	const active = allowed && visible && intersecting && documentVisible;
	const remoteActivity = useGameActivity({userId, enabled: active && !self});
	const activity = self ? DesktopGameActivityBridge.activity : remoteActivity;
	useEffect(() => {
		if (!allowed || !visible) return;
		const updateVisibility = () => setDocumentVisible(document.visibilityState !== 'hidden');
		document.addEventListener('visibilitychange', updateVisibility);
		const target = ref.current;
		const intersection =
			typeof IntersectionObserver === 'undefined'
				? null
				: new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
		if (target) intersection?.observe(target);
		return () => {
			document.removeEventListener('visibilitychange', updateVisibility);
			intersection?.disconnect();
		};
	}, [allowed, visible]);
	if (!allowed || !visible) return null;
	return (
		<div ref={ref} className={styles.container} data-flx="game-activity.display">
			{active && activity && <VisibleGameActivity activity={activity} local={self} />}
		</div>
	);
});

function VisibleGameActivity({activity, local}: {activity: GameActivity; local: boolean}) {
	const {i18n} = useLingui();
	const now = useSyncExternalStore(
		GameActivityMinuteClock.subscribe,
		GameActivityMinuteClock.getSnapshot,
		GameActivityMinuteClock.getSnapshot,
	);
	const gameId = 'game_id' in activity ? activity.game_id : null;
	const game = gameId ? getGameById(gameId) : undefined;
	const [icon, setIcon] = useState<{id: string; url: string} | null>(null);
	useEffect(() => {
		let cancelled = false;
		if (gameId && game?.icon) {
			void getGameIconUrl(gameId, 64)
				.then((url: string | null) => {
					if (!cancelled) setIcon(url ? {id: gameId, url} : null);
				})
				.catch(() => {
					if (!cancelled) setIcon(null);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [gameId, game?.icon]);
	const minutes = Math.floor(getGameActivityElapsed(activity.started_at, now) / 60_000);
	const track = getListeningTrack(activity);
	if (track) {
		return (
			<div className={styles.activity} data-kind="listening">
				<MusicNotesIcon size={40} aria-hidden className={styles.icon} />
				<div className={styles.details}>
					<div className={styles.label}>{i18n._(local ? LOCAL : LISTENING)}</div>
					<div className={styles.name}>{track}</div>
				</div>
			</div>
		);
	}
	return (
		<div className={styles.activity}>
			{icon && icon.id === gameId ? (
				<img className={styles.icon} src={icon.url} alt="" width={40} height={40} />
			) : (
				<GameControllerIcon size={40} aria-hidden className={styles.icon} />
			)}
			<div className={styles.details}>
				<div className={styles.label}>{i18n._(local ? LOCAL : PLAYING)}</div>
				<div className={styles.name}>
					{'manual_name' in activity ? activity.manual_name : (game?.name ?? i18n._(GAME))}
				</div>
				<div className={styles.duration}>{i18n._({...MINUTES, values: {minutes}})}</div>
			</div>
		</div>
	);
}
