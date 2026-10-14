// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import type {DiscoveryGuild} from '@app/features/discovery/commands/DiscoveryCommands';
import {joinDiscoveryGuild} from '@app/features/discovery/commands/DiscoveryJoinCommands';
import {DiscoveryGuildPreviewModal} from '@app/features/discovery/components/modals/DiscoveryGuildPreviewModal';
import {loadSuggestions} from '@app/features/feed/commands/FeedSuggestionCommands';
import styles from '@app/features/feed/components/FeedSuggestions.module.css';
import FeedSuggestionPicks from '@app/features/feed/state/FeedSuggestionPicks';
import {isFeedSuggestionsEnabled} from '@app/features/feed/utils/FeedUtils';
import * as FollowCommands from '@app/features/follow/commands/FollowCommands';
import {
	FOLLOW_DESCRIPTOR,
	FOLLOWING_DESCRIPTOR,
	toastFollowFailure,
	UNFOLLOW_DESCRIPTOR,
} from '@app/features/follow/components/ProfileFollowActions';
import followStyles from '@app/features/follow/components/ProfileFollowActions.module.css';
import {GuildIcon} from '@app/features/guild/components/popouts/GuildIcon';
import Guilds from '@app/features/guild/state/Guilds';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {msg} from '@lingui/core/macro';
import {Plural, Trans, useLingui} from '@lingui/react/macro';
import {CheckIcon, PlusIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useId, useState} from 'react';

const POPULAR_PEOPLE_DESCRIPTOR = msg({
	message: 'Popular people',
	comment:
		'Heading of the list beside the feed, under your profile card, of up to five popular accounts you can follow. Keep it concise.',
});
const POPULAR_COMMUNITIES_DESCRIPTOR = msg({
	message: 'Popular communities',
	comment:
		'Heading of the list beside the feed, under your profile card, of up to five popular public communities you can join. Keep it concise.',
});
const FOLLOW_USER_DESCRIPTOR = msg({
	message: 'Follow {name}',
	comment:
		'Accessible name of the Follow button on a person in the popular people list beside the feed. {name} is their display name.',
});
const FOLLOWING_USER_DESCRIPTOR = msg({
	message: 'Following {name}',
	context: 'follow-button',
	comment:
		'Accessible name of the button on a person in the popular people list beside the feed once you follow them; a click unfollows. {name} is their display name.',
});
const JOIN_DESCRIPTOR = msg({
	message: 'Join',
	comment:
		'Button on a community in the popular communities list beside the feed: joins it and stays on the feed. Keep it concise.',
});
const JOINED_DESCRIPTOR = msg({
	message: 'Joined',
	context: 'discovery-join-status',
	comment:
		'Shown in place of the Join button on a community in the popular communities list beside the feed once you are a member. Keep it concise.',
});

const ICON_SIZE_PX = 32;

const SuggestedPerson = observer(({user}: {user: User}) => {
	const {i18n} = useLingui();
	const following = FeedSuggestionPicks.isFollowed(user.id);
	const [busy, setBusy] = useState(false);
	const name = NicknameUtils.getNickname(user, null);
	const toggleFollow = async () => {
		const wasFollowing = following;
		setBusy(true);
		// No post id: the server allows a stranger's follow only for an account in its suggestion pool.
		const outcome = wasFollowing ? await FollowCommands.unfollow(user.id) : await FollowCommands.follow(user.id);
		setBusy(false);
		// The follow state itself flips through FollowProfileUtils.applyFollowChange (FeedSuggestionPicks.handleFollowing).
		if (!wasFollowing && outcome === 'forbidden') FeedSuggestionPicks.drop(user.id);
		toastFollowFailure(i18n, outcome, wasFollowing);
	};
	return (
		<li className={styles.row} data-flx="feed.feed-suggestions.suggested-person.row">
			<FocusRing offset={-2} data-flx="feed.feed-suggestions.suggested-person.focus-ring">
				<button
					type="button"
					className={styles.identity}
					onClick={() => UserProfileCommands.openProfilePage(user.id)}
					data-flx="feed.feed-suggestions.suggested-person.identity.open-profile"
				>
					<Avatar user={user} size={ICON_SIZE_PX} data-flx="feed.feed-suggestions.suggested-person.avatar" />
					<span className={styles.names} data-flx="feed.feed-suggestions.suggested-person.names">
						<span className={styles.name} data-flx="feed.feed-suggestions.suggested-person.name">
							{name}
						</span>
						<span className={styles.detail} data-flx="feed.feed-suggestions.suggested-person.tag">
							{NicknameUtils.formatTagForStreamerMode(user.tag)}
						</span>
					</span>
				</button>
			</FocusRing>
			<Button
				small
				variant="secondary"
				className={clsx(styles.action, following && followStyles.followingButton)}
				leftIcon={
					following ? (
						<CheckIcon weight="bold" data-flx="feed.feed-suggestions.suggested-person.check-icon" />
					) : (
						<PlusIcon weight="bold" data-flx="feed.feed-suggestions.suggested-person.plus-icon" />
					)
				}
				submitting={busy}
				aria-label={i18n._(following ? FOLLOWING_USER_DESCRIPTOR : FOLLOW_USER_DESCRIPTOR, {name})}
				onClick={toggleFollow}
				data-flx="feed.feed-suggestions.suggested-person.button.toggle-follow"
			>
				{following ? (
					<>
						<span className={followStyles.followIdleLabel} data-flx="feed.feed-suggestions.suggested-person.idle-label">
							{i18n._(FOLLOWING_DESCRIPTOR)}
						</span>
						<span
							className={followStyles.followHoverLabel}
							aria-hidden
							data-flx="feed.feed-suggestions.suggested-person.hover-label"
						>
							{i18n._(UNFOLLOW_DESCRIPTOR)}
						</span>
					</>
				) : (
					i18n._(FOLLOW_DESCRIPTOR)
				)}
			</Button>
		</li>
	);
});

