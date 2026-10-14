// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import * as FollowCommands from '@app/features/follow/commands/FollowCommands';
import {FollowListModal} from '@app/features/follow/components/FollowListModal';
import styles from '@app/features/follow/components/ProfileFollowActions.module.css';
import {getFollowControls, getFollowProfile} from '@app/features/follow/utils/FollowProfileUtils';
import {TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import Users from '@app/features/user/state/Users';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, PlusIcon, UserCheckIcon, UserPlusIcon, UsersIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

export const FOLLOW_DESCRIPTOR = msg({
	message: 'Follow',
	comment:
		'Button label that starts following the user: the icon in the user profile card, the button in the profile header and the pill at the top right of a Discover post. Keep it concise.',
});
export const UNFOLLOW_DESCRIPTOR = msg({
	message: 'Unfollow',
	comment:
		'Button label that stops following the user: the icon in the user profile card, and the text that replaces Following on hover (profile header button, Discover post pill). Keep it concise.',
});
export const FOLLOWING_DESCRIPTOR = msg({
	message: 'Following',
	context: 'follow-button',
	comment:
		'Label of the follow button once you follow the account (profile header, Discover posts); hovering shows Unfollow. Not the Following list tab.',
});
const FOLLOW_COUNTS_DESCRIPTOR = msg({
	message:
		'{followerCount, plural, one {# follower} other {# followers}} · {followingCount, plural, one {# following} other {# following}}',
	comment:
		'Tooltip and accessible label of the button in the user profile card that opens the follower and following lists. {followerCount} is how many accounts follow the user; {followingCount} is how many accounts the user follows.',
});
const YOU_CAN_T_FOLLOW_THIS_ACCOUNT_DESCRIPTOR = msg({
	message: "You can't follow this account.",
	comment:
		'Error toast when following fails because one account blocks the other or they share no community or friendship. Keep tone plain and not blaming.',
});
const EMAIL_VERIFICATION_REQUIRED_DESCRIPTOR = msg({message: 'Email verification required'});
const FOLLOW_LIMIT_DESCRIPTOR = msg({
	message: '{maxFollowing, plural, one {You can follow up to # account.} other {You can follow up to # accounts.}}',
	comment:
		'Error toast when following fails because the user already follows the maximum number of accounts. {maxFollowing} is that maximum.',
});

export function toastFollowFailure(i18n: I18n, outcome: FollowCommands.FollowOutcome, wasFollowing: boolean): void {
	if (outcome === 'ok' || outcome === 'account_limited') return;
	if (outcome === 'verify_email') {
		ToastCommands.error(i18n._(EMAIL_VERIFICATION_REQUIRED_DESCRIPTOR));
	} else if (!wasFollowing && outcome === 'forbidden') {
		ToastCommands.error(i18n._(YOU_CAN_T_FOLLOW_THIS_ACCOUNT_DESCRIPTOR));
	} else if (!wasFollowing && outcome === 'limit') {
		ToastCommands.error(i18n._(FOLLOW_LIMIT_DESCRIPTOR, {maxFollowing: Users.currentUser?.maxFollowing ?? 0}));
	} else {
		ToastCommands.error(i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR));
	}
}

// Micup akis-takip: the text Follow button beside Message in the profile header, as tall as it; the
// same visibility rule as the card icon (getFollowControls). Plus and check icons, since the friend request button
// beside it already shows the user-plus.
export const ProfileFollowButton = observer(({userId}: {userId: string}) => {
	const {i18n} = useLingui();
	const [isBusy, setIsBusy] = useState(false);
	const profile = getFollowProfile(userId);
	const user = Users.getUser(userId);
	if (!profile || !user || !getFollowControls(profile, user, Authentication.currentUserId).canFollow) return null;
	const isFollowing = profile.isFollowing === true;
	const handleClick = async () => {
		setIsBusy(true);
		const outcome = isFollowing ? await FollowCommands.unfollow(userId) : await FollowCommands.follow(userId);
		setIsBusy(false);
		toastFollowFailure(i18n, outcome, isFollowing);
	};
	// Always inside the Tooltip (empty while not following), so the button keeps its focus when the state flips.
	return (
		<Tooltip text={isFollowing ? i18n._(UNFOLLOW_DESCRIPTOR) : ''} data-flx="follow.profile-follow-button.tooltip">
			<Button
				small={true}
				variant={isFollowing ? 'secondary' : 'primary'}
				className={isFollowing ? styles.followingButton : undefined}
				leftIcon={
					isFollowing ? (
						<CheckIcon weight="bold" data-flx="follow.profile-follow-button.check-icon" />
					) : (
						<PlusIcon weight="bold" data-flx="follow.profile-follow-button.plus-icon" />
					)
				}
				submitting={isBusy}
				onClick={handleClick}
				data-flx="follow.profile-follow-button.button.click"
			>
				{isFollowing ? (
					<>
						<span className={styles.followIdleLabel} data-flx="follow.profile-follow-button.idle-label">
							{i18n._(FOLLOWING_DESCRIPTOR)}
						</span>
						<span className={styles.followHoverLabel} aria-hidden data-flx="follow.profile-follow-button.hover-label">
							{i18n._(UNFOLLOW_DESCRIPTOR)}
						</span>
					</>
				) : (
					i18n._(FOLLOW_DESCRIPTOR)
				)}
			</Button>
		</Tooltip>
	);
});

