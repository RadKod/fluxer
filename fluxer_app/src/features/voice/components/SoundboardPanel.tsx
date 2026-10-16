// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import Guilds from '@app/features/guild/state/Guilds';
import Permission from '@app/features/permissions/state/Permission';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import {failureRetryAfter} from '@app/features/platform/utils/ResponseInspection';
import {stripCombiningMarks} from '@app/features/search/utils/SearchTextMatching';
import {Button} from '@app/features/ui/button/Button';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import {Slider} from '@app/features/ui/components/Slider';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {openPopout} from '@app/features/ui/popover/PopoverPopout';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import ModalState from '@app/features/ui/state/Modal';
import PopoutState from '@app/features/ui/state/Popout';
import Users from '@app/features/user/state/Users';
import * as SoundboardCommands from '@app/features/voice/commands/SoundboardCommands';
import {SoundboardManagePanel} from '@app/features/voice/components/SoundboardManagePanel';
import styles from '@app/features/voice/components/SoundboardPanel.module.css';
import MediaEngine, {useMediaEngineVersion} from '@app/features/voice/engine/MediaEngineFacade';
import {initSoundboardRuntime} from '@app/features/voice/events/SoundboardPlay';
import {getSoundboardAnchor, SOUNDBOARD_POPOUT_KEY as POPOUT_KEY} from '@app/features/voice/state/SoundboardAnchor';
import SoundboardLibrary from '@app/features/voice/state/SoundboardLibrary';
import SoundboardSettings from '@app/features/voice/state/SoundboardSettings';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {
	CaretDownIcon,
	CaretRightIcon,
	MagnifyingGlassIcon,
	PencilSimpleIcon,
	SpeakerHighIcon,
	StarIcon,
	XIcon,
} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';

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
const RATE_LIMITED = msg({
	message: 'Slow down. Try again in {seconds} s.',
	comment: 'Soundboard play error when the user played too many sounds in a short time; counts down to zero.',
});
const FORBIDDEN = msg({
	message: 'To play sounds, join this voice channel and undeafen yourself.',
	comment: 'Soundboard play error when the server refuses because the user is not in the channel or is deafened.',
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
const SEARCH = msg({message: 'Search sounds', comment: 'Placeholder and label of the soundboard search box.'});
const CLEAR_SEARCH = msg({
	message: 'Clear sound search',
	comment: 'Button inside the soundboard search box that empties it.',
});
const NO_MATCHES = msg({
	message: 'No sounds match your search.',
	comment: 'Soundboard search result when no sound name matches.',
});
const SETTINGS = msg({
	message: 'Soundboard listening settings',
	comment: 'Button next to the soundboard search that shows the listening volume and mute switch.',
});
const RECENT = msg({
	message: 'Recently played',
	comment: 'Soundboard section listing the last sounds the user played in this community.',
});
const FAVORITES = msg({
	message: 'Favorite sounds',
	comment: 'Soundboard section listing the sounds the user starred.',
});
const GUILD_SOUNDS = msg({
	message: '{guild} sounds',
	comment: 'Soundboard section header listing every sound of the community; {guild} is the community name.',
});
const COMMUNITY_SOUNDS = msg({
	message: 'Community sounds',
	comment: 'Soundboard section header used when the community name is not known.',
});
const FAVORITE_ADD = msg({
	message: 'Add {name} to favorites',
	comment: 'Accessible label of the star button on a soundboard sound.',
});
const FAVORITE_REMOVE = msg({
	message: 'Remove {name} from favorites',
	comment: 'Accessible label of the filled star button on a favorite soundboard sound.',
});
const PAGE_SIZE = 48;
const MODAL_KEY = 'soundboard';
const MANAGE_MODAL_KEY = 'soundboard-manage';
// Upper bound on how long the panel waits on a server-provided retry_after before letting the user try again.
const MAX_RATE_LIMIT_MS = 60_000;

type SectionKey = 'recent' | 'favorites' | 'guild';
type PlayFailure = {kind: 'rate'; until: number} | {kind: 'forbidden'} | {kind: 'failed'};

// Case and diacritic insensitive, with Turkish dotless i folded so "isik" finds "Işık".
export function soundSearchKey(text: string): string {
	return stripCombiningMarks(text).toLowerCase().replace(/ı/g, 'i');
}

function classifyPlayFailure(error: unknown): PlayFailure {
	if (error instanceof HttpError) {
		if (error.status === 429) {
			const header = Number(error.responseHeaders['retry-after']);
			const seconds = failureRetryAfter(error) ?? (Number.isFinite(header) ? header : 1);
			const ms = Math.min(MAX_RATE_LIMIT_MS, Math.max(500, seconds * 1000));
			return {kind: 'rate', until: Date.now() + ms};
		}
		if (error.status === 403) return {kind: 'forbidden'};
	}
	return {kind: 'failed'};
}

const SoundTile = observer(
	({
		sound,
		canPlay,
		canEdit,
		onPlay,
		onEdit,
	}: {
		sound: GuildSoundboardSoundResponse;
		canPlay: boolean;
		canEdit: boolean;
		onPlay: (sound: GuildSoundboardSoundResponse) => void;
		onEdit: (sound: GuildSoundboardSoundResponse) => void;
	}) => {
		const {i18n} = useLingui();
		const favorite = SoundboardSettings.isFavorite(sound.id);
		return (
			<div className={clsx(styles.tile, canEdit && styles.editable)} data-flx="voice.soundboard-panel.tile">
				<FocusRing offset={-2}>
					<button
						type="button"
						className={styles.play}
						disabled={!canPlay}
						aria-label={i18n._(PLAY, {name: sound.name})}
						onClick={() => onPlay(sound)}
						data-flx="voice.soundboard-panel.play-sound"
					>
						<span className={styles.glyph} aria-hidden>
							<SpeakerHighIcon size={16} weight="fill" />
						</span>
						<span className={styles.name}>{sound.name}</span>
					</button>
				</FocusRing>
				<div className={styles.tileActions}>
					<FocusRing offset={-2}>
						<button
							type="button"
							className={clsx(styles.tileAction, favorite && styles.favorite)}
							aria-pressed={favorite}
							aria-label={i18n._(favorite ? FAVORITE_REMOVE : FAVORITE_ADD, {name: sound.name})}
							onClick={() => SoundboardSettings.toggleFavorite(sound.id)}
							data-flx="voice.soundboard-panel.favorite"
						>
							<StarIcon aria-hidden size={14} weight={favorite ? 'fill' : 'bold'} />
						</button>
					</FocusRing>
					{canEdit && (
						<FocusRing offset={-2}>
							<button
								type="button"
								className={styles.tileAction}
								aria-label={i18n._(EDIT, {name: sound.name})}
								onClick={() => onEdit(sound)}
								data-flx="voice.soundboard-panel.edit"
							>
								<PencilSimpleIcon aria-hidden size={14} weight="bold" />
							</button>
						</FocusRing>
					)}
				</div>
			</div>
		);
	},
);

function SoundSection({
	title,
	count,
	collapsed,
	onToggle,
	children,
}: {
	title: string;
	count: number;
	collapsed: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	const Caret = collapsed ? CaretRightIcon : CaretDownIcon;
	return (
		<section className={styles.section} data-flx="voice.soundboard-panel.section">
			<FocusRing offset={-2}>
				<button
					type="button"
					className={styles.sectionHead}
					aria-expanded={!collapsed}
					onClick={onToggle}
					data-flx="voice.soundboard-panel.section-toggle"
				>
					<Caret className={styles.sectionCaret} weight="bold" aria-hidden />
					<span className={styles.sectionTitle}>{title}</span>
					<span className={styles.sectionCount}>{count}</span>
				</button>
			</FocusRing>
			{!collapsed && (
				<div className={styles.grid} role="group" aria-label={title}>
					{children}
				</div>
			)}
		</section>
	);
}

interface SoundboardContentProps {
	guildId: string;
	channelId: string;
	onManage: (sound: GuildSoundboardSoundResponse | null, uploadAllowed: boolean) => void;
	inPopout?: boolean;
}

const SoundboardContent = observer(({guildId, channelId, onManage, inPopout = false}: SoundboardContentProps) => {
	const {i18n} = useLingui();
	useMediaEngineVersion();
	const [page, setPage] = useState(0);
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set());
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [playError, setPlayError] = useState<PlayFailure | null>(null);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		void SoundboardLibrary.load(guildId);
	}, [guildId]);
	useEffect(() => {
		if (playError?.kind !== 'rate') return;
		const failure = playError;
		const clear = window.setTimeout(
			() => setPlayError((current) => (current === failure ? null : current)),
			Math.max(0, failure.until - Date.now()),
		);
		const tick = window.setInterval(() => setNow(Date.now()), 250);
		return () => {
			window.clearTimeout(clear);
			window.clearInterval(tick);
		};
	}, [playError]);
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
	const needle = soundSearchKey(query.trim());
	// Not memoized: the library mutates its observable array in place on gateway updates.
	const matches = needle.length === 0 ? sounds : sounds.filter((sound) => soundSearchKey(sound.name).includes(needle));
	const byId = new Map(sounds.map((sound) => [sound.id, sound]));
	const pick = (ids: ReadonlyArray<string>) =>
		ids.flatMap((id) => {
			const sound = byId.get(id);
			return sound ? [sound] : [];
		});
	const recentSounds = pick(SoundboardSettings.recentFor(guildId));
	const favoriteSounds = pick(SoundboardSettings.favorites);
	const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
	const currentPage = Math.min(page, pages - 1);
	const rateLimited = playError?.kind === 'rate' && playError.until > now;
	const guildName = Guilds.getGuild(guildId)?.name;
	const play = async (sound: GuildSoundboardSoundResponse) => {
		if (!canPlay || playing) return;
		if (playError?.kind === 'rate' && playError.until > Date.now()) return;
		setPlaying(true);
		try {
			const sent = await SoundboardCommands.playSound(channelId, sound.id);
			if (sent !== false) {
				setPlayError(null);
				SoundboardSettings.recordPlay(guildId, sound.id);
			}
		} catch (error) {
			const failure = classifyPlayFailure(error);
			setNow(Date.now());
			setPlayError(failure);
		} finally {
			setPlaying(false);
		}
	};
	const toggleSection = (key: SectionKey) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const tiles = (list: ReadonlyArray<GuildSoundboardSoundResponse>) =>
		list.map((sound) => (
			<SoundTile
				key={sound.id}
				sound={sound}
				canPlay={canPlay}
				canEdit={canManage || (canCreate && sound.creator_id === Users.currentUserId)}
				onPlay={(target) => {
					void play(target);
				}}
				onEdit={(sound) => onManage(sound, uploadAllowed)}
			/>
		));
	const pageOf = (list: ReadonlyArray<GuildSoundboardSoundResponse>) =>
		list.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
	const errorText =
		playError === null
			? null
			: playError.kind === 'rate'
				? rateLimited
					? i18n._(RATE_LIMITED, {seconds: Math.max(1, Math.ceil((playError.until - now) / 1000))})
					: null
				: playError.kind === 'forbidden'
					? i18n._(FORBIDDEN)
					: i18n._(PLAY_ERROR);
	return (
		<div className={clsx(styles.content, inPopout && styles.contentPopout)}>
			<div className={styles.searchRow} role="search">
				<div className={styles.search}>
					<Input
						type="text"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setPage(0);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape' && query) {
								event.stopPropagation();
								setQuery('');
								setPage(0);
							}
						}}
						placeholder={i18n._(SEARCH)}
						aria-label={i18n._(SEARCH)}
						leftIcon={<MagnifyingGlassIcon aria-hidden size={16} weight="bold" />}
						rightElement={
							query ? (
								<FocusRing offset={-2}>
									<button
										type="button"
										className={styles.clear}
										aria-label={i18n._(CLEAR_SEARCH)}
										onClick={() => {
											setQuery('');
											setPage(0);
										}}
										data-flx="voice.soundboard-panel.clear-search"
									>
										<XIcon aria-hidden size={14} weight="bold" />
									</button>
								</FocusRing>
							) : undefined
						}
						data-autofocus={inPopout ? true : undefined}
						data-flx="voice.soundboard-panel.search"
					/>
				</div>
				<Button
					small
					square
					variant={settingsOpen ? 'secondary' : 'ghost'}
					aria-label={i18n._(SETTINGS)}
					aria-expanded={settingsOpen}
					icon={<SpeakerHighIcon aria-hidden size={18} />}
					onClick={() => setSettingsOpen((open) => !open)}
				/>
			</div>
			{settingsOpen && (
				<div className={styles.settings}>
					<Checkbox checked={SoundboardSettings.disabled} onChange={(value) => SoundboardSettings.setDisabled(value)}>
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
				</div>
			)}
			{errorText !== null && (
				<p role="alert" className={styles.error}>
					{errorText}
				</p>
			)}
			<div className={styles.scroll}>
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
				) : needle.length > 0 ? (
					matches.length === 0 ? (
						<p className={styles.hint} role="status">
							{i18n._(NO_MATCHES)}
						</p>
					) : (
						<div className={styles.grid} role="group" aria-label={i18n._(SEARCH)}>
							{tiles(pageOf(matches))}
						</div>
					)
				) : (
					<div className={styles.sections}>
						{recentSounds.length > 0 && (
							<SoundSection
								title={i18n._(RECENT)}
								count={recentSounds.length}
								collapsed={collapsed.has('recent')}
								onToggle={() => toggleSection('recent')}
							>
								{tiles(recentSounds)}
							</SoundSection>
						)}
						{favoriteSounds.length > 0 && (
							<SoundSection
								title={i18n._(FAVORITES)}
								count={favoriteSounds.length}
								collapsed={collapsed.has('favorites')}
								onToggle={() => toggleSection('favorites')}
							>
								{tiles(favoriteSounds)}
							</SoundSection>
						)}
						<SoundSection
							title={guildName ? i18n._(GUILD_SOUNDS, {guild: guildName}) : i18n._(COMMUNITY_SOUNDS)}
							count={sounds.length}
							collapsed={collapsed.has('guild')}
							onToggle={() => toggleSection('guild')}
						>
							{tiles(pageOf(sounds))}
						</SoundSection>
					</div>
				)}
				{pages > 1 && !(needle.length === 0 && collapsed.has('guild')) && (
					<div className={styles.pagination}>
						<Button small variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
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
			</div>
			<div className={styles.toolbar}>
				<p className={styles.hint}>{i18n._(CAPACITY, {count: sounds.length, capacity})}</p>
				<Button small disabled={!uploadAllowed} onClick={() => onManage(null, uploadAllowed)}>
					{i18n._(ADD)}
				</Button>
			</div>
			{sounds.length >= capacity && <p className={styles.hint}>{i18n._(UPGRADE)}</p>}
		</div>
	);
});

