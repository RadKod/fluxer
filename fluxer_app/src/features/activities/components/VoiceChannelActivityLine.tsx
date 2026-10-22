// SPDX-License-Identifier: AGPL-3.0-or-later

import {activityMemberUserIds} from '@app/features/activities/components/ActivityPeople';
import styles from '@app/features/activities/components/VoiceChannelActivityLine.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {AvatarStack} from '@app/features/ui/avatars/AvatarStack';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {useLingui} from '@lingui/react/macro';
import {RocketLaunchIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

// Under a voice channel in the channel list while an activity runs there: its name and the faces of the people taking
// part. Only the channel I am connected to knows its session, so other channels never show the line.
export const VoiceChannelActivityLine = observer(function VoiceChannelActivityLine({channelId}: {channelId: string}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channelId);
	if (!session) return null;
	const players = activityMemberUserIds(VoiceActivities.getLive(channelId))
		.map((userId) => Users.getUser(userId))
		.filter((user): user is User => user !== undefined);
	return (
		<div className={styles.line} data-flx="activities.voice-channel-activity-line.line">
			<RocketLaunchIcon weight="fill" className={styles.icon} data-flx="activities.voice-channel-activity-line.icon" />
			<span className={styles.name} data-flx="activities.voice-channel-activity-line.name">
				{i18n._(getActivityDefinition(session.activity_id).name)}
			</span>
			{players.length > 0 && (
				<AvatarStack
					users={players}
					size={16}
					maxVisible={5}
					guildId={MediaEngine.guildId}
					channelId={channelId}
					enableProfileModal={false}
					className={styles.players}
					data-flx="activities.voice-channel-activity-line.players"
				/>
			)}
		</div>
	);
});
