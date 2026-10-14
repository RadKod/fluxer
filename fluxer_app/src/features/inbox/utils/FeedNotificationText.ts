// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedNotificationType} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const TEXT_BY_TYPE: Record<FeedNotificationType, MessageDescriptor> = {
	post_like: msg({
		message:
			'{othersCount, plural, =0 {{name} liked your post.} one {{name} and # other liked your post.} other {{name} and # others liked your post.}}',
		comment:
			'Activity notification in the inbox. {name} is the account that liked your feed post most recently; {othersCount} is how many other accounts liked it too.',
	}),
	post_comment: msg({
		message:
			'{othersCount, plural, =0 {{name} commented on your post.} one {{name} and # other commented on your post.} other {{name} and # others commented on your post.}}',
		comment:
			'Activity notification in the inbox. {name} is the account that commented on your feed post most recently; {othersCount} is how many other accounts commented too.',
	}),
	follow: msg({
		message:
			'{othersCount, plural, =0 {{name} started following you.} one {{name} and # other started following you.} other {{name} and # others started following you.}}',
		comment:
			'Activity notification in the inbox. {name} is the account that followed you most recently; {othersCount} is how many other accounts followed you too.',
	}),
	comment_reply: msg({
		message:
			'{othersCount, plural, =0 {{name} replied to your comment.} one {{name} and # other replied to your comment.} other {{name} and # others replied to your comment.}}',
		comment:
			'Activity notification in the inbox. {name} is the account that replied to your comment on a feed post most recently; {othersCount} is how many other accounts replied too.',
	}),
};

// actorCount counts every account folded into the row, the named one included.
export function describeFeedNotification(
	i18n: I18n,
	type: FeedNotificationType,
	name: string,
	actorCount: number,
): string {
	return i18n._(TEXT_BY_TYPE[type], {name, othersCount: Math.max(0, actorCount - 1)});
}
