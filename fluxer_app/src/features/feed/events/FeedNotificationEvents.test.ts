// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ForegroundPromoteCoordinator,
	type ForegroundPromoteHost,
	type WarmForegroundCandidate,
} from '@app/features/gateway/transport/ForegroundPromoteCoordinator';
import type {GatewayDispatchDelivery, GatewaySocket} from '@app/features/gateway/transport/GatewaySocket';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const SOURCE_ACCOUNT = 'https://first.test/api::me';
const TARGET_ACCOUNT = 'https://second.test/api::me';
const storageScope = vi.hoisted(() => ({value: 'https://first.test/api::me'}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({getAppStorageScope: () => storageScope.value}));

const commands = vi.hoisted(() => ({sendReadCursor: vi.fn()}));
const store = vi.hoisted(() => ({
	lastReadAt: 0,
	lastReadUserId: null as string | null,
	handleGatewayReady: vi.fn(),
	handleNotificationCreate: vi.fn(),
	handleAck: vi.fn(),
}));
vi.mock('@app/features/inbox/commands/FeedNotificationCommands', () => commands);
vi.mock('@app/features/inbox/state/FeedNotifications', () => ({
	default: store,
	FEED_NOTIFICATIONS_STORAGE_KEY: 'FeedNotifications',
}));
const hydration = vi.hoisted(() => ({promise: Promise.resolve()}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({awaitHydration: () => hydration.promise}));

const {AccountScopedWork, AccountScopedWorkTransitionReason} = await import(
	'@app/features/platform/state/AccountScopedWork'
);
const {handleFeedNotificationReady, afterFeedNotificationReady} = await import(
	'@app/features/feed/events/FeedNotificationReady'
);
const {handleFeedNotificationAck} = await import('@app/features/feed/events/FeedNotificationAck');
const {handleFeedNotificationCreate} = await import('@app/features/feed/events/FeedNotificationCreate');

const empty = {last_read_at: null, unread_count: 0, unread_seq: 0, unread_epoch: 0};

describe('feed notification gateway events (2a.9b)', () => {
	beforeEach(() => {
		storageScope.value = SOURCE_ACCOUNT;
		store.handleGatewayReady.mockReset();
		store.handleNotificationCreate.mockReset();
		store.handleAck.mockReset();
		store.lastReadAt = 0;
		store.lastReadUserId = null;
	});

	it('replays a warm promotion CREATE and ACK after release without a READY', async () => {
		const push = {
			id: '1',
			type: 'post_like' as const,
			post_id: '2',
			comment_id: null,
			actors: [],
			actor_count: 1,
			updated_at: '2027-01-01T01:00:00.000Z',
			unread_seq: 10,
			unread_epoch: 0,
		};
		const ack = {last_read_at: push.updated_at, unread_seq: 10, unread_epoch: 0};
		const order: Array<string> = [];
		store.handleNotificationCreate.mockImplementation(() => order.push('push'));
		store.handleAck.mockImplementation(() => order.push('ack'));
		const handover = {deliver: (_item: GatewayDispatchDelivery) => {}};
		const candidate: WarmForegroundCandidate = {
			isBackgroundConnectionReady: true,
			beginBackgroundDispatchHandover: (listener) => {
				handover.deliver = listener;
			},
			endBackgroundDispatchHandover: vi.fn(),
			detachBackgroundSocket: () => ({}) as GatewaySocket,
			waitForBackgroundConnectionReady: async () => true,
			waitForBackgroundDispatchIdle: async () => {},
		};
		const host: ForegroundPromoteHost = {
			findWarmCandidate: () => candidate,
			prepareForegroundSnapshot: async () => true,
			hydrateForegroundSnapshot: async () => {
				storageScope.value = TARGET_ACCOUNT;
			},
			commitForegroundSnapshot: () => true,
			abortForegroundSnapshot: vi.fn(),
			finalizeForegroundSnapshot: vi.fn(),
			stopBackgroundConnection: vi.fn(),
			prepareForegroundReplay: vi.fn(),
			adoptForegroundSocket: vi.fn(),
			finalizeForeground: vi.fn(),
			removeBackgroundConnection: vi.fn(),
			discardDetachedSocket: vi.fn(),
			discardForegroundConnection: vi.fn(),
			replayForegroundDispatch: (accountKey, item) => {
				if (item.type === 'FEED_NOTIFICATION_CREATE')
					handleFeedNotificationCreate(item.data as never, {accountKey} as never);
				else handleFeedNotificationAck(item.data as never, {accountKey} as never);
			},
		};
		const coordinator = new ForegroundPromoteCoordinator(host);
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			await coordinator.begin(TARGET_ACCOUNT);
			for (const [index, [type, data]] of [
				['FEED_NOTIFICATION_CREATE', push],
				['FEED_NOTIFICATION_ACK', ack],
			].entries()) {
				handover.deliver({
					type,
					data,
					retainedByteSize: 8,
					receipt: {sequence: index + 1, generation: 0},
				} as unknown as GatewayDispatchDelivery);
			}
			expect(await coordinator.complete(TARGET_ACCOUNT)).toEqual({mode: 'warm'});
			expect(order).toEqual([]);
		});
		expect(store.handleGatewayReady).not.toHaveBeenCalled();
		expect(order).toEqual(['push', 'ack']);
		expect(store.handleNotificationCreate).toHaveBeenCalledWith(push, 10, 0);
		expect(store.handleAck).toHaveBeenCalledWith(ack);
	});

	it('releases source pushes on an early failed switch and discards READY-less target pushes on rollback', async () => {
		const failure = new Error('begin promotion failed');
		await expect(
			AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
				afterFeedNotificationReady(() => store.handleNotificationCreate('source'), SOURCE_ACCOUNT);
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(store.handleNotificationCreate.mock.calls).toEqual([['source']]);
		store.handleNotificationCreate.mockClear();
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
			afterFeedNotificationReady(() => store.handleNotificationCreate('target'), TARGET_ACCOUNT);
			storageScope.value = SOURCE_ACCOUNT;
		});
		expect(store.handleNotificationCreate).not.toHaveBeenCalled();
	});

	it('defers the target READY and its pushes/acks until admission opens, in order', async () => {
		const state = {...empty, last_read_at: '2027-01-01T00:00:00.000Z', unread_count: 4, unread_seq: 9};
		const push = {
			id: '1',
			type: 'post_like' as const,
			post_id: '2',
			comment_id: null,
			actors: [],
			actor_count: 1,
			updated_at: '2027-01-01T01:00:00.000Z',
			unread_seq: 10,
			unread_epoch: 0,
		};
		const ack = {last_read_at: push.updated_at, unread_seq: 9, unread_epoch: 0};
		const order: Array<string> = [];
		store.handleGatewayReady.mockImplementation(() => order.push('ready'));
		store.handleNotificationCreate.mockImplementation(() => order.push('push'));
		store.handleAck.mockImplementation(() => order.push('ack'));
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
			await handleFeedNotificationReady(state, 'me', TARGET_ACCOUNT);
			handleFeedNotificationCreate(push, {accountKey: TARGET_ACCOUNT} as never);
			handleFeedNotificationAck(ack, {accountKey: TARGET_ACCOUNT} as never);
			expect(order).toEqual([]);
		});
		expect(order).toEqual(['ready', 'push', 'ack']);
		expect(store.handleGatewayReady).toHaveBeenCalledWith(state, 'me');
		expect(store.handleNotificationCreate).toHaveBeenCalledWith(push, 10, 0);
		expect(store.handleAck).toHaveBeenCalledWith(ack);
	});

	it('checks the full gateway account key and its user when admission is open', async () => {
		storageScope.value = TARGET_ACCOUNT;
		await handleFeedNotificationReady(empty, 'me', SOURCE_ACCOUNT);
		await handleFeedNotificationReady(empty, 'other-user', TARGET_ACCOUNT);
		afterFeedNotificationReady(() => store.handleNotificationCreate('source'), SOURCE_ACCOUNT);
		expect(store.handleGatewayReady).not.toHaveBeenCalled();
		expect(store.handleNotificationCreate).not.toHaveBeenCalled();
	});

	it('never applies a source instance READY/push to the same user on the target instance', async () => {
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
			await handleFeedNotificationReady(empty, 'me', SOURCE_ACCOUNT);
			afterFeedNotificationReady(() => store.handleNotificationCreate('source'), SOURCE_ACCOUNT);
			await handleFeedNotificationReady({...empty, unread_count: 4}, 'me', TARGET_ACCOUNT);
			afterFeedNotificationReady(() => store.handleNotificationCreate('target'), TARGET_ACCOUNT);
		});
		expect(store.handleGatewayReady).toHaveBeenCalledTimes(1);
		expect(store.handleGatewayReady).toHaveBeenCalledWith({...empty, unread_count: 4}, 'me');
		expect(store.handleNotificationCreate.mock.calls).toEqual([['target']]);
	});

	it('does not replay deferred target state after a rollback to the source instance', async () => {
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
			await handleFeedNotificationReady(empty, 'me', TARGET_ACCOUNT);
			afterFeedNotificationReady(() => store.handleNotificationCreate('target'), TARGET_ACCOUNT);
			storageScope.value = SOURCE_ACCOUNT;
		});
		expect(store.handleGatewayReady).not.toHaveBeenCalled();
		expect(store.handleNotificationCreate).not.toHaveBeenCalled();
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
		});
		expect(store.handleGatewayReady).not.toHaveBeenCalled();
		expect(store.handleNotificationCreate).not.toHaveBeenCalled();
	});

	it('sends the target saved cursor after deferred READY and cancels it on another instance switch', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		store.lastReadAt = 1000;
		store.lastReadUserId = 'me';
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = TARGET_ACCOUNT;
			await handleFeedNotificationReady(empty, 'me', TARGET_ACCOUNT);
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(commands.sendReadCursor).toHaveBeenCalledWith(1000, 0, 0);
		commands.sendReadCursor.mockReset();
		await handleFeedNotificationReady(empty, 'me', TARGET_ACCOUNT);
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
			storageScope.value = SOURCE_ACCOUNT;
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
	});

	it.each(['ready', 'push'] as const)('drops %s arriving while account work is suspended', async (event) => {
		let hydrated = () => {};
		hydration.promise = new Promise<void>((resolve) => {
			hydrated = resolve;
		});
		const oldReady = handleFeedNotificationReady(empty, 'me');
		try {
			await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
				storageScope.value = TARGET_ACCOUNT;
				if (event === 'ready')
					await expect(handleFeedNotificationReady(empty, 'me', SOURCE_ACCOUNT)).resolves.toBeUndefined();
				else
					expect(() =>
						afterFeedNotificationReady(() => store.handleNotificationCreate('push'), SOURCE_ACCOUNT),
					).not.toThrow();
			});
			expect(store.handleGatewayReady).not.toHaveBeenCalled();
			expect(store.handleNotificationCreate).not.toHaveBeenCalled();
		} finally {
			hydrated();
			await oldReady;
			hydration.promise = Promise.resolve();
		}
	});

	it('drops an old READY and its held push after an instance switch during hydration', async () => {
		let hydrated = () => {};
		hydration.promise = new Promise<void>((resolve) => {
			hydrated = resolve;
		});
		const ready = handleFeedNotificationReady(empty, 'me');
		afterFeedNotificationReady(() => store.handleNotificationCreate('old'));
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {});
		hydrated();
		await ready;
		expect(store.handleGatewayReady).not.toHaveBeenCalled();
		expect(store.handleNotificationCreate).not.toHaveBeenCalled();
		hydration.promise = Promise.resolve();
	});

	it('keeps the new instance held push when an older READY finishes hydrating last', async () => {
		let hydrated = () => {};
		hydration.promise = new Promise<void>((resolve) => {
			hydrated = resolve;
		});
		const oldReady = handleFeedNotificationReady(empty, 'me');
		afterFeedNotificationReady(() => store.handleNotificationCreate('old'));
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {});
		hydration.promise = Promise.resolve();
		await handleFeedNotificationReady(empty, 'me');
		afterFeedNotificationReady(() => store.handleNotificationCreate('new'));
		hydrated();
		await oldReady;
		expect(store.handleGatewayReady).toHaveBeenCalledTimes(1);
		expect(store.handleNotificationCreate.mock.calls).toEqual([['new']]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		commands.sendReadCursor.mockReset();
	});

	it("sends this account's device read time once the server has no cursor, within a minute (kapı S2, O6, C2-T4)", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		store.lastReadAt = 1_000;
		store.lastReadUserId = 'other';
		await handleFeedNotificationReady(empty, 'me');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
		store.lastReadUserId = 'me';
		await handleFeedNotificationReady({...empty, last_read_at: '2027-01-01T00:00:00.000Z'}, 'me');
		await handleFeedNotificationReady(undefined, 'me');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
		await handleFeedNotificationReady(empty, 'me');
		await vi.advanceTimersByTimeAsync(29_999);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(commands.sendReadCursor).toHaveBeenCalledWith(1_000, 0, 0);
		expect(store.handleGatewayReady).toHaveBeenCalledWith(empty, 'me');
	});

	it('binds a read time saved before owners were kept to the first account, and drops it if the account changes before sending (O6, C2-T5)', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		store.lastReadAt = 1_000;
		store.lastReadUserId = null;
		await handleFeedNotificationReady(empty, 'me');
		store.lastReadUserId = 'me';
		await vi.advanceTimersByTimeAsync(1);
		expect(commands.sendReadCursor).toHaveBeenCalledWith(1_000, 0, 0);
		commands.sendReadCursor.mockReset();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		await handleFeedNotificationReady(empty, 'me');
		store.lastReadUserId = 'someone-else';
		await vi.advanceTimersByTimeAsync(60_000);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
	});

	it('does not send the old instance cursor when the same user switches instances during the spread', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		store.lastReadAt = 1000;
		store.lastReadUserId = 'me';
		await handleFeedNotificationReady(empty, 'me');
		await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(commands.sendReadCursor).not.toHaveBeenCalled();
	});

	it('passes the unread sequence of a push and applies an ack event (C2-T6)', () => {
		const push = {
			id: '1',
			type: 'post_like' as const,
			post_id: '2',
			comment_id: null,
			actors: [],
			actor_count: 1,
			updated_at: '2027-01-01T00:00:00.000Z',
			unread_seq: 4,
			unread_epoch: 9,
		};
		handleFeedNotificationCreate(push, {} as never);
		expect(store.handleNotificationCreate).toHaveBeenCalledWith(push, 4, 9);
		const ack = {last_read_at: '2027-01-01T00:00:00.000Z', unread_seq: 4, unread_epoch: 9};
		handleFeedNotificationAck(ack, {} as never);
		expect(store.handleAck).toHaveBeenCalledWith(ack);
	});

	it('applies the pushes and reads that come while READY waits for the saved state after it, in order (D7)', async () => {
		let hydrated = () => {};
		hydration.promise = new Promise<void>((resolve) => {
			hydrated = resolve;
		});
		const order: Array<string> = [];
		store.handleGatewayReady.mockImplementation(() => order.push('ready'));
		store.handleNotificationCreate.mockImplementation(() => order.push('push'));
		store.handleAck.mockImplementation(() => order.push('ack'));
		const ready = handleFeedNotificationReady({...empty, last_read_at: '2027-01-01T00:00:00.000Z'}, 'me');
		const push = {
			id: '1',
			type: 'post_like' as const,
			post_id: '2',
			comment_id: null,
			actors: [],
			actor_count: 1,
			updated_at: '2027-01-01T00:00:00.000Z',
			unread_seq: 1,
			unread_epoch: 9,
		};
		handleFeedNotificationCreate(push, {} as never);
		handleFeedNotificationAck({last_read_at: push.updated_at, unread_seq: 1, unread_epoch: 9}, {} as never);
		expect(order).toEqual([]);
		hydrated();
		await ready;
		expect(order).toEqual(['ready', 'push', 'ack']);
		// After READY, events apply at once.
		handleFeedNotificationCreate(push, {} as never);
		expect(order.at(-1)).toBe('push');
		hydration.promise = Promise.resolve();
	});

	it('applies READY and what waited for it even when the saved state could not be read (D7)', async () => {
		hydration.promise = Promise.reject(new Error('storage'));
		store.handleGatewayReady.mockClear();
		await handleFeedNotificationReady({...empty, last_read_at: '2027-01-01T00:00:00.000Z'}, 'me');
		expect(store.handleGatewayReady).toHaveBeenCalledTimes(1);
		hydration.promise = Promise.resolve();
	});
});
