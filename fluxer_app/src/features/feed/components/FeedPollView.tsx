// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import styles from '@app/features/feed/components/FeedPollView.module.css';
import type {FeedPost} from '@app/features/feed/state/FeedTimeline';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {getRelativeDateString} from '@app/features/user/utils/DateFormatting';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckCircleIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const VOTE_FOR_DESCRIPTOR = msg({
	message: 'Vote for {option}',
	comment: 'Accessible label of one answer button in a feed post poll. {option} is the answer text.',
});
const VOTES_DESCRIPTOR = msg({
	message: '{count, plural, one {# vote} other {# votes}}',
	comment: 'Vote count of a feed post poll, for one answer or the whole poll. {count} is the number of votes.',
});
const YOUR_VOTE_DESCRIPTOR = msg({
	message: 'Your vote',
	comment: 'Screen reader label of the tick next to the answer you picked in a feed post poll.',
});
const POLL_ENDED_DESCRIPTOR = msg({
	message: 'Poll ended',
	comment: 'Shown under a feed post poll that no longer takes votes.',
});
const POLL_ENDS_DESCRIPTOR = msg({
	message: 'Ends {time}',
	comment: 'Shown under a feed post poll that still takes votes. {time} is when voting ends, like "Today at 14:00".',
});

// Results are drawn only from poll.votes, which the server leaves null until the viewer votes, is the author or the
// poll ends; before that the options are vote buttons (or plain text for the author). The vote is not optimistic:
// the answer is the post with the results, so the buttons stay off while it is on its way.
export const FeedPollView = observer(({post}: {post: FeedPost}) => {
	const {i18n} = useLingui();
	const [voting, setVoting] = useState(false);
	const poll = post.poll;
	if (!poll) return null;
	const ended = Date.parse(poll.expiresAt) <= Date.now();
	const votes = poll.votes;
	const canVote = votes === null && !ended && post.author.id !== Authentication.currentUserId;
	const total = votes ? votes.reduce((sum, count) => sum + count, 0) : 0;
	const vote = async (option: number) => {
		setVoting(true);
		const outcome = await FeedCommands.votePoll(post.id, option);
		setVoting(false);
		toastFeedFailure(i18n, outcome);
	};
	return (
		<div className={styles.poll} data-flx="feed.feed-poll-view.poll">
			<ul className={styles.options} data-flx="feed.feed-poll-view.options">
				{poll.options.map((option, index) => {
					if (votes === null) {
						return (
							<li key={index} className={styles.option} data-flx="feed.feed-poll-view.options.option">
								{canVote ? (
									<FocusRing offset={-2} data-flx="feed.feed-poll-view.vote-focus-ring">
										<button
											type="button"
											className={styles.voteButton}
											onClick={() => void vote(index)}
											disabled={voting}
											aria-label={i18n._(VOTE_FOR_DESCRIPTOR, {option})}
											data-flx="feed.feed-poll-view.vote-button.vote"
										>
											{option}
										</button>
									</FocusRing>
								) : (
									<span className={styles.optionText} data-flx="feed.feed-poll-view.option-text">
										{option}
									</span>
								)}
							</li>
						);
					}
					const count = votes[index] ?? 0;
					const share = total > 0 ? count / total : 0;
					const mine = poll.voted === index;
					return (
						<li key={index} className={clsx(styles.result, mine && styles.mine)} data-flx="feed.feed-poll-view.result">
							<span
								className={styles.bar}
								style={{width: `${share * 100}%`}}
								aria-hidden
								data-flx="feed.feed-poll-view.bar"
							/>
							<span className={styles.resultLine} data-flx="feed.feed-poll-view.result-line">
								<span className={styles.resultOption} data-flx="feed.feed-poll-view.result-option">
									{option}
								</span>
								{mine && (
									<span
										className={styles.check}
										role="img"
										aria-label={i18n._(YOUR_VOTE_DESCRIPTOR)}
										data-flx="feed.feed-poll-view.check"
									>
										<CheckCircleIcon weight="fill" aria-hidden data-flx="feed.feed-poll-view.check-circle-icon" />
									</span>
								)}
								<span className={styles.share} data-flx="feed.feed-poll-view.share">
									{i18n.number(share, {style: 'percent'})}
								</span>
								<span className={styles.count} data-flx="feed.feed-poll-view.count">
									{i18n._(VOTES_DESCRIPTOR, {count})}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
			<p className={styles.footer} data-flx="feed.feed-poll-view.footer">
				{votes !== null && <span data-flx="feed.feed-poll-view.total">{i18n._(VOTES_DESCRIPTOR, {count: total})}</span>}
				<span data-flx="feed.feed-poll-view.status">
					{ended
						? i18n._(POLL_ENDED_DESCRIPTOR)
						: i18n._(POLL_ENDS_DESCRIPTOR, {time: getRelativeDateString(poll.expiresAt, i18n)})}
				</span>
			</p>
		</div>
	);
});
