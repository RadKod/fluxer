// SPDX-License-Identifier: AGPL-3.0-or-later

import {startVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import styles from '@app/features/activities/components/VoiceActivitiesButton.module.css';
import type {ActivityDefinition} from '@app/features/activities/registry/ActivityDefinition';
import {ACTIVITY_LIST, getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {openPopout} from '@app/features/ui/popover/PopoverPopout';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import PopoutState from '@app/features/ui/state/Popout';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {RocketLaunchIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const ACTIVITIES_DESCRIPTOR = msg({
	message: 'Activities',
	context: 'voice-activities',
	comment: 'Voice control bar: button that opens the list of activities (games played together in the voice channel).',
});
const SHOW_ACTIVITY_DESCRIPTOR = msg({
	message: 'Show {activity}',
	comment:
		'Voice control bar: tooltip on the activities button while an activity runs and its panel is hidden. {activity} is its name.',
});
const HIDE_ACTIVITY_DESCRIPTOR = msg({
	message: 'Hide {activity}',
	comment:
		'Voice control bar: tooltip on the activities button while the running activity is shown; hiding keeps the activity and the call going. {activity} is its name.',
});
const ONE_AT_A_TIME_DESCRIPTOR = msg({
	message: 'An activity is already running. End it before starting another.',
	comment: 'Voice activities: tooltip on a disabled entry of the activity list. A channel runs one activity at a time.',
});
const NEEDS_PEOPLE_DESCRIPTOR = msg({
	message: 'Needs at least {count} people in the channel',
	comment: 'Voice activities: tooltip on a disabled entry of the activity list. {count} is a number above 1.',
});

const PICKER_POPOUT_KEY = 'voice-activities-picker';

function peopleInChannel(guildId: string | null, channelId: string): number {
	return Object.keys(MediaEngine.getAllVoiceStatesInChannel(guildId ?? '', channelId)).length;
}

const ActivityPicker = observer(function ActivityPicker({
	channelId,
	onClose,
}: {
	channelId: string;
	onClose: () => void;
}) {
	const {i18n} = useLingui();
	const running = VoiceActivities.getSession(channelId) !== null;
	const people = peopleInChannel(MediaEngine.guildId, channelId);
	const blockReason = (definition: ActivityDefinition): string | null => {
		if (running) return i18n._(ONE_AT_A_TIME_DESCRIPTOR);
		if (people < definition.minPlayers) return i18n._(NEEDS_PEOPLE_DESCRIPTOR, {count: definition.minPlayers});
		return null;
	};
	return (
		<div
			className={styles.picker}
			role="menu"
			aria-label={i18n._(ACTIVITIES_DESCRIPTOR)}
			data-flx="activities.voice-activities-button.activity-picker.picker"
		>
			{ACTIVITY_LIST.map((definition) => {
				const reason = blockReason(definition);
				const disabled = reason !== null || VoiceActivities.request !== null;
				const Icon = definition.icon;
				const item = (
					<button
						type="button"
						role="menuitem"
						className={styles.item}
						disabled={disabled}
						aria-disabled={disabled}
						onClick={() => {
							onClose();
							void startVoiceActivity(channelId, definition.id);
						}}
						data-flx="activities.voice-activities-button.activity-picker.item.close.button"
					>
						<Icon
							weight="fill"
							className={styles.itemIcon}
							data-flx="activities.voice-activities-button.activity-picker.item-icon"
						/>
						<span className={styles.itemName} data-flx="activities.voice-activities-button.activity-picker.item-name">
							{i18n._(definition.name)}
						</span>
					</button>
				);
				return reason ? (
					<Tooltip
						key={definition.id}
						text={reason}
						data-flx="activities.voice-activities-button.activity-picker.tooltip"
					>
						<span
							className={styles.disabledWrap}
							data-flx="activities.voice-activities-button.activity-picker.disabled-wrap"
						>
							{item}
						</span>
					</Tooltip>
				) : (
					<FocusRing
						key={definition.id}
						offset={-2}
						data-flx="activities.voice-activities-button.activity-picker.focus-ring"
					>
						{item}
					</FocusRing>
				);
			})}
		</div>
	);
});

function togglePicker(target: HTMLElement, channelId: string): void {
	if (PopoutState.isOpen(PICKER_POPOUT_KEY) && !PopoutState.isClosing(PICKER_POPOUT_KEY)) {
		PopoutCommands.close(PICKER_POPOUT_KEY);
		return;
	}
	openPopout(
		target,
		{
			position: 'top',
			offsetMainAxis: 8,
			returnFocusRef: {current: target},
			render: ({onClose}) => (
				<ActivityPicker
					channelId={channelId}
					onClose={onClose}
					data-flx="activities.voice-activities-button.toggle-picker.activity-picker"
				/>
			),
		},
		PICKER_POPOUT_KEY,
	);
}

// In the voice control bar. With no activity it opens the list; while one runs it shows or hides its panel.
export const VoiceActivitiesButton = observer(function VoiceActivitiesButton({
	buttonClassName,
	idleClassName,
	activeClassName,
	iconClassName,
}: {
	buttonClassName: string;
	idleClassName: string;
	activeClassName: string;
	iconClassName: string;
}) {
	const {i18n} = useLingui();
	const channelId = MediaEngine.channelId;
	if (!channelId || MobileLayout.isMobileLayout() || !voiceActivitiesEnabled(MediaEngine.guildId)) return null;
	const session = VoiceActivities.getSession(channelId);
	const open = session !== null && VoiceActivities.panelOpen;
	const activity = session ? i18n._(getActivityDefinition(session.activity_id).name) : null;
	const label =
		activity === null
			? i18n._(ACTIVITIES_DESCRIPTOR)
			: i18n._(open ? HIDE_ACTIVITY_DESCRIPTOR : SHOW_ACTIVITY_DESCRIPTOR, {activity});
	const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (session) VoiceActivities.togglePanel();
		else togglePicker(event.currentTarget, channelId);
	};
	return (
		<Tooltip text={label} data-flx="activities.voice-activities-button.tooltip">
			<FocusRing offset={-2} data-flx="activities.voice-activities-button.focus-ring">
				<button
					type="button"
					className={clsx(buttonClassName, session ? activeClassName : idleClassName)}
					onClick={handleClick}
					aria-label={label}
					aria-pressed={session ? open : undefined}
					aria-haspopup={session ? undefined : 'menu'}
					data-flx="activities.voice-activities-button.button.click"
				>
					<RocketLaunchIcon
						weight="fill"
						className={iconClassName}
						data-flx="activities.voice-activities-button.rocket-launch-icon"
					/>
				</button>
			</FocusRing>
		</Tooltip>
	);
});
