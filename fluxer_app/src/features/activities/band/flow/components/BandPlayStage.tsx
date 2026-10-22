// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import styles from '@app/features/activities/band/flow/components/BandPlayStage.module.css';
import {SpectatorStrip} from '@app/features/activities/band/flow/components/SpectatorStrip';
import {PlayScreen} from '@app/features/activities/band/game/PlayScreen';
import {observer} from 'mobx-react-lite';

interface BandPlayStageProps {
	readonly room: BandRoom;
	readonly state: Extract<BandState, {phase: 'play'}>;
	readonly song: BandSongSummary;
	readonly songPackage: SongPackage;
}

// The game on the left, the crowd on the right, for players and spectators alike; small places show the game only.
export const BandPlayStage = observer(function BandPlayStage({room, state, song, songPackage}: BandPlayStageProps) {
	return (
		<div className={styles.stage} data-flx="activities.band.flow.band-play-stage.stage">
			<div className={styles.game} data-flx="activities.band.flow.band-play-stage.game">
				<PlayScreen
					session={room.session}
					state={state}
					entry={song}
					songPackage={songPackage}
					onOwnIntent={(intent) => room.send(intent)}
					data-flx="activities.band.flow.band-play-stage.play-screen"
				/>
			</div>
			<div className={styles.crowd} data-flx="activities.band.flow.band-play-stage.crowd">
				<SpectatorStrip room={room} phase="play" data-flx="activities.band.flow.band-play-stage.spectator-strip" />
			</div>
		</div>
	);
});
