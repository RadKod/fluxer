// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/band/flow/components/BandPeople.module.css';
import {Avatar} from '@app/features/ui/components/Avatar';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

// Observable reads only, so an observer that calls it re-renders when the member list or a nickname changes.
export function bandDisplayName(userId: string): string {
	const user = Users.getUser(userId);
	if (!user) return userId;
	return NicknameUtils.getNickname(user, MediaEngine.guildId, MediaEngine.channelId ?? undefined);
}

interface BandAvatarProps {
	readonly userId: string;
	readonly size: number;
	readonly className?: string;
}

// The user's avatar, or their initial while the user is not loaded yet.
export const BandAvatar = observer(function BandAvatar({userId, size, className}: BandAvatarProps) {
	const user = Users.getUser(userId);
	if (user) {
		return (
			<Avatar
				user={user}
				size={size}
				guildId={MediaEngine.guildId}
				className={clsx(styles.avatar, className)}
				data-flx="activities.band.flow.band-people.band-avatar.avatar"
			/>
		);
	}
	return (
		<span
			className={clsx(styles.avatar, styles.initial, className)}
			style={{width: size, height: size, fontSize: size * 0.42}}
			aria-hidden="true"
			data-flx="activities.band.flow.band-people.band-avatar.avatar--2"
		>
			{bandDisplayName(userId).slice(0, 1).toUpperCase()}
		</span>
	);
});
