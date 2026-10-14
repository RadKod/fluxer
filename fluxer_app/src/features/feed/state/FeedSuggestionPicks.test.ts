// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SuggestionPicks as Picks} from '@app/features/feed/commands/FeedSuggestionCommands';
import {beforeEach, describe, expect, it} from 'vitest';

// No mocks: the store is plain state, so FollowProfileUtils can import it without the transport
// (FeedSuggestionCommands.loadSuggestions asks the server and hands the answer over).
const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');

const picks = (...userIds: Array<string>): Picks => ({userIds, guilds: []});

function seed(value: Picks): void {
	FeedSuggestionPicks.handleLoaded(FeedSuggestionPicks.beginLoad()!, value);
}

describe('FeedSuggestionPicks', () => {
	beforeEach(() => {
		FeedSuggestionPicks.reset();
	});

	it('lets one load begin per feed page opening and keeps its answer', () => {
		const opening = FeedSuggestionPicks.beginLoad();
		expect(opening).not.toBeNull();
		expect(FeedSuggestionPicks.beginLoad()).toBeNull();
		expect(FeedSuggestionPicks.picks).toBeNull();
		FeedSuggestionPicks.handleLoaded(opening!, picks('7'));
		expect(FeedSuggestionPicks.picks).toEqual(picks('7'));
		expect(FeedSuggestionPicks.beginLoad()).toBeNull();
	});

	it('reset drops the picks, who was followed and a late answer; the next opening may load again', () => {
		seed(picks('7'));
		FeedSuggestionPicks.handleFollowing('7', true);
		const late = FeedSuggestionPicks.beginLoad() ?? -1;
		FeedSuggestionPicks.reset();
		expect(FeedSuggestionPicks.picks).toBeNull();
		expect(FeedSuggestionPicks.isFollowed('7')).toBe(false);
		const opening = FeedSuggestionPicks.beginLoad();
		expect(opening).not.toBeNull();
		// The page closed while that request ran: its answer does not come back as the next page's picks.
		FeedSuggestionPicks.reset();
		FeedSuggestionPicks.handleLoaded(opening!, picks('8'));
		FeedSuggestionPicks.handleLoaded(late, picks('9'));
		expect(FeedSuggestionPicks.picks).toBeNull();
	});

	it('follows every follow change of a suggested person and says when one flipped', () => {
		seed(picks('7', '8'));
		expect(FeedSuggestionPicks.isFollowed('7')).toBe(false);
		expect(FeedSuggestionPicks.handleFollowing('7', true)).toBe(true);
		expect(FeedSuggestionPicks.isFollowed('7')).toBe(true);
		// The FOLLOW_CREATE echo of the same follow is not a second flip.
		expect(FeedSuggestionPicks.handleFollowing('7', true)).toBe(false);
		expect(FeedSuggestionPicks.handleFollowing('7', false)).toBe(true);
		expect(FeedSuggestionPicks.isFollowed('7')).toBe(false);
		// Someone outside the list is not tracked.
		expect(FeedSuggestionPicks.handleFollowing('9', true)).toBe(false);
		expect(FeedSuggestionPicks.isFollowed('9')).toBe(false);
	});

	it('tracks nobody before the picks come', () => {
		expect(FeedSuggestionPicks.handleFollowing('7', true)).toBe(false);
		expect(FeedSuggestionPicks.isFollowed('7')).toBe(false);
	});

	it('drops a person from the picks and leaves the others', () => {
		seed(picks('7', '8'));
		FeedSuggestionPicks.drop('7');
		expect(FeedSuggestionPicks.picks).toEqual(picks('8'));
		// A later change for the dropped person is not tracked.
		expect(FeedSuggestionPicks.handleFollowing('7', true)).toBe(false);
	});
});
