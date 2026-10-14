// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import Authentication from '@app/features/auth/state/Authentication';
import * as FollowCommands from '@app/features/follow/commands/FollowCommands';
import styles from '@app/features/follow/components/FollowListModal.module.css';
import {
	FOLLOW_DESCRIPTOR,
	FOLLOWING_DESCRIPTOR as FOLLOWING_BUTTON_DESCRIPTOR,
	toastFollowFailure,
	UNFOLLOW_DESCRIPTOR,
} from '@app/features/follow/components/ProfileFollowActions';
import followStyles from '@app/features/follow/components/ProfileFollowActions.module.css';
import FollowLists, {type FollowListEntry, type FollowListKind} from '@app/features/follow/state/FollowLists';
import {
	TRY_AGAIN_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tabs} from '@app/features/ui/tabs/Tabs';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {getAppRemScale} from '@app/features/ui/utils/AppZoomUtils';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, PlusIcon, XIcon} from '@phosphor-icons/react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';

const FOLLOWERS_DESCRIPTOR = msg({
	message: 'Followers',
	comment: 'Tab label in the follow lists modal for the accounts that follow the user. Keep it concise.',
});
const FOLLOWING_DESCRIPTOR = msg({
	message: 'Following',
	comment: 'Tab label in the follow lists modal for the accounts the user follows. Keep it concise.',
});
const NO_FOLLOWERS_YET_DESCRIPTOR = msg({
	message: 'No followers yet.',
	comment: 'Empty state in the followers tab of the follow lists modal.',
});
const NOT_FOLLOWING_ANYONE_YET_DESCRIPTOR = msg({
	message: 'Not following anyone yet.',
	comment: 'Empty state in the following tab of the follow lists modal.',
});
const YOU_CAN_T_VIEW_THIS_LIST_DESCRIPTOR = msg({
	message: "You can't view this list.",
	comment:
		'Shown in the follow lists modal when the server hides the list, for example because the viewer shares no community or friendship with the user. Keep tone plain and not blaming.',
});
const COULDN_T_LOAD_THIS_LIST_DESCRIPTOR = msg({
	message: "Couldn't load this list.",
	comment: 'Error shown in the follow lists modal when a page of the list fails to load. A retry button follows.',
});
const BACK_TO_THE_START_DESCRIPTOR = msg({
	message: 'Back to the start',
	comment:
		'Button at the top of a long follow list after its earliest entries were unloaded to save memory. Reloads the list from the first entry.',
});
const REMOVE_FOLLOWER_DESCRIPTOR = msg({
	message: 'Remove follower',
	comment: 'Button label on a row of your own followers list that makes that account stop following you.',
});

const ROW_HEIGHT_PX = 48;
const OVERSCAN_ROWS = 5;

interface FollowListModalProps {
	userId: string;
	initialKind: FollowListKind;
}

export const FollowListModal = observer(({userId, initialKind}: FollowListModalProps) => {
	const {i18n} = useLingui();
	const [kind, setKind] = useState(initialKind);
	const user = Users.getUser(userId);
	return (
		<Modal.Root size="small" className={styles.modalRoot} data-flx="follow.follow-list-modal.modal-root">
			<Modal.Header
				title={user ? NicknameUtils.getNickname(user, null) : ''}
				data-flx="follow.follow-list-modal.modal-header"
			>
				<Tabs
					tabs={[
						{key: 'followers', label: i18n._(FOLLOWERS_DESCRIPTOR)},
						{key: 'following', label: i18n._(FOLLOWING_DESCRIPTOR)},
					]}
					activeTab={kind}
					onTabChange={setKind}
					data-flx="follow.follow-list-modal.tabs"
				/>
			</Modal.Header>
			<FollowListView key={kind} kind={kind} userId={userId} data-flx="follow.follow-list-modal.follow-list-view" />
		</Modal.Root>
	);
});

