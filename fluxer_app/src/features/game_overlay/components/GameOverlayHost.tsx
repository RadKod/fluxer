// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/game_overlay/components/GameOverlayHost.module.css';
import GameOverlaySettings from '@app/features/game_overlay/state/GameOverlaySettings';
import {
	computeGameOverlaySize,
	type GameOverlayMicState,
	getGameOverlayMicState,
	selectGameOverlayEntries,
} from '@app/features/game_overlay/utils/GameOverlayModel';
import {isGameOverlaySupported} from '@app/features/game_overlay/utils/GameOverlaySupport';
import GuildMembers from '@app/features/member/state/GuildMembers';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {getElectronAPI} from '@app/features/ui/utils/NativeUtils';
import type {User} from '@app/features/user/models/User';
import * as AvatarUtils from '@app/features/user/utils/AvatarUtils';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {
	copyStylesheetsIntoDocument,
	observeDocumentStylesheets,
	observeDocumentThemeAttributes,
	syncDocumentThemeAttributes,
} from '@app/features/voice/components/popout/PopoutWindowDocument';
import {useVoiceParticipantAvatarEntries} from '@app/features/voice/components/VoiceParticipantAvatarList';
import MediaEngine, {useMediaEngineVersion} from '@app/features/voice/engine/MediaEngineFacade';
import {MicrophoneIcon, MicrophoneSlashIcon, SpeakerSlashIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useState} from 'react';
import {createPortal} from 'react-dom';

const GAME_OVERLAY_WINDOW_NAME = 'fluxer-game-overlay';
const TRANSPARENT_DOCUMENT_CSS = 'html, body { background: transparent !important; margin: 0; overflow: hidden; }';
const logger = new Logger('GameOverlayHost');
const MIC_STATE_ICONS: Record<GameOverlayMicState, typeof MicrophoneIcon> = {
	on: MicrophoneIcon,
	muted: MicrophoneSlashIcon,
	deafened: SpeakerSlashIcon,
};

const GameOverlayMicBadge: React.FC<{state: GameOverlayMicState}> = ({state}) => {
	const Icon = MIC_STATE_ICONS[state];
	return (
		<span
			className={clsx(styles.micBadge, state !== 'on' && styles.micBadgeOff)}
			data-flx="game-overlay.game-overlay-host.mic-badge"
		>
			<Icon weight="fill" aria-hidden className={styles.micIcon} data-flx="game-overlay.game-overlay-host.mic-icon" />
		</span>
	);
};

function getOverlayAvatarUrl(user: User, guildId: string | null): string {
	const member = guildId ? GuildMembers.getMember(guildId, user.id) : null;
	return guildId && member
		? AvatarUtils.getGuildMemberDisplayAvatarURL({
				guildId,
				user: {id: user.id, avatar: user.avatar},
				memberAvatar: member.avatar,
				avatarUnset: member.isAvatarUnset(),
				animated: false,
			})
		: AvatarUtils.getUserAvatarURL({id: user.id, avatar: user.avatar}, false);
}

function prepareOverlayDocument(childDocument: Document): HTMLElement {
	syncDocumentThemeAttributes(document, childDocument);
	copyStylesheetsIntoDocument(document, childDocument);
	childDocument.getElementById('fluxer-startup-native-titlebar')?.remove();
	const transparentStyle = childDocument.createElement('style');
	transparentStyle.textContent = TRANSPARENT_DOCUMENT_CSS;
	childDocument.head.appendChild(transparentStyle);
	const container = childDocument.createElement('div');
	childDocument.body.appendChild(container);
	return container;
}

interface GameOverlayWindowProps {
	guildId: string | null;
	channelId: string;
}