export const SoundboardPanel = observer(({guildId, channelId}: {guildId: string; channelId: string}) => {
	const {i18n} = useLingui();
	const [editing, setEditing] = useState<
		{sound: GuildSoundboardSoundResponse | undefined; uploadAllowed: boolean} | undefined
	>(undefined);
	return (
		<Modal.Root size="medium" transitionPreset="instant">
			<Modal.Header title={i18n._(TITLE)} />
			<Modal.Content>
				<div className={styles.panel}>
					{editing !== undefined ? (
						<SoundboardManagePanel
							guildId={guildId}
							sound={editing.sound}
							uploadAllowed={editing.uploadAllowed}
							onClose={() => setEditing(undefined)}
						/>
					) : (
						<SoundboardContent
							guildId={guildId}
							channelId={channelId}
							onManage={(sound, uploadAllowed) => setEditing({sound: sound ?? undefined, uploadAllowed})}
						/>
					)}
				</div>
			</Modal.Content>
		</Modal.Root>
	);
});

const SoundboardManageModal = observer(
	({
		guildId,
		sound,
		uploadAllowed,
	}: {
		guildId: string;
		sound: GuildSoundboardSoundResponse | undefined;
		uploadAllowed: boolean;
	}) => {
		const {i18n} = useLingui();
		return (
			<Modal.Root size="small" transitionPreset="instant">
				<Modal.Header title={i18n._(TITLE)} />
				<Modal.Content>
					<SoundboardManagePanel
						guildId={guildId}
						sound={sound}
						uploadAllowed={uploadAllowed}
						onClose={() => ModalCommands.popWithKey(MANAGE_MODAL_KEY)}
					/>
				</Modal.Content>
			</Modal.Root>
		);
	},
);

