// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandCheerKind} from '@app/features/activities/band/BandProtocol';
import {BAND_CHEER_KINDS} from '@app/features/activities/band/flow/BandCrowd';
import {
	CHEER_DESCRIPTORS,
	CHEER_GROUP_DESCRIPTOR,
	CHEERING_DESCRIPTOR,
	HYPE_DESCRIPTOR,
	MIC_MUTE_NOTE_DESCRIPTOR,
	MIC_PUSH_TO_TALK_NOTE_DESCRIPTOR,
	PICKING_DESCRIPTOR,
	SPECTATOR_NOTE_DESCRIPTOR,
	SPECTATORS_DESCRIPTOR,
	WATCH_DESCRIPTOR,
	WATCHING_DESCRIPTOR,
	WILL_WATCH_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {VOICE_MIC_PORT} from '@app/features/activities/band/flow/BandMicPort';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import styles from '@app/features/activities/band/flow/components/SpectatorStrip.module.css';
import {useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import {useLingui} from '@lingui/react/macro';
import {EyeIcon, MicrophoneIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useId} from 'react';

export const CHEER_EMOJI: Readonly<Record<BandCheerKind, string>> = {
	clap: '👏',
	fire: '🔥',
	horns: '🤘',
	wow: '😮',
};

interface SpectatorStripProps {
	readonly room: BandRoom;
	readonly phase: 'select' | 'play';
}

const CrowdFeed = observer(function CrowdFeed({room}: {readonly room: BandRoom}) {
	const {feed} = room.crowd;
	return (
		<ol className={styles.feed} data-flx="activities.band.flow.spectator-strip.crowd-feed.feed">
			{feed.map((entry, index) => (
				<li
					key={entry.key}
					className={clsx(styles.chip, index < feed.length - 1 && styles.chipOld)}
					data-flx="activities.band.flow.spectator-strip.crowd-feed.chip"
				>
					<b data-flx="activities.band.flow.spectator-strip.crowd-feed.b">{bandDisplayName(entry.userId)}</b>{' '}
					<span aria-hidden="true" data-flx="activities.band.flow.spectator-strip.crowd-feed.span">
						{CHEER_EMOJI[entry.kind]}
					</span>
				</li>
			))}
		</ol>
	);
});

const HypeMeter = observer(function HypeMeter({room}: {readonly room: BandRoom}) {
	const {i18n} = useLingui();
	const now = useBandNow(room.session);
	const level = room.crowd.hypeLevel(now);
	return (
		<div className={styles.hype} data-flx="activities.band.flow.spectator-strip.hype-meter.hype">
			<div className={styles.hypeLabel} data-flx="activities.band.flow.spectator-strip.hype-meter.hype-label">
				<span data-flx="activities.band.flow.spectator-strip.hype-meter.span">{i18n._(HYPE_DESCRIPTOR)}</span>
				<span className={styles.hypeValue} data-flx="activities.band.flow.spectator-strip.hype-meter.hype-value">
					{i18n.number(level, {style: 'percent', maximumFractionDigits: 0})}
				</span>
			</div>
			<div
				className={styles.hypeTrack}
				role="meter"
				aria-label={i18n._(HYPE_DESCRIPTOR)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(level * 100)}
				data-flx="activities.band.flow.spectator-strip.hype-meter.hype-track"
			>
				<span
					className={styles.hypeFill}
					style={{width: `${level * 100}%`}}
					data-flx="activities.band.flow.spectator-strip.hype-meter.hype-fill"
				/>
			</div>
		</div>
	);
});

const CheerButtons = observer(function CheerButtons({room}: {readonly room: BandRoom}) {
	const {i18n} = useLingui();
	return (
		<div
			className={styles.cheers}
			role="group"
			aria-label={i18n._(CHEER_GROUP_DESCRIPTOR)}
			data-flx="activities.band.flow.spectator-strip.cheer-buttons.cheers"
		>
			{BAND_CHEER_KINDS.map((kind) => (
				<button
					key={kind}
					type="button"
					className={styles.cheer}
					onClick={() => room.cheer(kind)}
					aria-label={i18n._(CHEER_DESCRIPTORS[kind])}
					title={i18n._(CHEER_DESCRIPTORS[kind])}
					data-flx="activities.band.flow.spectator-strip.cheer-buttons.cheer.button"
				>
					<span aria-hidden="true" data-flx="activities.band.flow.spectator-strip.cheer-buttons.span">
						{CHEER_EMOJI[kind]}
					</span>
				</button>
			))}
		</div>
	);
});

export const SpectatorStrip = observer(function SpectatorStrip({room, phase}: SpectatorStripProps) {
	const {i18n} = useLingui();
	const now = useBandNow(room.session);
	const spectators = room.spectatorIds;
	const playing = phase === 'play';
	const amSpectator = spectators.includes(room.myUserId);
	const headingId = useId();
	const state = room.state;
	const watching = state?.phase === 'select' ? state.watching : null;
	const undecided = (userId: string) => watching !== null && !watching.includes(userId);
	return (
		<aside className={styles.strip} aria-labelledby={headingId} data-flx="activities.band.flow.spectator-strip.strip">
			<h3 id={headingId} className={styles.heading} data-flx="activities.band.flow.spectator-strip.heading">
				{i18n._(playing ? SPECTATORS_DESCRIPTOR : WILL_WATCH_DESCRIPTOR, {count: spectators.length})}
			</h3>
			<ul className={styles.people} data-flx="activities.band.flow.spectator-strip.people">
				{spectators.map((userId) => {
					const latest = room.crowd.latestByUser.get(userId);
					return (
						<li key={userId} className={styles.person} data-flx="activities.band.flow.spectator-strip.person">
							<BandAvatar userId={userId} size={30} data-flx="activities.band.flow.spectator-strip.band-avatar" />
							<div className={styles.personText} data-flx="activities.band.flow.spectator-strip.person-text">
								<span data-flx="activities.band.flow.spectator-strip.span">{bandDisplayName(userId)}</span>
								{playing && (
									<small data-flx="activities.band.flow.spectator-strip.small">
										{i18n._(room.crowd.isCheering(userId, now) ? CHEERING_DESCRIPTOR : WATCHING_DESCRIPTOR)}
									</small>
								)}
								{undecided(userId) && (
									<small className={styles.undecided} data-flx="activities.band.flow.spectator-strip.undecided">
										{i18n._(PICKING_DESCRIPTOR)}
									</small>
								)}
							</div>
							{playing && latest && (
								<span
									className={styles.lastCheer}
									aria-hidden="true"
									data-flx="activities.band.flow.spectator-strip.last-cheer"
								>
									{CHEER_EMOJI[latest.kind]}
								</span>
							)}
						</li>
					);
				})}
			</ul>
			{undecided(room.myUserId) && amSpectator && (
				<button
					type="button"
					className={styles.watch}
					onClick={() => room.send({t: 'band.claimSeat', part: null})}
					data-flx="activities.band.flow.spectator-strip.watch"
				>
					<EyeIcon size={16} weight="bold" data-flx="activities.band.flow.spectator-strip.watch-icon" />
					<span data-flx="activities.band.flow.spectator-strip.watch-label">{i18n._(WATCH_DESCRIPTOR)}</span>
				</button>
			)}
			{playing ? (
				<>
					<CrowdFeed room={room} data-flx="activities.band.flow.spectator-strip.crowd-feed" />
					{amSpectator && <CheerButtons room={room} data-flx="activities.band.flow.spectator-strip.cheer-buttons" />}
					<HypeMeter room={room} data-flx="activities.band.flow.spectator-strip.hype-meter" />
				</>
			) : (
				<div className={styles.note} data-flx="activities.band.flow.spectator-strip.note">
					<p data-flx="activities.band.flow.spectator-strip.p">{i18n._(SPECTATOR_NOTE_DESCRIPTOR)}</p>
					<div className={styles.mic} data-flx="activities.band.flow.spectator-strip.mic">
						<MicrophoneIcon className={styles.micIcon} data-flx="activities.band.flow.spectator-strip.mic-icon" />
						<span data-flx="activities.band.flow.spectator-strip.span--2">
							{i18n._(VOICE_MIC_PORT.hasPushToTalkKey() ? MIC_PUSH_TO_TALK_NOTE_DESCRIPTOR : MIC_MUTE_NOTE_DESCRIPTOR)}
						</span>
					</div>
				</div>
			)}
		</aside>
	);
});
