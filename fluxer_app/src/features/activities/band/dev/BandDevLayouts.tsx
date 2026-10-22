// SPDX-License-Identifier: AGPL-3.0-or-later

// The call's surfaces around the band View in the harness, built from the real components (the joined tile follows
// ActivityTile's rule: the game during a song, the summary between songs): the View is mounted once
// into the dock and moves between these places exactly as in a call, so switching layouts mid-song shows that it
// keeps playing. The parts that need a live call (participant tiles, the channel list) are stand-ins.

import {BAND_ACTIVITY} from '@app/features/activities/band/BandActivity';
import type {BandDevHarness} from '@app/features/activities/band/dev/BandDevHarness';
import styles from '@app/features/activities/band/dev/BandDevLayouts.module.css';
import {ActivityPickerPanel} from '@app/features/activities/components/ActivityPicker';
import {ActivityPiPContent} from '@app/features/activities/components/ActivityPiPContent';
import {ActivitySummaryCard} from '@app/features/activities/components/ActivitySummaryCard';
import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import {ActivityViewFrame} from '@app/features/activities/components/ActivityViewRoot';
import {ActivityViewSlot} from '@app/features/activities/components/ActivityViewSlot';
import voiceCallStyles from '@app/features/voice/components/VoiceCallView.module.css';
import {observer} from 'mobx-react-lite';
import {createPortal} from 'react-dom';

const STAND_INS = ['Eşber', 'Cihangir', 'Selim', 'Ayşe'];

const ViewPortal = observer(function ViewPortal({harness}: {harness: BandDevHarness}) {
	return createPortal(
		<ActivityViewFrame
			key={harness.session.sessionId}
			session={harness.session}
			data-flx="activities.band.dev.band-dev-layouts.view-portal.frame"
		/>,
		ActivityViewDock.host,
	);
});

function StandInTile({name}: {name: string}) {
	return (
		<div className={styles.standIn} data-flx="activities.band.dev.band-dev-layouts.stand-in">
			<span className={styles.standInAvatar} data-flx="activities.band.dev.band-dev-layouts.stand-in-avatar">
				{name.slice(0, 1)}
			</span>
			<span data-flx="activities.band.dev.band-dev-layouts.stand-in-name">{name}</span>
		</div>
	);
}

const GridLayout = observer(function GridLayout({harness}: {harness: BandDevHarness}) {
	return (
		<div className={styles.grid} data-flx="activities.band.dev.band-dev-layouts.grid">
			<div className={styles.cell} data-flx="activities.band.dev.band-dev-layouts.cell">
				<span className={styles.caption} data-flx="activities.band.dev.band-dev-layouts.caption">
					katılan
				</span>
				<article
					className={`${voiceCallStyles.lkParticipantTile} ${styles.tile}`}
					data-flx="activities.band.dev.band-dev-layouts.joined-tile"
				>
					{(BAND_ACTIVITY.showsInTile?.(harness.session) ?? true) ? (
						<ActivityViewSlot placement="tile" data-flx="activities.band.dev.band-dev-layouts.tile-slot" />
					) : (
						<ActivitySummaryCard
							channelId={harness.session.channelId}
							guildId={null}
							size="tile"
							action="expand"
							data-flx="activities.band.dev.band-dev-layouts.member-summary-card"
						/>
					)}
				</article>
			</div>
			<div className={styles.cell} data-flx="activities.band.dev.band-dev-layouts.cell--2">
				<span className={styles.caption} data-flx="activities.band.dev.band-dev-layouts.caption--2">
					katılmayan
				</span>
				<article
					className={`${voiceCallStyles.lkParticipantTile} ${styles.tile}`}
					data-flx="activities.band.dev.band-dev-layouts.card-tile"
				>
					<ActivitySummaryCard
						channelId={harness.session.channelId}
						guildId={null}
						size="tile"
						action="join"
						data-flx="activities.band.dev.band-dev-layouts.summary-card"
					/>
				</article>
			</div>
			{STAND_INS.map((name) => (
				<div key={name} className={styles.cell} data-flx="activities.band.dev.band-dev-layouts.cell--3">
					<StandInTile name={name} data-flx="activities.band.dev.band-dev-layouts.stand-in-tile" />
				</div>
			))}
		</div>
	);
});

const MiniLayout = observer(function MiniLayout({harness}: {harness: BandDevHarness}) {
	return (
		<div className={styles.chat} data-flx="activities.band.dev.band-dev-layouts.chat">
			<p data-flx="activities.band.dev.band-dev-layouts.chat-line">
				<b data-flx="activities.band.dev.band-dev-layouts.chat-name">Cihangir</b>
				<span data-flx="activities.band.dev.band-dev-layouts.chat-text"> ben bu şarkıyı izleyeceğim</span>
			</p>
			<p data-flx="activities.band.dev.band-dev-layouts.chat-line--2">
				<b data-flx="activities.band.dev.band-dev-layouts.chat-name--2">Selim</b>
				<span data-flx="activities.band.dev.band-dev-layouts.chat-text--2"> sıradakine Du Hast yazın</span>
			</p>
			<input
				className={styles.composer}
				placeholder="#genel-sohbet kanalına mesaj gönder"
				data-flx="activities.band.dev.band-dev-layouts.composer"
			/>
			<ActivityPiPContent
				content={{
					type: 'activity',
					channelId: harness.session.channelId,
					guildId: null,
					sessionId: harness.session.sessionId,
				}}
				data-flx="activities.band.dev.band-dev-layouts.pi-p"
			/>
		</div>
	);
});

const PickerLayout = observer(function PickerLayout() {
	return (
		<div className={styles.backdrop} data-flx="activities.band.dev.band-dev-layouts.backdrop">
			<div className={styles.modal} data-flx="activities.band.dev.band-dev-layouts.modal">
				<ActivityPickerPanel
					channelId="band-dev-picker"
					channelName="Oyun Odası"
					peopleCount={4}
					onClose={() => {}}
					data-flx="activities.band.dev.band-dev-layouts.picker-panel"
				/>
			</div>
		</div>
	);
});

export const BandDevLayouts = observer(function BandDevLayouts({harness}: {harness: BandDevHarness}) {
	return (
		<>
			<ViewPortal harness={harness} data-flx="activities.band.dev.band-dev-layouts.view-portal" />
			{harness.layout === 'stage' && (
				<ActivityViewSlot placement="stage" data-flx="activities.band.dev.band-dev-layouts.stage-slot" />
			)}
			{harness.layout === 'grid' && (
				<GridLayout harness={harness} data-flx="activities.band.dev.band-dev-layouts.grid-layout" />
			)}
			{harness.layout === 'mini' && (
				<MiniLayout harness={harness} data-flx="activities.band.dev.band-dev-layouts.mini-layout" />
			)}
			{harness.layout === 'picker' && <PickerLayout data-flx="activities.band.dev.band-dev-layouts.picker-layout" />}
		</>
	);
});
