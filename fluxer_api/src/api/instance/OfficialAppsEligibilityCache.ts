// SPDX-License-Identifier: AGPL-3.0-or-later

import {createApplicationID} from '@app/api/BrandedTypes';
import {
	OFFICIAL_APP_ELIGIBILITY_LEASE_MS,
	officialAppEligibilityLeaseKey,
	officialAppMutationKey,
} from '@app/api/instance/OfficialAppsEligibilityConstants';
import {Logger} from '@app/api/Logger';
import {ApplicationRepository} from '@app/api/oauth/repositories/ApplicationRepository';
import {parseJsonRecord} from '@app/api/utils/JsonBoundaryUtils';
import {RefreshSubscription} from '@app/api/utils/RefreshSubscription';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export class OfficialAppsEligibilityCache {
	private eligible = new Set<string>();
	private candidates = new Set<string>();
	private validUntil = 0;
	private generation = 0;
	private healthy = true;
	private active = true;
	private initialization: Promise<void> | null = null;
	private retryTimer: NodeJS.Timeout | null = null;
	private reconnection: Promise<void> | null = null;
	private readonly subscription: RefreshSubscription;
	private readonly applications: ApplicationRepository;

	constructor(
		private readonly provider: IKVProvider | null,
		channel: string,
		private readonly loadCandidates: () => Promise<Array<string>>,
	) {
		this.applications = new ApplicationRepository(provider);
		this.subscription = new RefreshSubscription({
			name: 'OfficialAppsEligibilityCache',
			channels: [channel],
			drainInitialNotifications: true,
			periodicIntervalMs: () => 30000,
			shouldRefresh: (_channel, message) => {
				const payload = parseJsonRecord(message);
				return (
					(payload?.type !== 'application_invalidate' && payload?.type !== 'application_refresh') ||
					(typeof payload.application_id === 'string' && this.candidates.has(payload.application_id))
				);
			},
			onInvalidate: () => this.invalidate(),
			refresh: () => this.refresh(),
			onRefreshError: (error) => {
				this.invalidate();
				Logger.error({error}, 'Failed to refresh official app eligibility');
			},
			onSubscriptionError: (error) => {
				this.healthy = false;
				this.scheduleRetry();
				Logger.error({error}, 'Official app eligibility subscription failed; discovery fails closed during recovery');
			},
		});
	}

	private invalidate(): void {
		this.generation++;
		this.eligible.clear();
		this.validUntil = 0;
	}

	async getEligible(): Promise<ReadonlySet<string>> {
		this.initialization ??= this.initialize();
		await this.initialization;
		return this.getCachedEligible();
	}

	getCachedEligible(): ReadonlySet<string> {
		if (performance.now() >= this.validUntil) this.eligible.clear();
		return this.eligible;
	}

	private async initialize(): Promise<void> {
		if (!this.provider || !this.active) return;
		try {
			await this.subscription.stop();
			if (!this.active) return;
			this.healthy = true;
			await this.subscription.start(this.provider);
		} catch (error) {
			this.healthy = false;
			this.invalidate();
			this.scheduleRetry();
			Logger.error({error}, 'Official app eligibility unavailable; discovery fails closed during recovery');
		}
	}

	private scheduleRetry(): void {
		if (!this.active || this.retryTimer !== null) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.reconnection = this.initialize().finally(() => {
				this.reconnection = null;
			});
		}, 30000);
		this.retryTimer.unref();
	}

	private async refresh(): Promise<void> {
		if (!this.healthy || !this.active || !this.provider) return;
		this.invalidate();
		const generation = this.generation;
		const validUntil = performance.now() + OFFICIAL_APP_ELIGIBILITY_LEASE_MS;
		const candidates = [...new Set(await this.loadCandidates())].slice(0, 22);
		this.candidates = new Set(candidates);
		const eligible = await Promise.all(
			candidates.map(async (id) => {
				await this.provider!.setex(officialAppEligibilityLeaseKey(id), OFFICIAL_APP_ELIGIBILITY_LEASE_MS / 1000, '1');
				if (await this.provider!.get(officialAppMutationKey(id))) return null;
				const application = await this.applications.getApplication(createApplicationID(BigInt(id)));
				if (!application?.botIsPublic || application.botUserId === null) return null;
				return (await this.provider!.get(officialAppMutationKey(id))) ? null : id;
			}),
		);
		if (this.active && this.healthy && generation === this.generation && performance.now() < validUntil) {
			this.eligible = new Set(eligible.filter((id): id is string => id !== null));
			this.validUntil = validUntil;
		}
	}

	async shutdown(): Promise<void> {
		this.active = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.invalidate();
		await this.subscription.stop();
		await this.initialization;
		await this.reconnection;
	}
}