const GameOverlayWindow: React.FC<GameOverlayWindowProps> = observer(({guildId, channelId}) => {
	const [container, setContainer] = useState<HTMLElement | null>(null);
	const [openCount, setOpenCount] = useState(0);
	const entries = useVoiceParticipantAvatarEntries({guildId, channelId});
	const mode = GameOverlaySettings.mode;
	const corner = GameOverlaySettings.corner;
	const {shown, overflow} = useMemo(() => selectGameOverlayEntries(entries, mode), [entries, mode]);
	const {width, height} = computeGameOverlaySize(mode, shown.length, overflow);
	const visible = shown.length + (overflow > 0 ? 1 : 0) > 0;

	useEffect(() => {
		const childWindow = window.open('about:blank', GAME_OVERLAY_WINDOW_NAME);
		if (!childWindow) {
			logger.warn('Failed to open game overlay window');
			return;
		}
		const childDocument = childWindow.document;
		setContainer(prepareOverlayDocument(childDocument));
		const disconnectThemeObserver = observeDocumentThemeAttributes(document, childDocument);
		const disconnectStylesheetObserver = observeDocumentStylesheets(document, childDocument);
		// The main process can close the window under us (renderer crash); open it again. Our own close below runs
		// after the listener is removed, so it never reopens.
		const handlePageHide = (): void => {
			setContainer(null);
			setOpenCount((count) => count + 1);
		};
		childWindow.addEventListener('pagehide', handlePageHide);
		return () => {
			disconnectThemeObserver();
			disconnectStylesheetObserver();
			childWindow.removeEventListener('pagehide', handlePageHide);
			if (!childWindow.closed) {
				childWindow.close();
			}
		};
	}, [openCount]);

	// Sent again for every new window: the main process drops the layout when an overlay window closes.
	useEffect(() => {
		if (!container) return;
		getElectronAPI()?.setGameOverlayLayout?.({visible, corner, width, height});
	}, [container, visible, corner, width, height]);

	if (!container) return null;
	return createPortal(
		<div
			className={clsx(
				styles.root,
				mode === 'speaking' ? styles.speaking : styles.room,
				corner.startsWith('bottom') && styles.bottom,
			)}
			aria-hidden="true"
			data-flx="game-overlay.game-overlay-host.root"
		>
			{shown.map((entry) => (
				<div key={entry.userId} className={styles.row} data-flx="game-overlay.game-overlay-host.row">
					<div
						className={clsx(styles.avatar, entry.speaking && styles.avatarSpeaking)}
						data-flx="game-overlay.game-overlay-host.avatar"
					>
						<img
							src={getOverlayAvatarUrl(entry.user, guildId)}
							alt=""
							draggable={false}
							data-flx="game-overlay.game-overlay-host.avatar-image"
						/>
						<GameOverlayMicBadge
							state={getGameOverlayMicState(entry)}
							data-flx="game-overlay.game-overlay-host.game-overlay-mic-badge"
						/>
					</div>
					{mode === 'room' && (
						<span className={styles.name} data-flx="game-overlay.game-overlay-host.name">
							{NicknameUtils.getNickname(entry.user, guildId, channelId)}
						</span>
					)}
				</div>
			))}
			{overflow > 0 && (
				<div className={styles.row} data-flx="game-overlay.game-overlay-host.overflow-row">
					<div className={clsx(styles.avatar, styles.overflow)} data-flx="game-overlay.game-overlay-host.overflow">
						+{overflow}
					</div>
				</div>
			)}
		</div>,
		container,
	);
});

const GameOverlayVoiceGate: React.FC = observer(() => {
	useMediaEngineVersion();
	const channelId = MediaEngine.connected ? MediaEngine.channelId : null;
	if (!channelId) return null;
	return <GameOverlayWindow guildId={MediaEngine.guildId} channelId={channelId} />;
});

export const GameOverlayHost: React.FC = observer(() => {
	if (AccountScopedWork.isSuspended || !isGameOverlaySupported() || !GameOverlaySettings.enabled) {
		return null;
	}
	return <GameOverlayVoiceGate />;
});
