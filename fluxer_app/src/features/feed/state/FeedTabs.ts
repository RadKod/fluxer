// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import type {FeedPollDraft} from '@app/features/feed/components/FeedPollEditor';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

// 'home' shows HOME_TIMELINE, the posts of the accounts you follow.
export type FeedTab = 'discover' | 'home';

// What the feed post box held when it went away (to a post page), for the account that wrote it.
export interface FeedComposerDraft {
	readonly userId: string | null;
	readonly text: string;
	readonly files: ReadonlyArray<File>;
	readonly poll: FeedPollDraft | null;
}

class FeedTabs {
	selectedTab: FeedTab = 'discover';
	// "Your posts" instead of the tabs, kept here (not persisted) so it is still chosen after a post page.
	showMine = false;
	// Not observed: the post box reads it once when it comes back. Not persisted (files and another account).
	composerDraft: FeedComposerDraft | null = null;

	constructor() {
		makeAutoObservable(this, {composerDraft: false}, {autoBind: true});
		void makePersistent(this, 'FeedTabs', ['selectedTab']);
	}

	reset(): void {
		this.showMine = false;
		this.composerDraft = null;
	}

	setTab(tab: FeedTab): void {
		this.selectedTab = tab;
	}

	setShowMine(showMine: boolean): void {
		this.showMine = showMine;
	}

	setComposerDraft(draft: FeedComposerDraft | null): void {
		this.composerDraft = draft;
	}
}

const feedTabs = new FeedTabs();
ResettableStates.register(feedTabs, feedTabs.reset);
AccountScopedWork.registerCancellation(() => feedTabs.reset());

export default feedTabs;
