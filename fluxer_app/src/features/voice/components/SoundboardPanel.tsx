// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import Permission from '@app/features/permissions/state/Permission';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import {Button} from '@app/features/ui/button/Button';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Slider} from '@app/features/ui/components/Slider';
import ModalState from '@app/features/ui/state/Modal';
import Users from '@app/features/user/state/Users';
import * as SoundboardCommands from '@app/features/voice/commands/SoundboardCommands';
import {SoundboardManagePanel} from '@app/features/voice/components/SoundboardManagePanel';
import styles from '@app/features/voice/components/SoundboardPanel.module.css';
import MediaEngine, {useMediaEngineVersion} from '@app/features/voice/engine/MediaEngineFacade';
import {initSoundboardRuntime} from '@app/features/voice/events/SoundboardPlay';
import SoundboardLibrary from '@app/features/voice/state/SoundboardLibrary';
import SoundboardSettings from '@app/features/voice/state/SoundboardSettings';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {PencilSimpleIcon, SpeakerHighIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const TITLE = msg({message: 'Soundboard', comment: 'Title of the community soundboard and voice control label.'});
const ADD = msg({message: 'Add sound', comment: 'Soundboard action to upload a community sound.'});
const CAPACITY = msg({
	message: '{count} / {capacity} sounds',
	comment: 'Soundboard slot usage; existing sounds remain usable above capacity.',
});
const UPGRADE = msg({
	message: 'Sound slots are full. Boost to a higher level for more slots.',
	comment: 'Soundboard upload lock directing the user to a higher community boost level.',
});
const DISABLE = msg({
	message: 'Disable soundboard sounds',
	comment: 'Account-local switch to stop hearing incoming soundboard sounds.',
});
const VOLUME = msg({
	message: 'Soundboard volume',
	comment: 'Accessible label for the soundboard listening volume slider.',
});
const LOADING = msg({message: 'Loading sounds…', comment: 'Soundboard metadata loading status.'});
const LOAD_ERROR = msg({message: 'Could not load sounds. Try again.', comment: 'Soundboard metadata loading error.'});
const PLAY_ERROR = msg({
	message: 'Could not play this sound. Try again.',
	comment: 'Error after a soundboard play request fails.',
});
const RETRY = msg({message: 'Retry', comment: 'Action to retry loading soundboard metadata.'});
const EMPTY = msg({
	message: 'No sounds yet. Add an MP3 or Ogg clip to use it in this voice channel.',
	comment: 'Empty community soundboard guidance.',
});
const PLAY = msg({message: 'Play {name}', comment: 'Accessible label of a soundboard sound playback button.'});
const EDIT = msg({message: 'Edit {name}', comment: 'Accessible label of a soundboard sound management button.'});
const PREVIOUS = msg({message: 'Previous sounds', comment: 'Action to show the previous soundboard page.'});
const NEXT = msg({message: 'Next sounds', comment: 'Action to show the next soundboard page.'});
const PAGE = msg({message: 'Page {page} of {pages}', comment: 'Current soundboard page status.'});
const PAGE_SIZE = 48;
const MODAL_KEY = 'soundboard';

export const SoundboardPanel = observer(({guildId, channelId}: {guildId: string; channelId: string}) => {
	const {i18n} = useLingui();
	useMediaEngineVersion();
	const [page, setPage] = useState(0);
	const [editing, setEditing] = useState<GuildSoundboardSoundResponse | null | undefined>(undefined);
	const [playing, setPlaying] = useState(false);
	const [playError, setPlayError] = useState(false);
	useEffect(() => {
		void SoundboardLibrary.load(guildId);
	}, [guildId]);
	const sounds = SoundboardLibrary.guildId === guildId ? SoundboardLibrary.sounds : [];
	const capacity = LimitResolver.resolve({
		key: 'max_guild_soundboard_sounds',
		fallback: 8,
		context: {guildId},
		evaluationContext: 'guild',
	});
	const canCreate = Permission.can(Permissions.CREATE_EXPRESSIONS, {guildId});
	const canManage = Permission.can(Permissions.MANAGE_EXPRESSIONS, {guildId});
	const uploadAllowed =
		canCreate &&
		SoundboardLibrary.guildId === guildId &&
		sounds.length < capacity &&
		!SoundboardLibrary.loading &&
		!SoundboardLibrary.error;
	const canPlay =
		MediaEngine.connected &&
		MediaEngine.guildId === guildId &&
		MediaEngine.channelId === channelId &&
		Permission.can(Permissions.SPEAK, {channelId});
	const pages = Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));
	const currentPage = Math.min(page, pages - 1);
	const play = async (id: string) => {
		if (!canPlay || playing) return;
		setPlaying(true);
		setPlayError(false);
		try {
			await SoundboardCommands.playSound(channelId, id);
		} catch {
			setPlayError(true);
		} finally {
			setPlaying(false);
		}
	};
	return (
		<Modal.Root size="small" transitionPreset="instant">
			<Modal.Header title={i18n._(TITLE)} />
			<Modal.Content>
				<div className={styles.panel}>
					{editing !== undefined ? (
						<SoundboardManagePanel
							guildId={guildId}
							sound={editing ?? undefined}
							uploadAllowed={uploadAllowed}
							onClose={() => setEditing(undefined)}
						/>
					) : (
						<>
							<div className={styles.toolbar}>
								<p className={styles.hint}>{i18n._(CAPACITY, {count: sounds.length, capacity})}</p>
								<Button small disabled={!uploadAllowed} onClick={() => setEditing(null)}>
									{i18n._(ADD)}
								</Button>
							</div>
							{sounds.length >= capacity && <p className={styles.hint}>{i18n._(UPGRADE)}</p>}
							<Checkbox
								checked={SoundboardSettings.disabled}
								onChange={(value) => SoundboardSettings.setDisabled(value)}
							>
								{i18n._(DISABLE)}
							</Checkbox>
							<div className={styles.volume}>
								<span className={styles.hint}>{i18n._(VOLUME)}</span>
								<Slider
									value={SoundboardSettings.volume}
									defaultValue={SoundboardSettings.volume}
									factoryDefaultValue={1}
									minValue={0}
									maxValue={1}
									step={0.01}
									ariaLabel={i18n._(VOLUME)}
									asValueChanges={(value) => SoundboardSettings.setVolume(value)}
									onValueChange={(value) => SoundboardSettings.commitVolume(value)}
									showResetButton={false}
								/>
							</div>
							{SoundboardLibrary.loading ? (
								<p role="status" className={styles.hint}>
									{i18n._(LOADING)}
								</p>
							) : SoundboardLibrary.error ? (
								<div role="alert" className={styles.status}>
									<p>{i18n._(LOAD_ERROR)}</p>
									<Button
										small
										variant="secondary"
										onClick={() => {
											void SoundboardLibrary.load(guildId, true);
										}}
									>
										{i18n._(RETRY)}
									</Button>
								</div>
							) : sounds.length === 0 ? (
								<p className={styles.hint}>{i18n._(EMPTY)}</p>
							) : (
								<div className={styles.grid}>
									{sounds.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((sound) => (
										<div key={sound.id} className={styles.sound}>
											<Button
												variant="secondary"
												disabled={!canPlay || playing}
												className={styles.play}
												aria-label={i18n._(PLAY, {name: sound.name})}
												onClick={() => {
													void play(sound.id);
												}}
												data-flx="voice.soundboard-panel.play-sound"
											>
												<SpeakerHighIcon aria-hidden size={20} />
												<span className={styles.name}>{sound.name}</span>
											</Button>
											{(canManage || (canCreate && sound.creator_id === Users.currentUserId)) && (
												<Button
													small
													square
													variant="ghost"
													aria-label={i18n._(EDIT, {name: sound.name})}
													icon={<PencilSimpleIcon aria-hidden size={18} />}
													onClick={() => setEditing(sound)}
												/>
											)}
										</div>
									))}
								</div>
							)}
							{playError && (
								<p role="alert" className={styles.error}>
									{i18n._(PLAY_ERROR)}
								</p>
							)}
							{pages > 1 && (
								<div className={styles.pagination}>
									<Button
										small
										variant="secondary"
										disabled={currentPage === 0}
										onClick={() => setPage(currentPage - 1)}
									>
										{i18n._(PREVIOUS)}
									</Button>
									<span className={styles.hint} aria-live="polite">
										{i18n._(PAGE, {page: currentPage + 1, pages})}
									</span>
									<Button
										small
										variant="secondary"
										disabled={currentPage + 1 === pages}
										onClick={() => setPage(currentPage + 1)}
									>
										{i18n._(NEXT)}
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			</Modal.Content>
		</Modal.Root>
	);
});

export const SoundboardRoot = observer(() => {
	useMediaEngineVersion();
	useEffect(() => initSoundboardRuntime(), []);
	const guildId = MediaEngine.guildId;
	const channelId = MediaEngine.channelId;
	const connected = MediaEngine.connected;
	const accountKey = Users.viewAccountKey;
	const connectionId = MediaEngine.connectionId;
	const sessionId = GatewaySessions.foregroundConnection.sessionId;
	useEffect(() => {
		const unsubscribe = ComponentBus.subscribe('SOUNDBOARD_TOGGLE', () => {
			if (!guildId || !channelId || !connected) return;
			if (ModalState.hasModal(MODAL_KEY)) {
				ModalCommands.popWithKey(MODAL_KEY);
				return;
			}
			ModalCommands.pushWithKey(
				ModalCommands.modal(() => <SoundboardPanel guildId={guildId} channelId={channelId} />),
				MODAL_KEY,
			);
		});
		return () => {
			unsubscribe();
			ModalCommands.popWithKey(MODAL_KEY);
		};
	}, [guildId, channelId, connected, accountKey, connectionId, sessionId]);
	return null;
});
