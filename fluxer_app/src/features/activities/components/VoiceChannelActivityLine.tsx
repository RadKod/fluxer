// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/components/VoiceChannelActivityLine.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {useLingui} from '@lingui/react/macro';
import {RocketLaunchIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

// Under a voice channel in the channel list while an activity runs there. Only the channel I am connected to knows
// its session, so other channels never show the line.
export const VoiceChannelActivityLine = observer(function VoiceChannelActivityLine({channelId}: {channelId: string}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channelId);
	if (!session) return null;
	return (
		<div className={styles.line} data-flx="activities.voice-channel-activity-line.line">
			<RocketLaunchIcon weight="fill" className={styles.icon} data-flx="activities.voice-channel-activity-line.icon" />
			<span className={styles.name} data-flx="activities.voice-channel-activity-line.name">
				{i18n._(getActivityDefinition(session.activity_id).name)}
			</span>
		</div>
	);
});
