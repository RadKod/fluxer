// SPDX-License-Identifier: AGPL-3.0-or-later

import {User} from '@app/features/user/models/User';
import type {FollowResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import {makeAutoObservable} from 'mobx';

export type FollowListKind = 'followers' | 'following';

export const FOLLOW_LIST_PAGE_SIZE = 100;
// A celebrity list can hold millions of rows, so a list keeps its newest five pages (500 rows) and drops the oldest
// ones; the list offers "back to the start" to see them again.
const FOLLOW_LIST_MAX_PAGES = 5;

export interface FollowListEntry {
	readonly id: string;
	readonly user: User;
	// Micup: whether the viewer follows this account, from the page itself (the server's 60 s following
	// list; no look-up per row). Undefined from an older server: the row shows no Follow button.
	readonly isFollowing?: boolean;
}

export interface FollowList {
	readonly kind: FollowListKind;
	readonly userId: string;
	readonly pages: ReadonlyArray<ReadonlyArray<FollowListEntry>>;
	readonly droppedCount: number;
	readonly hasMore: boolean;
	readonly isLoading: boolean;
	readonly failure: 'forbidden' | 'error' | null;
}

function emptyList(kind: FollowListKind, userId: string): FollowList {
	return {kind, userId, pages: [], droppedCount: 0, hasMore: true, isLoading: false, failure: null};
}

class FollowLists {
	lists: Record<string, FollowList> = {};
	private lastListId = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	open(kind: FollowListKind, userId: string): string {
		this.lastListId += 1;
		const listId = String(this.lastListId);
		this.lists = {...this.lists, [listId]: emptyList(kind, userId)};
		return listId;
	}

	close(listId: string): void {
		const {[listId]: _, ...remaining} = this.lists;
		this.lists = remaining;
	}

	getList(listId: string): FollowList | null {
		return this.lists[listId] ?? null;
	}

	getEntries(listId: string): ReadonlyArray<FollowListEntry> {
		return this.lists[listId]?.pages.flat() ?? [];
	}

	getCursor(listId: string): string | undefined {
		const list = this.lists[listId];
		const last = list?.pages.at(-1)?.at(-1);
		if (!list || !last) return undefined;
		return list.kind === 'followers' ? last.id : last.user.id;
	}

	handleFetchPending(listId: string): void {
		this.patch(listId, {isLoading: true, failure: null});
	}

	handleFetchSuccess(listId: string, page: ReadonlyArray<FollowResponse>): void {
		const list = this.lists[listId];
		if (!list) return;
		if (page.length === 0) {
			this.patch(listId, {isLoading: false, hasMore: false});
			return;
		}
		let pages = [
			...list.pages,
			page.map((follow) => ({id: follow.id, user: new User(follow.user), isFollowing: follow.is_following})),
		];
		let droppedCount = list.droppedCount;
		while (pages.length > FOLLOW_LIST_MAX_PAGES) {
			droppedCount += pages[0]!.length;
			pages = pages.slice(1);
		}
		this.patch(listId, {pages, droppedCount, isLoading: false});
	}

	handleFetchFailure(listId: string, failure: 'forbidden' | 'error'): void {
		this.patch(listId, {isLoading: false, failure, hasMore: failure !== 'forbidden'});
	}

	handleRetry(listId: string): void {
		this.patch(listId, {failure: null});
	}

	handleRestart(listId: string): void {
		const list = this.lists[listId];
		if (list) this.lists = {...this.lists, [listId]: emptyList(list.kind, list.userId)};
	}

	handleFollowerRemoved(userId: string, followerId: string): void {
		for (const [listId, list] of Object.entries(this.lists)) {
			if (list.kind !== 'followers' || list.userId !== userId) continue;
			this.patch(listId, {pages: list.pages.map((page) => page.filter((entry) => entry.user.id !== followerId))});
		}
	}

	// Every open list row of the account whose follow state flips (a follow from anywhere, or its FOLLOW_CREATE/DELETE
	// echo); returns whether one did.
	handleFollowing(userId: string, following: boolean): boolean {
		const flips = (entry: FollowListEntry) =>
			entry.user.id === userId && entry.isFollowing !== undefined && entry.isFollowing !== following;
		let changed = false;
		for (const [listId, list] of Object.entries(this.lists)) {
			if (!list.pages.some((page) => page.some(flips))) continue;
			changed = true;
			this.patch(listId, {
				pages: list.pages.map((page) =>
					page.map((entry) => (flips(entry) ? {...entry, isFollowing: following} : entry)),
				),
			});
		}
		return changed;
	}

	private patch(listId: string, changes: Partial<FollowList>): void {
		const list = this.lists[listId];
		if (list) this.lists = {...this.lists, [listId]: {...list, ...changes}};
	}
}

export default new FollowLists();
