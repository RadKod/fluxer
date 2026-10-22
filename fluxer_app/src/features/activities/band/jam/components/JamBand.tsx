// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import styles from '@app/features/activities/band/jam/components/JamBand.module.css';
import {JAM_LANE_CLASSES} from '@app/features/activities/band/jam/components/JamPads';
import {
	ALONE_DESCRIPTOR,
	JAM_INSTRUMENT_DESCRIPTORS,
	LISTENING_DESCRIPTOR,
} from '@app/features/activities/band/jam/JamLabels';
import type {JamRuntime} from '@app/features/activities/band/jam/JamRuntime';
import {JAM_LANE_COUNT} from '@app/features/activities/band/jam/JamScales';
import {useLingui} from '@lingui/react/macro';
import {HeadphonesIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const NO_LANES: ReadonlyArray<boolean> = Array.from({length: JAM_LANE_COUNT}, () => false);

// Everyone else in the jam as a small card: their instrument and five lights that follow what they play, in time with
// the sound. People without an instrument sit at the end as listeners.
export const JamBand = observer(function JamBand({
	room,
	state,
	runtime,
}: {
	readonly room: BandRoom;
	readonly state: BandJamState;
	readonly runtime: JamRuntime | null;
}) {
	const {i18n} = useLingui();
	const others = [...new Set(room.session.members.map((member) => member.userId))].filter(
		(userId) => userId !== room.myUserId,
	);
	const instrumentOf = new Map(state.seats.map((seat) => [seat.userId, seat.instrument]));
	const players = others.filter((userId) => instrumentOf.has(userId));
	const listeners = others.filter((userId) => !instrumentOf.has(userId));
	if (others.length === 0) {
		return (
			<div className={styles.band} data-flx="activities.band.jam.jam-band.band">
				<p className={styles.alone} data-flx="activities.band.jam.jam-band.alone">
					{i18n._(ALONE_DESCRIPTOR)}
				</p>
			</div>
		);
	}
	return (
		<ul className={styles.band} data-flx="activities.band.jam.jam-band.band--2">
			{players.map((userId) => {
				const instrument = instrumentOf.get(userId);
				if (!instrument) return null;
				const lit = runtime?.remoteLanes.get(userId) ?? NO_LANES;
				const playing = lit.some(Boolean);
				return (
					<li
						key={userId}
						className={clsx(styles.card, playing && styles.playing)}
						data-flx="activities.band.jam.jam-band.card"
					>
						<BandAvatar userId={userId} size={32} data-flx="activities.band.jam.jam-band.band-avatar" />
						<div className={styles.who} data-flx="activities.band.jam.jam-band.who">
							<span className={styles.name} data-flx="activities.band.jam.jam-band.name">
								{bandDisplayName(userId)}
							</span>
							<span className={styles.instrument} data-flx="activities.band.jam.jam-band.instrument">
								<BandPartIcon
									part={instrument}
									className={styles.instrumentIcon}
									data-flx="activities.band.jam.jam-band.instrument-icon"
								/>
								{i18n._(JAM_INSTRUMENT_DESCRIPTORS[instrument])}
							</span>
						</div>
						<span className={styles.lights} aria-hidden="true" data-flx="activities.band.jam.jam-band.lights">
							{lit.map((on, lane) => (
								<span
									key={lane}
									className={clsx(styles.light, JAM_LANE_CLASSES[lane], on && styles.lightOn)}
									data-flx="activities.band.jam.jam-band.light"
								/>
							))}
						</span>
					</li>
				);
			})}
			{listeners.map((userId) => (
				<li key={userId} className={clsx(styles.card, styles.listener)} data-flx="activities.band.jam.jam-band.card--2">
					<BandAvatar userId={userId} size={24} data-flx="activities.band.jam.jam-band.band-avatar--2" />
					<div className={styles.who} data-flx="activities.band.jam.jam-band.who--2">
						<span className={styles.name} data-flx="activities.band.jam.jam-band.name--2">
							{bandDisplayName(userId)}
						</span>
						<span className={styles.instrument} data-flx="activities.band.jam.jam-band.instrument--2">
							<HeadphonesIcon
								size={12}
								weight="bold"
								aria-hidden="true"
								data-flx="activities.band.jam.jam-band.headphones-icon"
							/>
							{i18n._(LISTENING_DESCRIPTOR)}
						</span>
					</div>
				</li>
			))}
		</ul>
	);
});