const FollowListView = observer(({kind, userId}: {kind: FollowListKind; userId: string}) => {
	const {i18n} = useLingui();
	const scrollerRef = useRef<ScrollerHandle>(null);
	const [listId, setListId] = useState<string | null>(null);
	useEffect(() => {
		const openedListId = FollowLists.open(kind, userId);
		setListId(openedListId);
		return () => FollowLists.close(openedListId);
	}, [kind, userId]);
	const list = listId ? FollowLists.getList(listId) : null;
	const entries = listId ? FollowLists.getEntries(listId) : [];
	const rowHeight = ROW_HEIGHT_PX * getAppRemScale();
	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => scrollerRef.current?.getViewportElement() ?? null,
		estimateSize: () => rowHeight,
		overscan: OVERSCAN_ROWS,
	});
	const virtualRows = virtualizer.getVirtualItems();
	const lastVisibleIndex = virtualRows.at(-1)?.index ?? -1;
	useEffect(() => {
		if (listId && lastVisibleIndex >= entries.length - OVERSCAN_ROWS) {
			void FollowCommands.loadNextPage(listId);
		}
	}, [listId, lastVisibleIndex, entries.length]);
	// Dropping the oldest page shifts every row up by its length; scroll up by the same amount so the view stays put.
	const droppedCount = list?.droppedCount ?? 0;
	const droppedCountRef = useRef(droppedCount);
	useLayoutEffect(() => {
		const removedRows = droppedCount - droppedCountRef.current;
		droppedCountRef.current = droppedCount;
		const viewport = scrollerRef.current?.getViewportElement();
		if (removedRows > 0 && viewport) {
			viewport.scrollTop = Math.max(0, viewport.scrollTop - removedRows * rowHeight);
		}
	}, [droppedCount, rowHeight]);
	const canRemoveFollowers = kind === 'followers' && userId === Authentication.currentUserId;
	const handleRestart = () => {
		if (!listId) return;
		scrollerRef.current?.scrollTo({to: 0});
		void FollowCommands.restart(listId);
	};
	const handleRemoveFollower = async (followerId: string) => {
		if (!(await FollowCommands.removeFollower(followerId))) {
			ToastCommands.error(i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR));
		}
	};
	const renderRow = (entry: FollowListEntry) => {
		const removeLabel = i18n._(REMOVE_FOLLOWER_DESCRIPTOR);
		return (
			<>
				<button
					type="button"
					className={styles.userButton}
					onClick={() => UserProfileCommands.openProfilePage(entry.user.id)}
					data-flx="follow.follow-list-modal.render-row.user-button.open-user-profile"
				>
					<Avatar user={entry.user} size={32} data-flx="follow.follow-list-modal.render-row.avatar" />
					<span className={styles.names} data-flx="follow.follow-list-modal.render-row.names">
						<span className={styles.displayName} data-flx="follow.follow-list-modal.render-row.display-name">
							{NicknameUtils.getNickname(entry.user, null)}
						</span>
						<span className={styles.tag} data-flx="follow.follow-list-modal.render-row.tag">
							{NicknameUtils.formatTagForStreamerMode(entry.user.tag)}
						</span>
					</span>
				</button>
				<RowFollowButton entry={entry} data-flx="follow.follow-list-modal.render-row.row-follow-button" />
				{canRemoveFollowers && (
					<FocusRing offset={-2} data-flx="follow.follow-list-modal.render-row.focus-ring">
						<Tooltip text={removeLabel} data-flx="follow.follow-list-modal.render-row.tooltip">
							<button
								type="button"
								className={styles.removeButton}
								onClick={() => handleRemoveFollower(entry.user.id)}
								aria-label={removeLabel}
								data-flx="follow.follow-list-modal.render-row.remove-button.remove-follower"
							>
								<XIcon
									weight="bold"
									className={styles.removeIcon}
									data-flx="follow.follow-list-modal.render-row.remove-icon"
								/>
							</button>
						</Tooltip>
					</FocusRing>
				)}
			</>
		);
	};
	return (
		<>
			{droppedCount > 0 && (
				<div className={styles.restartBar} data-flx="follow.follow-list-modal.follow-list-view.restart-bar">
					<Button
						small
						variant="secondary"
						onClick={handleRestart}
						disabled={list?.isLoading}
						data-flx="follow.follow-list-modal.follow-list-view.button.restart"
					>
						{i18n._(BACK_TO_THE_START_DESCRIPTOR)}
					</Button>
				</div>
			)}
			<Modal.Content
				ref={scrollerRef}
				padding="none"
				className={styles.content}
				data-flx="follow.follow-list-modal.follow-list-view.content"
			>
				<div
					className={styles.rows}
					style={{height: virtualizer.getTotalSize()}}
					data-flx="follow.follow-list-modal.follow-list-view.rows"
				>
					{virtualRows.map((virtualRow) => {
						const entry = entries[virtualRow.index];
						if (!entry) return null;
						return (
							<div
								key={entry.user.id}
								className={styles.row}
								style={{height: virtualRow.size, transform: `translateY(${virtualRow.start}px)`}}
								data-flx="follow.follow-list-modal.follow-list-view.row"
							>
								{renderRow(entry)}
							</div>
						);
					})}
				</div>
				{list?.isLoading && (
					<div className={styles.status} data-flx="follow.follow-list-modal.follow-list-view.status">
						<Spinner
							size={entries.length === 0 ? 'medium' : 'small'}
							data-flx="follow.follow-list-modal.follow-list-view.spinner"
						/>
					</div>
				)}
				{list?.failure === 'forbidden' && (
					<p className={styles.status} data-flx="follow.follow-list-modal.follow-list-view.status--2">
						{i18n._(YOU_CAN_T_VIEW_THIS_LIST_DESCRIPTOR)}
					</p>
				)}
				{list?.failure === 'error' && listId && (
					<div className={styles.status} data-flx="follow.follow-list-modal.follow-list-view.status--3">
						<p className={styles.statusText} data-flx="follow.follow-list-modal.follow-list-view.status-text">
							{i18n._(COULDN_T_LOAD_THIS_LIST_DESCRIPTOR)}
						</p>
						<Button
							small
							variant="secondary"
							onClick={() => void FollowCommands.retry(listId)}
							data-flx="follow.follow-list-modal.follow-list-view.button"
						>
							{i18n._(TRY_AGAIN_DESCRIPTOR)}
						</Button>
					</div>
				)}
				{list && !list.isLoading && !list.hasMore && !list.failure && entries.length === 0 && (
					<p className={styles.status} data-flx="follow.follow-list-modal.follow-list-view.status--4">
						{i18n._(kind === 'followers' ? NO_FOLLOWERS_YET_DESCRIPTOR : NOT_FOLLOWING_ANYONE_YET_DESCRIPTOR)}
					</p>
				)}
			</Modal.Content>
		</>
	);
});

