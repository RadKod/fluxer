// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import {outcomeOf} from '@app/features/feed/commands/FeedCommands';
import styles from '@app/features/feed/components/FeedLikers.module.css';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {observeIntersection} from '@app/features/platform/utils/SharedIntersectionObserver';
import {Button} from '@app/features/ui/button/Button';
import {Avatar} from '@app/features/ui/components/Avatar';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {VerifiedUserBadge} from '@app/features/user/components/VerifiedUserBadge';
import {User} from '@app/features/user/models/User';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import type {FeedPostLikersResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const logger = new Logger('FeedLikers');

const LIKERS_PAGE_SIZE = 50;

const LIKED_BY_DESCRIPTOR = msg({
	message: 'Liked by',
	comment: 'Title of the window on a feed post page that lists the accounts that like the post.',
});
const YOU_CAN_T_SEE_LIKERS_DESCRIPTOR = msg({
	message: "You can't see who liked this post.",
	comment:
		'Shown in the likes window of a feed post when the server keeps the list from you, for example because the author only shows it to people allowed to see their profile. Keep tone plain and not blaming.',
});
const COULDN_T_LOAD_LIKERS_DESCRIPTOR = msg({
	message: "Couldn't load who liked this post.",
	comment: 'Error in the likes window of a feed post when the list fails to load. A retry button follows.',
});
const NO_LIKES_YET_DESCRIPTOR = msg({
	message: 'No likes yet.',
	comment: 'Empty state of the likes window of a feed post, when every like was taken back.',
});

// 'hidden': the server refused the list (403, or 404 once the post is gone); it is not asked again.
type LikersStatus = 'loading' | 'more' | 'end' | 'hidden' | 'error';

// ponytail (TEMPORARY:): the window keeps every page it loaded (50 accounts per scroll to the end, by ascending user ID), so
// scrolling through a post with a million likes would hold them all. Upgrade path: virtualize the rows with
// @tanstack/react-virtual like FeedTimelineList and keep at most 200 loaded. Trigger: a client report or a profile
// showing a likers window past 2 000 rows, or posts that reach 100 K likes.
export const FeedLikers = observer(({postId}: {postId: string}) => {
	const {i18n} = useLingui();
	const [likers, setLikers] = useState<ReadonlyArray<User>>([]);
	const [status, setStatus] = useState<LikersStatus>('loading');
	// A new object asks for a page: after the last account shown, or the same page again on a retry.
	const [request, setRequest] = useState<{after?: string}>({});
	const [endOfList, setEndOfList] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		let current = true;
		const {after} = request;
		http
			.get<FeedPostLikersResponse>(Endpoints.FEED_POST_LIKES(postId), {
				query: after ? {limit: LIKERS_PAGE_SIZE, after} : {limit: LIKERS_PAGE_SIZE},
			})
			.then(
				(response) => {
					if (!current) return;
					const page = response.body ?? [];
					setLikers((loaded) => [...loaded, ...page.map((wire) => new User(wire))]);
					// Only an empty page ends the list: the server leaves deleted accounts out, so a short page may not be the last.
					setStatus(page.length === 0 ? 'end' : 'more');
				},
				(error: unknown) => {
					if (!current) return;
					logger.warn(`Failed to load the likers of post ${postId}:`, error);
					setStatus(outcomeOf(error) === 'failed' ? 'error' : 'hidden');
				},
			);
		return () => {
			current = false;
		};
	}, [postId, request]);
	const lastLikerId = likers.at(-1)?.id;
	useEffect(() => {
		if (!endOfList || status !== 'more') return undefined;
		return observeIntersection(endOfList, (entry) => {
			if (!entry.isIntersecting) return;
			setStatus('loading');
			setRequest({after: lastLikerId});
		});
	}, [endOfList, status, lastLikerId]);
	const retry = () => {
		setStatus('loading');
		setRequest((last) => ({...last}));
	};
	return (
		<Modal.Root size="small" data-flx="feed.feed-likers.modal-root">
			<Modal.Header title={i18n._(LIKED_BY_DESCRIPTOR)} data-flx="feed.feed-likers.modal-header" />
			<Modal.Content data-flx="feed.feed-likers.modal-content">
				{status !== 'hidden' && likers.length > 0 && (
					<ul className={styles.list} data-flx="feed.feed-likers.list">
						{likers.map((user) => (
							<li key={user.id} data-flx="feed.feed-likers.li">
								<FocusRing offset={-2} data-flx="feed.feed-likers.focus-ring">
									<button
										type="button"
										className={styles.row}
										onClick={() => UserProfileCommands.openProfilePage(user.id)}
										data-flx="feed.feed-likers.row.open-user-profile.button"
									>
										<Avatar user={user} size={32} data-flx="feed.feed-likers.avatar" />
										<span className={styles.names} data-flx="feed.feed-likers.names">
											<span className={styles.nameRow} data-flx="feed.feed-likers.name-row">
												<span className={styles.name} data-flx="feed.feed-likers.name">
													{NicknameUtils.getNickname(user, null)}
												</span>
												<VerifiedUserBadge user={user} data-flx="feed.feed-likers.verified-user-badge" />
											</span>
											<span className={styles.tag} data-flx="feed.feed-likers.tag">
												{NicknameUtils.formatTagForStreamerMode(user.tag)}
											</span>
										</span>
									</button>
								</FocusRing>
							</li>
						))}
					</ul>
				)}
				{status === 'loading' && (
					<div className={styles.status} data-flx="feed.feed-likers.status">
						<Spinner size={likers.length === 0 ? 'medium' : 'small'} data-flx="feed.feed-likers.spinner" />
					</div>
				)}
				{status === 'hidden' && (
					<p className={styles.status} data-flx="feed.feed-likers.status--2">
						{i18n._(YOU_CAN_T_SEE_LIKERS_DESCRIPTOR)}
					</p>
				)}
				{status === 'error' && (
					<div className={styles.status} data-flx="feed.feed-likers.status--3">
						{i18n._(COULDN_T_LOAD_LIKERS_DESCRIPTOR)}
						<Button small variant="secondary" onClick={retry} data-flx="feed.feed-likers.button.retry">
							{i18n._(TRY_AGAIN_DESCRIPTOR)}
						</Button>
					</div>
				)}
				{status === 'end' && likers.length === 0 && (
					<p className={styles.status} data-flx="feed.feed-likers.status--4">
						{i18n._(NO_LIKES_YET_DESCRIPTOR)}
					</p>
				)}
				<div ref={setEndOfList} aria-hidden data-flx="feed.feed-likers.end-of-list" />
			</Modal.Content>
		</Modal.Root>
	);
});
