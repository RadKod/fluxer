// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import type {SuggestionPicks as Picks} from '@app/features/feed/commands/FeedSuggestionCommands';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {makeAutoObservable} from 'mobx';

// Micup akis-oneri: the people and communities beside the feed, picked once per feed page opening. Held here, above the
// parts of the page that mount again (Your posts, the phone layout), so the picks and the follows made from them stay;
// FeedPage resets when it goes away and the next opening picks again. Plain state (FeedSuggestionCommands.loadSuggestions
// asks the server), so FollowProfileUtils can report every follow change here.
class FeedSuggestionPicks {
	picks: Picks | null = null;
	private followed = new Set<string>();
	// Not observed: which opening this is, and whether it has asked (a failed request too: hidden until the next one).
	private opening = 0;
	private requested = false;

	constructor() {
		makeAutoObservable<FeedSuggestionPicks, 'opening' | 'requested'>(
			this,
			{opening: false, requested: false},
			{autoBind: true},
		);
	}

	// The opening a request belongs to, or null when this opening already asked.
	beginLoad(): number | null {
		if (this.requested) return null;
		this.requested = true;
		return this.opening;
	}

	handleLoaded(opening: number, picks: Picks | null): void {
		// Reset while it ran (the page closed): the answer belongs to no opening.
		if (opening === this.opening) this.picks = picks;
	}

	reset(): void {
		this.opening++;
		this.requested = false;
		this.picks = null;
		this.followed.clear();
	}

	// Every follow change goes through FollowProfileUtils.applyFollowChange, which calls this: a follow from the list, the
	// profile modal, and the FOLLOW_CREATE/FOLLOW_DELETE echo from any device. The server leaves out accounts the viewer
	// follows, so a person starts as not followed. True when a suggested person's state flipped.
	handleFollowing(userId: string, following: boolean): boolean {
		if (!this.picks?.userIds.includes(userId) || this.followed.has(userId) === following) return false;
		if (following) this.followed.add(userId);
		else this.followed.delete(userId);
		return true;
	}

	// A follow the server refused (403): the person is out of its pool or may not be followed, so the card goes.
	drop(userId: string): void {
		if (!this.picks) return;
		this.picks = {...this.picks, userIds: this.picks.userIds.filter((id) => id !== userId)};
		this.followed.delete(userId);
	}

	isFollowed(userId: string): boolean {
		return this.followed.has(userId);
	}
}

const feedSuggestionPicks = new FeedSuggestionPicks();
ResettableStates.register(feedSuggestionPicks, feedSuggestionPicks.reset);
AccountScopedWork.registerCancellation(() => feedSuggestionPicks.reset());

export default feedSuggestionPicks;
