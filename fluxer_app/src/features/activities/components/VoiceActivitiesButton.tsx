// SPDX-License-Identifier: AGPL-3.0-or-later

import {showVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {
	ACTIVITIES_DESCRIPTOR,
	COLLAPSE_ACTIVITY_DESCRIPTOR,
} from '@app/features/activities/components/ActivityMessages';
import {openActivityPicker} from '@app/features/activities/components/ActivityPicker';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {RocketLaunchIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const EXPAND_NAMED_ACTIVITY_DESCRIPTOR = msg({
	message: 'Expand {activity}',
	comment:
		'Voice activities: tooltip on the activities button while an activity runs; it makes the activity fill the call area. {activity} is its name.',
});

// The call's control bar: with no activity it opens the picker, while one runs it expands it on the call's stage
// and shrinks it back.
export function toggleVoiceActivitiesInCall(channelId: string): void {
	if (!VoiceActivities.getSession(channelId)) openActivityPicker(channelId);
	else if (VoiceActivities.isExpanded(channelId)) VoiceActivities.collapse();
	else VoiceActivities.expand();
}

// The channel list: the picker, or back to the channel with the running activity expanded.
export function openVoiceActivitiesFromChannelList(guildId: string | null, channelId: string): void {
	if (VoiceActivities.getSession(channelId)) showVoiceActivity(guildId, channelId);
	else openActivityPicker(channelId);
}

// What the button does next: the call's button collapses an expanded activity, the channel list's always shows it.
export function voiceActivitiesLabel(i18n: I18n, channelId: string, place: 'call' | 'channel-list' = 'call'): string {
	const session = VoiceActivities.getSession(channelId);
	if (!session) return i18n._(ACTIVITIES_DESCRIPTOR);
	if (place === 'call' && VoiceActivities.isExpanded(channelId)) return i18n._(COLLAPSE_ACTIVITY_DESCRIPTOR);
	return i18n._(EXPAND_NAMED_ACTIVITY_DESCRIPTOR, {activity: i18n._(getActivityDefinition(session.activity_id).name)});
}

// In the voice control bar.
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
	const label = voiceActivitiesLabel(i18n, channelId);
	return (
		<Tooltip text={label} data-flx="activities.voice-activities-button.tooltip">
			<FocusRing offset={-2} data-flx="activities.voice-activities-button.focus-ring">
				<button
					type="button"
					className={clsx(buttonClassName, session ? activeClassName : idleClassName)}
					onClick={() => toggleVoiceActivitiesInCall(channelId)}
					aria-label={label}
					aria-pressed={session ? VoiceActivities.isExpanded(channelId) : undefined}
					aria-haspopup={session ? undefined : 'dialog'}
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
