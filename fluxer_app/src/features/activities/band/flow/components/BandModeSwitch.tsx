// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import styles from '@app/features/activities/band/flow/components/BandModeSwitch.module.css';
import {bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {
	MODE_END_JAM_DESCRIPTOR,
	MODE_JAM_DESCRIPTOR,
	MODE_LABEL_DESCRIPTOR,
	MODE_LEADER_ONLY_DESCRIPTOR,
	MODE_SONGS_DESCRIPTOR,
} from '@app/features/activities/band/jam/JamLabels';
import {useLingui} from '@lingui/react/macro';
import {GuitarIcon, MusicNotesIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

export type BandMode = 'songs' | 'jam';

// Songs or jam, at the head of the song picker and of the jam screen. The leader moves the whole room between them;
// everyone else sees which side the room is on and who can change it.
export const BandModeSwitch = observer(function BandModeSwitch({
	room,
	mode,
}: {
	readonly room: BandRoom;
	readonly mode: BandMode;
}) {
	const {i18n} = useLingui();
	const leader = room.session.leader;
	const isLeader = room.session.isLeader;
	const hint = isLeader
		? mode === 'jam'
			? i18n._(MODE_END_JAM_DESCRIPTOR)
			: undefined
		: leader
			? i18n._(MODE_LEADER_ONLY_DESCRIPTOR, {name: bandDisplayName(leader.userId)})
			: undefined;
	const choose = (next: BandMode) => {
		if (next === mode || !isLeader) return;
		room.send({t: next === 'jam' ? 'band.jamStart' : 'band.jamEnd'});
	};
	return (
		<div
			className={styles.switch}
			role="radiogroup"
			aria-label={i18n._(MODE_LABEL_DESCRIPTOR)}
			title={hint}
			data-flx="activities.band.flow.band-mode-switch.switch"
		>
			{(['songs', 'jam'] as const).map((option) => {
				const Icon = option === 'songs' ? MusicNotesIcon : GuitarIcon;
				const on = option === mode;
				return (
					<button
						key={option}
						type="button"
						role="radio"
						aria-checked={on}
						disabled={!isLeader && !on}
						className={clsx(styles.option, on && styles.on)}
						onClick={() => choose(option)}
						data-flx="activities.band.flow.band-mode-switch.option.choose.button"
					>
						<Icon
							size={16}
							weight={on ? 'fill' : 'bold'}
							aria-hidden="true"
							data-flx="activities.band.flow.band-mode-switch.icon"
						/>
						{i18n._(option === 'songs' ? MODE_SONGS_DESCRIPTOR : MODE_JAM_DESCRIPTOR)}
					</button>
				);
			})}
		</div>
	);
});
