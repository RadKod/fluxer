// SPDX-License-Identifier: AGPL-3.0-or-later

import {PEOPLE_JOINED_DESCRIPTOR} from '@app/features/activities/components/ActivityMessages';
import styles from '@app/features/activities/components/ActivityPeople.module.css';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {AvatarStack} from '@app/features/ui/avatars/AvatarStack';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

// Observable reads only: one user id per person taking part, in the session's order (a second device adds nobody).
export function activityMemberUserIds(session: ActivitySession | null): ReadonlyArray<string> {
	return session ? [...new Set(session.members.map((member) => member.userId))] : [];
}

// The faces of the people taking part and how many they are.
export const ActivityPeople = observer(function ActivityPeople({
	session,
	guildId,
	channelId,
	avatarSize = 24,
	className,
}: {
	readonly session: ActivitySession | null;
	readonly guildId: string | null;
	readonly channelId: string;
	readonly avatarSize?: number;
	readonly className?: string;
}) {
	const {i18n} = useLingui();
	const userIds = activityMemberUserIds(session);
	const users = userIds.map((userId) => Users.getUser(userId)).filter((user): user is User => user !== undefined);
	return (
		<div className={clsx(styles.people, className)} data-flx="activities.activity-people.people">
			{users.length > 0 && (
				<AvatarStack
					users={users}
					size={avatarSize}
					maxVisible={4}
					guildId={guildId}
					channelId={channelId}
					enableProfileModal={false}
					data-flx="activities.activity-people.avatar-stack"
				/>
			)}
			<span className={styles.count} data-flx="activities.activity-people.count">
				{i18n._(PEOPLE_JOINED_DESCRIPTOR, {count: userIds.length})}
			</span>
		</div>
	);
});
