// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/components/ActivityPresenceBadge.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {useLingui} from '@lingui/react/macro';
import {RocketLaunchIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

// On a participant's tile in the call while that connection takes part in the running activity.
export const ActivityPresenceBadge = observer(function ActivityPresenceBadge({
	channelId,
	participantIdentity,
}: {
	readonly channelId: string | undefined;
	readonly participantIdentity: string;
}) {
	const {i18n} = useLingui();
	const live = channelId ? VoiceActivities.getLive(channelId) : null;
	if (!live?.members.some((member) => member.identity === participantIdentity)) return null;
	return (
		<span className={styles.badge} data-flx="activities.activity-presence-badge.badge">
			<RocketLaunchIcon weight="fill" className={styles.icon} data-flx="activities.activity-presence-badge.icon" />
			<span className={styles.label} data-flx="activities.activity-presence-badge.label">
				{i18n._(getActivityDefinition(live.activityId).presence)}
			</span>
		</span>
	);
});