// Micup: Follow on a row, from the page's is_following (no request per row). Not
// ProfileFollowButton, which reads a cached profile these rows do not have; the row flips through applyFollowChange.
// An account that shares nothing with the viewer and is not public answers 403: the usual follow toast.
const RowFollowButton = observer(({entry}: {entry: FollowListEntry}) => {
	const {i18n} = useLingui();
	const [isBusy, setIsBusy] = useState(false);
	const {user, isFollowing} = entry;
	if (isFollowing === undefined || user.id === Authentication.currentUserId || user.bot || user.system) return null;
	const handleClick = async () => {
		setIsBusy(true);
		const outcome = isFollowing ? await FollowCommands.unfollow(user.id) : await FollowCommands.follow(user.id);
		setIsBusy(false);
		toastFollowFailure(i18n, outcome, isFollowing);
	};
	return (
		<Button
			small
			variant={isFollowing ? 'secondary' : 'primary'}
			className={isFollowing ? followStyles.followingButton : undefined}
			leftIcon={
				isFollowing ? (
					<CheckIcon weight="bold" data-flx="follow.follow-list-modal.row-follow-button.check-icon" />
				) : (
					<PlusIcon weight="bold" data-flx="follow.follow-list-modal.row-follow-button.plus-icon" />
				)
			}
			submitting={isBusy}
			onClick={handleClick}
			data-flx="follow.follow-list-modal.render-row.follow-button"
		>
			{isFollowing ? (
				<>
					<span
						className={followStyles.followIdleLabel}
						data-flx="follow.follow-list-modal.row-follow-button.idle-label"
					>
						{i18n._(FOLLOWING_BUTTON_DESCRIPTOR)}
					</span>
					<span
						className={followStyles.followHoverLabel}
						aria-hidden
						data-flx="follow.follow-list-modal.row-follow-button.hover-label"
					>
						{i18n._(UNFOLLOW_DESCRIPTOR)}
					</span>
				</>
			) : (
				i18n._(FOLLOW_DESCRIPTOR)
			)}
		</Button>
	);
});
