// SPDX-License-Identifier: AGPL-3.0-or-later

import {openActivityMenu} from '@app/features/activities/components/ActivityMenu';
import {
	ACTIVITY_OPTIONS_DESCRIPTOR,
	ACTIVITY_TILE_LABEL_DESCRIPTOR,
	EXPAND_ACTIVITY_DESCRIPTOR,
} from '@app/features/activities/components/ActivityMessages';
import {ActivitySummaryCard} from '@app/features/activities/components/ActivitySummaryCard';
import styles from '@app/features/activities/components/ActivityTile.module.css';
import {ActivityViewSlot} from '@app/features/activities/components/ActivityViewSlot';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {joinedActivitySession} from '@app/features/activities/utils/JoinedActivitySession';
import type {Channel} from '@app/features/channel/models/Channel';
import {isKeyboardActivationKey} from '@app/features/input/utils/KeyboardUtils';
import {LiveBadge} from '@app/features/ui/components/LiveBadge';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import voiceCallStyles from '@app/features/voice/components/VoiceCallView.module.css';
import {useLingui} from '@lingui/react/macro';
import {CornersOutIcon, DotsThreeIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

// The activity among the people in the call, like a stream tile. For someone taking part it holds the running game
// while a song plays (playable in place) and a summary with Expand between songs; for anyone else it is the cover
// with Join. `playable` is false where the game cannot run, the
// call's pop-out window.
export const ActivityTile = observer(function ActivityTile({
	channel,
	playable,
}: {
	readonly channel: Channel;
	readonly playable: boolean;
}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channel.id);
	if (!session) return null;
	const definition = getActivityDefinition(session.activity_id);
	const Icon = definition.icon;
	const name = i18n._(definition.name);
	const live = joinedActivitySession();
	const playing = playable && live?.sessionId === session.session_id;
	// Between songs a player's tile is the summary too; the View waits parked and comes in when the song starts.
	const showsView = playing && live !== null && (definition.showsInTile?.(live) ?? true);
	const expandLabel = i18n._(EXPAND_ACTIVITY_DESCRIPTOR);
	const optionsLabel = i18n._(ACTIVITY_OPTIONS_DESCRIPTOR);
	const handleExpand = (event: React.SyntheticEvent) => {
		event.stopPropagation();
		VoiceActivities.expand();
	};
	const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || !isKeyboardActivationKey(event.key)) return;
		event.preventDefault();
		VoiceActivities.expand();
	};
	return (
		<article
			className={clsx(voiceCallStyles.lkParticipantTile, styles.tile)}
			aria-label={i18n._(ACTIVITY_TILE_LABEL_DESCRIPTOR, {activity: name})}
			onContextMenu={(event) => openActivityMenu(event, channel.id)}
			data-flx="activities.activity-tile.tile"
		>
			{showsView ? (
				<>
					<ActivityViewSlot placement="tile" data-flx="activities.activity-tile.view-slot" />
					<div className={styles.hud} data-flx="activities.activity-tile.hud">
						<Icon weight="fill" className={styles.hudIcon} data-flx="activities.activity-tile.hud-icon" />
						<span className={styles.hudName} data-flx="activities.activity-tile.hud-name">
							{name}
						</span>
						<LiveBadge showTooltip={false} tone="voice_tile" data-flx="activities.activity-tile.live-badge" />
					</div>
				</>
			) : playable ? (
				<FocusRing offset={-2} data-flx="activities.activity-tile.card-focus-ring">
					<div
						role="button"
						tabIndex={0}
						className={styles.cardButton}
						aria-label={expandLabel}
						onClick={handleExpand}
						onKeyDown={handleCardKeyDown}
						data-flx="activities.activity-tile.card-button"
					>
						<ActivitySummaryCard
							channelId={channel.id}
							guildId={channel.guildId ?? null}
							size="tile"
							action={playing ? 'expand' : 'join'}
							data-flx="activities.activity-tile.summary-card"
						/>
					</div>
				</FocusRing>
			) : (
				<ActivitySummaryCard
					channelId={channel.id}
					guildId={channel.guildId ?? null}
					size="tile"
					action={null}
					data-flx="activities.activity-tile.summary-card--2"
				/>
			)}
			{playable && (
				<div className={styles.controls} data-flx="activities.activity-tile.controls">
					<Tooltip text={expandLabel} position="top" data-flx="activities.activity-tile.expand-tooltip">
						<FocusRing offset={-2} data-flx="activities.activity-tile.expand-focus-ring">
							<button
								type="button"
								className={styles.control}
								onClick={handleExpand}
								aria-label={expandLabel}
								data-flx="activities.activity-tile.expand"
							>
								<CornersOutIcon
									weight="bold"
									className={styles.controlIcon}
									data-flx="activities.activity-tile.expand-icon"
								/>
							</button>
						</FocusRing>
					</Tooltip>
					<Tooltip text={optionsLabel} position="top" data-flx="activities.activity-tile.options-tooltip">
						<FocusRing offset={-2} data-flx="activities.activity-tile.options-focus-ring">
							<button
								type="button"
								className={styles.control}
								onClick={(event) => openActivityMenu(event, channel.id)}
								aria-label={optionsLabel}
								aria-haspopup="menu"
								data-flx="activities.activity-tile.options"
							>
								<DotsThreeIcon
									weight="bold"
									className={styles.controlIcon}
									data-flx="activities.activity-tile.options-icon"
								/>
							</button>
						</FocusRing>
					</Tooltip>
				</div>
			)}
		</article>
	);
});
