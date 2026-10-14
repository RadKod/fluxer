// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/api/models/User';
import type {ProfileAudience} from '@app/api/user/profile/ProfilePrivacy';

export type {ProfileAudience} from '@app/api/user/profile/ProfilePrivacy';

// close = friends or mutual follows; guild = a shared community; weak = a pending request or a shared group DM only.
export type ProfileBond = 'close' | 'guild' | 'weak' | 'none';
export type ProfileView = 'full' | 'public' | 'limited';

export interface ProfileViewer {
	user: User; // the caller (ctx.get('user'))
	human: boolean; // a session token of a non-bot account; OAuth bearer, bot and admin keys are never strangers
	countStranger: boolean; // only the profile, follow list and post list routes spend the daily stranger budget
}

export interface ProfileAccessResult {
	view: ProfileView | null; // null = 403
	blocked: boolean; // a block either way
	audience: ProfileAudience; // the owner's effective level
	friend: boolean; // the field privacy context (ProfileFieldPrivacyFlags.FRIENDS), from the pair record
	sharedGuild: boolean; // the field privacy context (MUTUAL_GUILDS), from the side record's guild IDs
	feedHidden: boolean; // DISABLED | DELETED: the feed shows no posts
	publicHidden: boolean; // PUBLIC_HIDDEN_AUTHOR_FLAGS
	spammer: boolean; // UserFlags.SPAMMER
}

/**
 * what a viewer sees of a profile, after the owner and missing-account checks. A block either way
 * leaves a bonded viewer the limited profile and a stranger nothing; bot profiles stay open; then the level.
 * null is a refusal (403).
 */
export function decideProfileView(input: {
	audience: ProfileAudience;
	bond: ProfileBond;
	blocked: boolean;
	bot: boolean;
	strangerOk: boolean;
}): ProfileView | null {
	const {audience, bond} = input;
	if (input.blocked) return bond === 'none' ? null : 'limited';
	if (input.bot) return 'full';
	if (audience === 'everyone') {
		if (bond === 'close' || bond === 'guild') return 'full';
		// A pending request or a shared group DM alone opens no more than a stranger's view.
		if (input.strangerOk) return 'public';
		return bond === 'weak' ? 'limited' : null;
	}
	if (bond === 'none') return null;
	switch (audience) {
		case 'guilds':
			return bond === 'weak' ? 'limited' : 'full';
		case 'close':
			return bond === 'close' ? 'full' : 'limited';
		case 'only_me':
			return 'limited';
	}
}
