// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {
	ForegroundPromoteCoordinator,
	type ForegroundPromoteHost,
} from '@app/features/gateway/transport/ForegroundPromoteCoordinator';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import type {
	FeedCommentResponse,
	FeedNotificationResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const storageScope = vi.hoisted(() => ({value: 'https://first.test/api::me'}));
vi.mock('@app/features/platform/state/PersistentStorage', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/platform/state/PersistentStorage')>()),
	getAppStorageScope: () => storageScope.value,
}));

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn()},
}));

const {AccountScopedWork, AccountScopedWorkTransitionReason} = await import(
	'@app/features/platform/state/AccountScopedWork'
);
const {http} = await import('@app/features/platform/transport/RestTransport');
const FeedNotificationCommands = await import('@app/features/inbox/commands/FeedNotificationCommands');
const {default: FeedNotifications, FEED_NOTIFICATION_PAGE_SIZE} = await import(
	'@app/features/inbox/state/FeedNotifications'
);
const {default: FeedTimeline} = await import('@app/features/feed/state/FeedTimeline');

const wireUser = (id: string) => ({
	id,
	username: `user${id}`,
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
});

function wireNotification(id: number): FeedNotificationResponse {
	return {
		id: String(id),
		type: 'post_like',
		post_id: '500',
		comment_id: null,
		actors: [wireUser('7')],
		actor_count: 1,
		updated_at: '2030-01-01T00:00:00.000Z',
	};
}

function wirePost(id: string): FeedPostResponse {
	return {
		id,
		author: wireUser('1'),
		content: 'hello',
		attachments: [],
		edited_at: null,
		like_count: 3,
		comment_count: 1,
		liked: false,
	};
}

function reply<T>(body: T, status = 200): RestResponse<T> {
	return {ok: status < 300, status, statusText: '', headers: {}, body};
}

const ids = () => FeedNotifications.notifications.map((notification) => notification.id);

function failedPromotion(error: Error): ForegroundPromoteCoordinator {
	const unexpectedStep = (): never => {
		throw new Error('Unexpected promotion step after begin failure');
	};
	const host: ForegroundPromoteHost = {
		findWarmCandidate: () => {
			throw error;
		},
		prepareForegroundSnapshot: unexpectedStep,
		hydrateForegroundSnapshot: unexpectedStep,
		commitForegroundSnapshot: unexpectedStep,
		abortForegroundSnapshot: unexpectedStep,
		finalizeForegroundSnapshot: unexpectedStep,
		stopBackgroundConnection: unexpectedStep,
		prepareForegroundReplay: unexpectedStep,
		adoptForegroundSocket: unexpectedStep,
		replayForegroundDispatch: unexpectedStep,
		finalizeForeground: unexpectedStep,
		removeBackgroundConnection: unexpectedStep,
		discardDetachedSocket: unexpectedStep,
		discardForegroundConnection: unexpectedStep,
	};
	return new ForegroundPromoteCoordinator(host);
}

function abortPendingRead(): void {
	vi.mocked(http.post).mockImplementationOnce(
		(_path, options) =>
			new Promise((_resolve, reject) => {
				const signal = options?.signal;
				if (!signal) throw new Error('Pending read must carry its account cancellation signal');
				signal.addEventListener('abort', () => reject(signal.reason), {once: true});
			}) as never,
	);
}

