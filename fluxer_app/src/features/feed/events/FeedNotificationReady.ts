// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseAccountStorageKey} from '@app/features/auth/state/AccountStorageKey';
import * as FeedNotificationCommands from '@app/features/inbox/commands/FeedNotificationCommands';
import FeedNotifications, {FEED_NOTIFICATIONS_STORAGE_KEY} from '@app/features/inbox/state/FeedNotifications';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {getAppStorageScope} from '@app/features/platform/state/PersistentStorage';
import {awaitHydration} from '@app/features/platform/utils/MobXPersistence';
import type {FeedNotificationStateResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

// The first READYs after the server cursor ships find it empty; each device sends its own read time once, spread over a
// minute so a release does not bring them all at once.
const MIGRATION_SPREAD_MS = 60_000;

// Pushes and reads that come while a READY waits for the saved state: applied after it, in order. Applied before
// it, READY's reset would drop them.
let waitingReadies = 0;
const held: Array<() => void> = [];
let transitionEpoch = 0;
let pendingReady: {state: FeedNotificationStateResponse | undefined; userId: string; accountKey: string} | null = null;

function flushHeld(): void {
	if (waitingReadies === 0 && pendingReady === null && !AccountScopedWork.isSuspended) {
		for (const apply of held.splice(0)) apply();
	}
}

AccountScopedWork.registerTransition({
	suspend: () => {
		transitionEpoch++;
		pendingReady = null;
		held.splice(0);
	},
	resume: () => {},
	released: () => {
		const ready = pendingReady;
		pendingReady = null;
		if (ready !== null && ready.accountKey === getAppStorageScope()) {
			return handleFeedNotificationReady(ready.state, ready.userId, ready.accountKey);
		}
		flushHeld();
		return undefined;
	},
});

export function afterFeedNotificationReady(apply: () => void, accountKey: string | null = getAppStorageScope()): void {
	if (accountKey !== getAppStorageScope()) return;
	if (AccountScopedWork.isSuspended) {
		const epoch = transitionEpoch;
		held.push(() => {
			if (epoch === transitionEpoch && accountKey === getAppStorageScope()) apply();
		});
		return;
	}
	if (waitingReadies > 0) {
		const ticket = AccountScopedWork.begin();
		ticket.dispose();
		held.push(() => {
			if (!ticket.isStale && accountKey === getAppStorageScope()) apply();
		});
	} else apply();
}

// READY's feed inbox state (2a.9b). The saved read time and its owner hydrate asynchronously, so READY waits for them.
export async function handleFeedNotificationReady(
	state: FeedNotificationStateResponse | undefined,
	userId: string,
	accountKey: string | null = getAppStorageScope(),
): Promise<void> {
	if (accountKey !== getAppStorageScope() || parseAccountStorageKey(accountKey)?.userId !== userId) return;
	if (AccountScopedWork.isSuspended) {
		if (pendingReady !== null) held.splice(0);
		pendingReady = {state, userId, accountKey};
		return;
	}
	const ticket = AccountScopedWork.begin();
	ticket.dispose();
	waitingReadies++;
	// A saved state that could not be read leaves the device's defaults; READY applies all the same.
	await awaitHydration(FEED_NOTIFICATIONS_STORAGE_KEY).catch(() => undefined);
	if (ticket.isStale || accountKey !== getAppStorageScope()) {
		waitingReadies--;
		flushHeld();
		return;
	}
	const {lastReadUserId: owner, lastReadAt: deviceReadAt} = FeedNotifications;
	FeedNotifications.handleGatewayReady(state, userId);
	waitingReadies--;
	flushHeld();
	// Only this account's own time; a time saved before owners were kept binds to the first account.
	if (state?.last_read_at !== null || deviceReadAt === 0 || (owner !== null && owner !== userId)) return;
	setTimeout(() => {
		// The account may have changed during the wait: its time must not reach another account.
		if (!ticket.isStale && accountKey === getAppStorageScope() && FeedNotifications.lastReadUserId === userId)
			void FeedNotificationCommands.sendReadCursor(deviceReadAt, 0, 0);
	}, Math.random() * MIGRATION_SPREAD_MS);
}
