// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedUserPostsModal} from '@app/features/feed/components/FeedUserPostsModal';
import {isFeedEnabled} from '@app/features/feed/utils/FeedUtils';
import styles from '@app/features/follow/components/ProfileFollowActions.module.css';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {NewspaperIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const POSTS_DESCRIPTOR = msg({
	message: 'Posts',
	comment: 'Tooltip and accessible label of the profile button that opens the feed posts of the user. Keep it concise.',
});

export const ProfilePostsButton = observer(({userId}: {userId: string}) => {
	const {i18n} = useLingui();
	const user = Users.getUser(userId);
	if (!isFeedEnabled() || !user || user.bot || user.system) return null;
	const label = i18n._(POSTS_DESCRIPTOR);
	const openPosts = () => {
		ModalCommands.push(
			modal(() => (
				<FeedUserPostsModal userId={userId} data-flx="feed.profile-posts-button.open-posts.feed-user-posts-modal" />
			)),
		);
	};
	return (
		<div className={styles.container} data-flx="feed.profile-posts-button.container">
			<FocusRing offset={-2} data-flx="feed.profile-posts-button.focus-ring">
				<Tooltip text={label} data-flx="feed.profile-posts-button.tooltip">
					<button
						type="button"
						className={styles.iconButton}
						onClick={openPosts}
						aria-label={label}
						data-flx="feed.profile-posts-button.icon-button.open-posts"
					>
						<NewspaperIcon weight="bold" className={styles.icon} data-flx="feed.profile-posts-button.icon" />
					</button>
				</Tooltip>
			</FocusRing>
		</div>
	);
});
