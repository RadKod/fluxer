import {randomUUID} from 'node:crypto';
import {Logger} from '@app/api/Logger';
import {parseJsonRecord} from '@app/api/utils/JsonBoundaryUtils';
import {RefreshSubscription, RefreshSubscriptionUnavailableError} from '@app/api/utils/RefreshSubscription';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const INSTANCE_CONFIG_MAX_AGE_MS = 5000;

interface InstanceConfigCacheOptions {
	provider: IKVProvider | null;
	channel: string;
	load: () => Promise<Map<string, string>>;
	onRefresh: (snapshot: ReadonlyMap<string, string>, loadedAt: number) => void;
}

export class InstanceConfigCache {
	readonly sourceId = randomUUID();
	private active = true;
	private snapshot: Map<string, string> | null = null;
	private writesDuringRefresh: Map<string, string> | null = null;
	private initialization: Promise<boolean> | null = null;
	private refreshCompletion: Promise<void> | null = null;
	private nextRefreshAt = 0;
	private refreshFailure: {error: unknown} | null = null;
	private shutdownCompletion: Promise<void> | null = null;
	private readonly subscription: RefreshSubscription;

	constructor(
		private readonly options: InstanceConfigCacheOptions,
		private readonly previousShutdown: Promise<void> = Promise.resolve(),
	) {
		this.subscription = new RefreshSubscription({
			name: 'InstanceConfigCache',
			channels: [options.channel],
			shouldRefresh: (_channel, message) => {
				const payload = parseJsonRecord(message);
				return (
					payload?.type !== 'application_invalidate' &&
					payload?.type !== 'application_refresh' &&
					payload?.source_id !== this.sourceId
				);
			},
			drainInitialNotifications: true,
			refresh: () => this.refresh(),
			onRefreshError: (error) => {
				Logger.error({error}, 'Failed to refresh instance config cache from pubsub');
			},
		});
	}

	assertActive(): void {
		if (!this.active) throw new Error('Instance config cache is shutting down or shut down');
	}

	async getSnapshot(): Promise<ReadonlyMap<string, string> | null> {
		this.assertActive();
		if (this.refreshFailure && this.refreshCompletion === null && Date.now() < this.nextRefreshAt) {
			throw this.refreshFailure.error;
		}
		if (!this.subscription.isReady) {
			this.initialization ??= this.initialize().finally(() => {
				this.initialization = null;
			});
			const cached = await this.initialization;
			this.assertActive();
			if (!cached) return null;
		}
		if (this.refreshCompletion) {
			await this.refreshCompletion;
		} else if (Date.now() >= this.nextRefreshAt) {
			await this.refresh();
		}
		this.assertActive();
		return this.snapshot;
	}

	private async initialize(): Promise<boolean> {
		await this.previousShutdown;
		this.assertActive();
		if (this.options.provider === null) return false;
		try {
			await this.subscription.start(this.options.provider);
			return true;
		} catch (error) {
			this.assertActive();
			if (!(error instanceof RefreshSubscriptionUnavailableError)) throw error;
			Logger.error({error}, 'Instance config subscription unavailable, reading directly from the database');
			return false;
		}
	}

	private refresh(): Promise<void> {
		this.assertActive();
		this.refreshCompletion ??= Promise.resolve()
			.then(() => this.loadSnapshot())
			.finally(() => {
				this.refreshCompletion = null;
			});
		return this.refreshCompletion;
	}

	private async loadSnapshot(): Promise<void> {
		this.assertActive();
		if (this.writesDuringRefresh !== null) throw new Error('Instance config refresh already in progress');
		const writes = new Map<string, string>();
		this.writesDuringRefresh = writes;
		const freshUntil = Date.now() + INSTANCE_CONFIG_MAX_AGE_MS;
		try {
			const snapshot = await this.options.load();
			if (!this.active) return;
			if (Date.now() >= freshUntil) throw new Error('Instance config refresh exceeded its freshness budget');
			for (const [key, value] of writes) snapshot.set(key, value);
			this.options.onRefresh(snapshot, freshUntil - INSTANCE_CONFIG_MAX_AGE_MS);
			if (Date.now() >= freshUntil) throw new Error('Instance config refresh exceeded its freshness budget');
			this.snapshot = snapshot;
			this.refreshFailure = null;
			this.nextRefreshAt = freshUntil;
		} catch (error) {
			this.snapshot = null;
			this.refreshFailure = {error};
			this.nextRefreshAt = Date.now() + INSTANCE_CONFIG_MAX_AGE_MS;
			throw error;
		} finally {
			this.writesDuringRefresh = null;
		}
	}

	update(key: string, value: string): void {
		if (!this.active) return;
		this.snapshot?.set(key, value);
		this.writesDuringRefresh?.set(key, value);
	}

	shutdown(): Promise<void> {
		if (this.shutdownCompletion) return this.shutdownCompletion;
		this.active = false;
		this.snapshot = null;
		this.shutdownCompletion = this.close();
		return this.shutdownCompletion;
	}

	private async close(): Promise<void> {
		const [subscription, previous] = await Promise.allSettled([
			this.subscription.stop(),
			this.previousShutdown,
			this.initialization,
			this.refreshCompletion,
		]);
		const errors: Array<unknown> = [subscription, previous].flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Failed to shut down instance config cache');
	}
}