// sanalyer: on desktop the soundboard opens as a popout above the voice panel's soundboard button, like the
// expression picker; the manage form still opens as a modal. The popout closes itself when the voice session moves.
export const SoundboardPopout = observer(
	({guildId, channelId, onClose}: {guildId: string; channelId: string; onClose: () => void}) => {
		const {i18n} = useLingui();
		useMediaEngineVersion();
		const stale = !MediaEngine.connected || MediaEngine.guildId !== guildId || MediaEngine.channelId !== channelId;
		useEffect(() => {
			if (stale) onClose();
		}, [stale, onClose]);
		return (
			<div className={styles.popout} role="dialog" aria-label={i18n._(TITLE)} data-flx="voice.soundboard-panel.popout">
				<h2 className={styles.popoutTitle}>{i18n._(TITLE)}</h2>
				<SoundboardContent
					guildId={guildId}
					channelId={channelId}
					inPopout
					onManage={(sound, uploadAllowed) => {
						onClose();
						ModalCommands.pushWithKey(
							ModalCommands.modal(() => (
								<SoundboardManageModal guildId={guildId} sound={sound ?? undefined} uploadAllowed={uploadAllowed} />
							)),
							MANAGE_MODAL_KEY,
						);
					}}
				/>
			</div>
		);
	},
);