describe('FeedNotificationCommands', () => {
	beforeEach(() => {
		vi.mocked(http.get).mockReset();
		FeedNotifications.reset();
		FeedNotifications.handleGatewayReady();
		FeedTimeline.reset();
	});

	it('loads the newest page, then pages back with the oldest loaded id until a page comes back empty', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply([wireNotification(9), wireNotification(8)]))
			.mockResolvedValueOnce(reply([wireNotification(5)]))
			.mockResolvedValueOnce(reply([]));

		await FeedNotificationCommands.refresh();
		await FeedNotificationCommands.loadMore();
		await FeedNotificationCommands.loadMore();
		await FeedNotificationCommands.loadMore();

		expect(vi.mocked(http.get).mock.calls).toEqual([
			[Endpoints.FEED_NOTIFICATIONS, {query: {limit: FEED_NOTIFICATION_PAGE_SIZE}}],
			[Endpoints.FEED_NOTIFICATIONS, {query: {limit: FEED_NOTIFICATION_PAGE_SIZE, before: '8'}}],
			[Endpoints.FEED_NOTIFICATIONS, {query: {limit: FEED_NOTIFICATION_PAGE_SIZE, before: '5'}}],
		]);
		expect(ids()).toEqual(['9', '8', '5']);
	});

	it('does not page back before the first page is in', async () => {
		await FeedNotificationCommands.loadMore();
		expect(http.get).not.toHaveBeenCalled();
	});

	it('stops paging on a failure until the user retries', async () => {
		vi.mocked(http.get)
			.mockRejectedValueOnce(new HttpError({method: 'GET', path: '/feed/notifications', status: 500}))
			.mockResolvedValueOnce(reply([wireNotification(3)]));
		await FeedNotificationCommands.refresh();
		expect(FeedNotifications.failed).toBe(true);
		await FeedNotificationCommands.loadMore();
		expect(http.get).toHaveBeenCalledTimes(1);
		await FeedNotificationCommands.retry();
		expect(vi.mocked(http.get).mock.calls[1]).toEqual([
			Endpoints.FEED_NOTIFICATIONS,
			{query: {limit: FEED_NOTIFICATION_PAGE_SIZE}},
		]);
		expect(ids()).toEqual(['3']);
		expect(FeedNotifications.failed).toBe(false);
	});

	it('loads the post a notification points at into its own timeline', async () => {
		const key = FeedNotificationCommands.feedPostTimelineKey('500');
		vi.mocked(http.get).mockResolvedValueOnce(reply(wirePost('500')));
		FeedTimeline.open(key);
		await FeedNotificationCommands.loadPost('500', false);
		expect(vi.mocked(http.get).mock.calls).toEqual([[Endpoints.FEED_POST('500')]]);
		expect(FeedTimeline.getTimeline(key)!.posts.map((post) => post.id)).toEqual(['500']);
		expect(FeedTimeline.getThread('500')).toBeNull();
	});

	it('opens the comments of the post for a comment notification', async () => {
		const key = FeedNotificationCommands.feedPostTimelineKey('500');
		const comment: FeedCommentResponse = {
			id: '600',
			post_id: '500',
			author: wireUser('7'),
			content: 'nice',
			edited_at: null,
		};
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(wirePost('500')))
			.mockResolvedValueOnce(reply([comment]));
		FeedTimeline.open(key);
		await FeedNotificationCommands.loadPost('500', true);
		expect(vi.mocked(http.get).mock.calls[1]?.[0]).toBe(Endpoints.FEED_POST_COMMENTS('500'));
		expect(FeedTimeline.getThread('500')!.comments.map((entry) => entry.id)).toEqual(['600']);
	});

	it('marks the post timeline failed when the post is gone', async () => {
		const key = FeedNotificationCommands.feedPostTimelineKey('500');
		vi.mocked(http.get).mockRejectedValueOnce(new HttpError({method: 'GET', path: '/feed/posts/500', status: 404}));
		FeedTimeline.open(key);
		await FeedNotificationCommands.loadPost('500', true);
		expect(FeedTimeline.getTimeline(key)!.failure).not.toBeNull();
		expect(FeedTimeline.getThread('500')).toBeNull();
		expect(http.get).toHaveBeenCalledTimes(1);
	});

	describe('markRead (2a.9b)', () => {
		let accounts = 0;
		beforeEach(() => {
			// Cursor first: with a device time and no server cursor READY would leave the session counting on the device.
			// Each test is a new account, so no read of the previous test carries over.
			FeedNotifications.lastReadAt = 0;
			const userId = `me-${++accounts}`;
			storageScope.value = `https://first.test/api::${userId}`;
			FeedNotifications.handleGatewayReady(
				{last_read_at: null, unread_count: 1, unread_seq: 1, unread_epoch: 7},
				userId,
			);
			vi.mocked(http.post).mockReset();
		});

		it.each(['ack', 'failure'] as const)(
			'drops a pending %s after switching instances of the same user',
			async (result) => {
				let settle = (_value: unknown) => {};
				let fail = (_error: Error) => {};
				vi.mocked(http.post).mockImplementationOnce(
					() =>
						new Promise((resolve, reject) => {
							settle = resolve;
							fail = reject;
						}) as never,
				);
				const request = FeedNotificationCommands.sendReadCursor(1000, 1, 7);
				const switching = AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
					storageScope.value = `https://second.test/api::${FeedNotifications.lastReadUserId}`;
					FeedNotifications.reset();
					FeedNotifications.lastReadAt = 0;
				});
				if (result === 'ack') settle(reply({last_read_at: '2030-01-01T00:00:00.000Z', unread_seq: 1, unread_epoch: 7}));
				else fail(new Error('offline'));
				await request;
				await switching;
				FeedNotifications.handleGatewayReady(undefined, FeedNotifications.lastReadUserId!);
				expect(FeedNotifications.lastReadAt).toBe(0);
				expect(FeedNotifications.closeView()).toBeNull();
			},
		);

		it('retries a consumed pending read when cancellation precedes an early promotion failure', async () => {
			FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
			FeedNotifications.openView();
			abortPendingRead();
			const request = FeedNotificationCommands.markRead();
			const failure = new Error('begin promotion failed');
			const coordinator = failedPromotion(failure);
			await expect(
				AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
					await coordinator.begin(`https://second.test/api::${FeedNotifications.lastReadUserId}`);
				}),
			).rejects.toBe(failure);
			await expect(request).resolves.toBeUndefined();
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({last_read_at: wireNotification(1).updated_at, unread_seq: 1, unread_epoch: 7}) as never,
			);
			FeedNotifications.openView();
			await FeedNotificationCommands.markRead();
			expect(http.post).toHaveBeenCalledTimes(2);
			expect(vi.mocked(http.post).mock.calls[1]?.[1]?.body).toEqual({
				read_at: wireNotification(1).updated_at,
				unread_seq: 1,
				unread_epoch: 7,
			});
		});

		it('resolves a view cleanup during suspension and retries after an early failed switch', async () => {
			FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
			FeedNotifications.openView();
			const failure = new Error('begin promotion failed');
			const coordinator = failedPromotion(failure);
			await expect(
				AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
					await expect(FeedNotificationCommands.markRead()).resolves.toBeUndefined();
					expect(http.post).not.toHaveBeenCalled();
					await coordinator.begin(`https://second.test/api::${FeedNotifications.lastReadUserId}`);
				}),
			).rejects.toBe(failure);
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({last_read_at: wireNotification(1).updated_at, unread_seq: 1, unread_epoch: 7}) as never,
			);
			FeedNotifications.openView();
			await FeedNotificationCommands.markRead();
			expect(http.post).toHaveBeenCalledTimes(1);
		});

		it.each(['foreign-instance', 'logout'] as const)(
			'clears a cancelled source read on successful %s rehydration',
			async (destination) => {
				FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
				FeedNotifications.openView();
				const userId = FeedNotifications.lastReadUserId!;
				abortPendingRead();
				const request = FeedNotificationCommands.markRead();
				await AccountScopedWork.runSuspended(
					destination === 'logout'
						? AccountScopedWorkTransitionReason.LOGOUT
						: AccountScopedWorkTransitionReason.ACCOUNT_SWITCH,
					async () => {
						storageScope.value = destination === 'logout' ? '@global' : `https://second.test/api::${userId}`;
						FeedNotifications.reset();
						FeedNotifications.lastReadAt = 0;
						FeedNotifications.lastReadUserId = destination === 'logout' ? null : userId;
					},
				);
				await expect(request).resolves.toBeUndefined();
				expect(FeedNotifications.closeView()).toBeNull();
				expect(FeedNotifications.lastReadAt).toBe(0);
				expect(http.post).toHaveBeenCalledTimes(1);
			},
		);

		it('does not recreate an acknowledged retry when a later switch fails early', async () => {
			FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
			FeedNotifications.openView();
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({last_read_at: wireNotification(1).updated_at, unread_seq: 1, unread_epoch: 7}) as never,
			);
			await FeedNotificationCommands.markRead();
			const failure = new Error('begin promotion failed');
			await expect(
				AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
					await failedPromotion(failure).begin(`https://second.test/api::${FeedNotifications.lastReadUserId}`);
				}),
			).rejects.toBe(failure);
			FeedNotifications.openView();
			await FeedNotificationCommands.markRead();
			expect(http.post).toHaveBeenCalledTimes(1);
		});

		it('sends nothing when the view showed nothing (C2-T1)', async () => {
			FeedNotifications.openView();
			await FeedNotificationCommands.markRead();
			expect(http.post).not.toHaveBeenCalled();
			expect(FeedNotifications.unreadCount).toBe(1);
		});

		it('sends the read time and the seen sequence and applies the answer (C2-T2)', async () => {
			FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
			FeedNotifications.openView();
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({last_read_at: '2030-01-01T00:00:00.000Z', unread_seq: 1, unread_epoch: 7}) as never,
			);
			await FeedNotificationCommands.markRead();
			expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_NOTIFICATIONS_ACK, {
				body: {read_at: '2030-01-01T00:00:00.000Z', unread_seq: 1, unread_epoch: 7},
				signal: expect.any(AbortSignal),
			});
			expect(FeedNotifications.unreadCount).toBe(0);
		});

		it('keeps the state and does not throw when the request fails (C2-T3)', async () => {
			vi.mocked(http.post).mockRejectedValueOnce(new Error('offline'));
			await expect(FeedNotificationCommands.sendReadCursor(1_000, 0, 0)).resolves.toBeUndefined();
		});

		it('sends a read that failed, offline or rate limited, again on the next close (D5)', async () => {
			FeedNotifications.handleNotificationCreate(wireNotification(1), 1);
			const body = {read_at: '2030-01-01T00:00:00.000Z', unread_seq: 1, unread_epoch: 7};
			vi.mocked(http.post)
				.mockRejectedValueOnce(new Error('offline'))
				.mockRejectedValueOnce(new HttpError({method: 'POST', path: '/feed/notifications/ack', status: 429}))
				.mockResolvedValueOnce(reply({last_read_at: body.read_at, unread_seq: 1, unread_epoch: 7}) as never);
			for (let close = 0; close < 4; close++) {
				FeedNotifications.openView();
				await FeedNotificationCommands.markRead();
			}
			expect(vi.mocked(http.post).mock.calls).toEqual([
				[Endpoints.FEED_NOTIFICATIONS_ACK, {body, signal: expect.any(AbortSignal)}],
				[Endpoints.FEED_NOTIFICATIONS_ACK, {body, signal: expect.any(AbortSignal)}],
				[Endpoints.FEED_NOTIFICATIONS_ACK, {body, signal: expect.any(AbortSignal)}],
			]);
		});

		it("reads up to the list's server time from its Date header, not the device clock (D6)", async () => {
			const deviceClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2031-01-01T00:00:00.000Z'));
			vi.mocked(http.get).mockResolvedValueOnce({
				...reply([]),
				headers: {date: 'Tue, 01 Jan 2030 12:00:00 GMT'},
			});
			await FeedNotificationCommands.refresh();
			FeedNotifications.openView();
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({last_read_at: '2030-01-01T12:00:00.000Z', unread_seq: 1, unread_epoch: 7}) as never,
			);
			await FeedNotificationCommands.markRead();
			expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_NOTIFICATIONS_ACK, {
				body: {read_at: '2030-01-01T12:00:00.000Z', unread_seq: 1, unread_epoch: 7},
				signal: expect.any(AbortSignal),
			});
			deviceClock.mockRestore();
		});
	});
});