interface ProfileFollowActionsProps {
	userId: string;
	// The profile modal shows ProfileFollowButton in its header instead of the icon.
	hideFollowButton?: boolean;
}

export const ProfileFollowActions = observer(({userId, hideFollowButton = false}: ProfileFollowActionsProps) => {
	const {i18n} = useLingui();
	const [isBusy, setIsBusy] = useState(false);
	const profile = getFollowProfile(userId);
	const user = Users.getUser(userId);
	if (!profile || !user) return null;
	const controls = getFollowControls(profile, user, Authentication.currentUserId);
	const canFollow = controls.canFollow && !hideFollowButton;
	const {showCounts} = controls;
	if (!canFollow && !showCounts) return null;
	const isFollowing = profile.isFollowing === true;
	const followLabel = i18n._(isFollowing ? UNFOLLOW_DESCRIPTOR : FOLLOW_DESCRIPTOR);
	const countsLabel = i18n._(FOLLOW_COUNTS_DESCRIPTOR, {
		followerCount: profile.followerCount ?? 0,
		followingCount: profile.followingCount ?? 0,
	});
	const handleFollowClick = async () => {
		setIsBusy(true);
		const outcome = isFollowing ? await FollowCommands.unfollow(userId) : await FollowCommands.follow(userId);
		setIsBusy(false);
		toastFollowFailure(i18n, outcome, isFollowing);
	};
	const openLists = () => {
		ModalCommands.push(
			modal(() => (
				<FollowListModal
					userId={userId}
					initialKind="followers"
					data-flx="follow.profile-follow-actions.open-lists.follow-list-modal"
				/>
			)),
		);
	};
	return (
		<div className={styles.container} data-flx="follow.profile-follow-actions.container">
			{canFollow && (
				<FocusRing offset={-2} data-flx="follow.profile-follow-actions.focus-ring">
					<Tooltip text={followLabel} data-flx="follow.profile-follow-actions.tooltip">
						<button
							type="button"
							className={styles.iconButton}
							onClick={handleFollowClick}
							disabled={isBusy}
							aria-label={followLabel}
							data-flx="follow.profile-follow-actions.icon-button.follow-click"
						>
							{isFollowing ? (
								<UserCheckIcon weight="bold" className={styles.icon} data-flx="follow.profile-follow-actions.icon" />
							) : (
								<UserPlusIcon weight="bold" className={styles.icon} data-flx="follow.profile-follow-actions.icon--2" />
							)}
						</button>
					</Tooltip>
				</FocusRing>
			)}
			{showCounts && (
				<FocusRing offset={-2} data-flx="follow.profile-follow-actions.focus-ring--2">
					<Tooltip text={countsLabel} data-flx="follow.profile-follow-actions.tooltip--2">
						<button
							type="button"
							className={styles.countsButton}
							onClick={openLists}
							aria-label={countsLabel}
							data-flx="follow.profile-follow-actions.counts-button.open-lists"
						>
							<UsersIcon weight="bold" className={styles.icon} data-flx="follow.profile-follow-actions.icon--3" />
							{i18n.number(profile.followerCount ?? 0, {notation: 'compact'})}
						</button>
					</Tooltip>
				</FocusRing>
			)}
		</div>
	);
});