function closeSoundboardSurfaces(): void {
	ModalCommands.popWithKey(MODAL_KEY);
	if (PopoutState.isOpen(POPOUT_KEY)) PopoutCommands.close(POPOUT_KEY);
}

export function toggleSoundboard(guildId: string, channelId: string): void {
	const anchor = MobileLayout.enabled ? null : getSoundboardAnchor();
	if (anchor) {
		if (ModalState.hasModal(MODAL_KEY)) ModalCommands.popWithKey(MODAL_KEY);
		if (PopoutState.isOpen(POPOUT_KEY) && !PopoutState.isClosing(POPOUT_KEY)) {
			PopoutCommands.close(POPOUT_KEY);
			return;
		}
		openPopout(
			anchor,
			{
				position: 'top-start',
				offsetMainAxis: 8,
				returnFocusRef: {current: anchor},
				render: ({onClose}) => <SoundboardPopout guildId={guildId} channelId={channelId} onClose={onClose} />,
			},
			POPOUT_KEY,
		);
		return;
	}
	if (PopoutState.isOpen(POPOUT_KEY)) PopoutCommands.close(POPOUT_KEY);
	if (ModalState.hasModal(MODAL_KEY)) {
		ModalCommands.popWithKey(MODAL_KEY);
		return;
	}
	ModalCommands.pushWithKey(
		ModalCommands.modal(() => <SoundboardPanel guildId={guildId} channelId={channelId} />),
		MODAL_KEY,
	);
}

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
			toggleSoundboard(guildId, channelId);
		});
		return () => {
			unsubscribe();
			closeSoundboardSurfaces();
		};
	}, [guildId, channelId, connected, accountKey, connectionId, sessionId]);
	return null;
});