const SuggestedCommunity = observer(({guild}: {guild: DiscoveryGuild}) => {
	const {i18n} = useLingui();
	const nameId = useId();
	const [joinedHere, setJoinedHere] = useState(false);
	const [busy, setBusy] = useState(false);
	// Joined here, or already a member (joined elsewhere too, the preview modal included).
	const joined = joinedHere || Guilds.getGuild(guild.id) != null;
	const openPreview = () => {
		ModalCommands.push(
			modal(() => (
				<DiscoveryGuildPreviewModal guild={guild} data-flx="feed.feed-suggestions.suggested-community.preview-modal" />
			)),
		);
	};
	const join = async () => {
		setBusy(true);
		const ok = await joinDiscoveryGuild(guild.id, {open: false});
		setBusy(false);
		if (ok) setJoinedHere(true);
	};
	return (
		<li className={styles.row} data-flx="feed.feed-suggestions.suggested-community.row">
			<FocusRing offset={-2} data-flx="feed.feed-suggestions.suggested-community.focus-ring">
				<button
					type="button"
					className={styles.identity}
					onClick={openPreview}
					data-flx="feed.feed-suggestions.suggested-community.identity.open-preview"
				>
					<GuildIcon
						id={guild.id}
						name={guild.name}
						icon={guild.icon}
						sizePx={ICON_SIZE_PX}
						containerProps={{'aria-hidden': true}}
						data-flx="feed.feed-suggestions.suggested-community.guild-icon"
					/>
					<span className={styles.names} data-flx="feed.feed-suggestions.suggested-community.names">
						<span id={nameId} className={styles.name} data-flx="feed.feed-suggestions.suggested-community.name">
							{guild.name}
						</span>
						<span className={styles.detail} data-flx="feed.feed-suggestions.suggested-community.members">
							<Trans>
								<Plural
									value={guild.member_count}
									one="# member"
									other="# members"
									data-flx="feed.feed-suggestions.suggested-community.plural"
								/>
							</Trans>
						</span>
					</span>
				</button>
			</FocusRing>
			{joined ? (
				<span className={styles.joined} data-flx="feed.feed-suggestions.suggested-community.joined">
					<CheckIcon weight="bold" aria-hidden data-flx="feed.feed-suggestions.suggested-community.check-icon" />
					{i18n._(JOINED_DESCRIPTOR)}
				</span>
			) : (
				<Button
					small
					variant="secondary"
					className={styles.action}
					submitting={busy}
					aria-describedby={nameId}
					onClick={join}
					data-flx="feed.feed-suggestions.suggested-community.button.join"
				>
					{i18n._(JOIN_DESCRIPTOR)}
				</Button>
			)}
		</li>
	);
});

// Micup akis-oneri: up to five popular people and five popular Discovery communities under the profile card. One
// request per feed page opening (FeedSuggestionPicks): the picks stay through tab changes, follows and joins, so they do
// not move under the pointer, and the next opening of the feed picks again.
export const FeedSuggestions = observer(() => {
	const {i18n} = useLingui();
	const peopleHeadingId = useId();
	const communitiesHeadingId = useId();
	const enabled = isFeedSuggestionsEnabled() && !MobileLayout.enabled;
	useEffect(() => {
		if (enabled) void loadSuggestions();
	}, [enabled]);
	const picks = FeedSuggestionPicks.picks;
	if (!enabled || !picks) return null;
	const people = picks.userIds.map((id) => Users.getUser(id)).filter((user): user is User => user != null);
	// No joining from Discovery while the instance runs a single community (DiscoveryGuildPreviewModal's rule).
	const communities = RuntimeConfig.singleCommunityEnabled ? [] : picks.guilds;
	if (people.length === 0 && communities.length === 0) return null;
	return (
		<>
			{people.length > 0 && (
				<section
					className={styles.section}
					aria-labelledby={peopleHeadingId}
					data-flx="feed.feed-suggestions.people-section"
				>
					<h2 id={peopleHeadingId} className={styles.heading} data-flx="feed.feed-suggestions.people-heading">
						{i18n._(POPULAR_PEOPLE_DESCRIPTOR)}
					</h2>
					<ul className={styles.list} data-flx="feed.feed-suggestions.people-list">
						{people.map((user) => (
							<SuggestedPerson key={user.id} user={user} data-flx="feed.feed-suggestions.suggested-person" />
						))}
					</ul>
				</section>
			)}
			{communities.length > 0 && (
				<section
					className={styles.section}
					aria-labelledby={communitiesHeadingId}
					data-flx="feed.feed-suggestions.communities-section"
				>
					<h2 id={communitiesHeadingId} className={styles.heading} data-flx="feed.feed-suggestions.communities-heading">
						{i18n._(POPULAR_COMMUNITIES_DESCRIPTOR)}
					</h2>
					<ul className={styles.list} data-flx="feed.feed-suggestions.communities-list">
						{communities.map((guild) => (
							<SuggestedCommunity key={guild.id} guild={guild} data-flx="feed.feed-suggestions.suggested-community" />
						))}
					</ul>
				</section>
			)}
		</>
	);
});
