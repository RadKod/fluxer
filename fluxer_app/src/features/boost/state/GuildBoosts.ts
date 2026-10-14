// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import * as GuildBoostCommands from '@app/features/boost/commands/GuildBoostCommands';
import {type GuildBoostStatus, getGuildBoostStatus} from '@app/features/boost/utils/GuildBoostLevels';
import Guilds from '@app/features/guild/state/Guilds';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import type {GuildBoostResponse, UserBoostSlotResponse} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

// Holds one page of one community: a community with a million members never fills memory, and going back re-fetches
// the earlier cursor instead of keeping old pages.
class GuildBoosts {
	guildId: string | null = null;
	status: GuildBoostStatus | null = null;
	page: ReadonlyArray<GuildBoostResponse> = [];
	slots: ReadonlyArray<UserBoostSlotResponse> = [];
	hasMore = false;
	ready = false;
	loading = false;
	failed = false;
	private cursors: Array<string | undefined> = [];
	private statusGeneration = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	get hasPrevious(): boolean {
		return this.cursors.length > 1;
	}

	get hasFreeSlot(): boolean {
		return this.slots.some((slot) => slot.guild_id === null);
	}

	get ownBoostIds(): Array<string> {
		return this.slots.flatMap((slot) => (slot.guild_id === this.guildId && slot.boost_id ? [slot.boost_id] : []));
	}

	async open(guildId: string): Promise<void> {
		if (AccountScopedWork.isSuspended) return;
		this.close();
		this.guildId = guildId;
		const generation = this.statusGeneration;
		await Promise.all([this.loadPage([undefined]), this.loadSlots(), this.loadStatus()]);
		runInAction(() => {
			if (this.guildId === guildId && this.statusGeneration === generation) this.ready = true;
		});
	}

	close(): void {
		this.statusGeneration++;
		this.guildId = null;
		this.status = null;
		this.page = [];
		this.slots = [];
		this.cursors = [];
		this.hasMore = false;
		this.ready = false;
		this.loading = false;
		this.failed = false;
	}

	async nextPage(): Promise<void> {
		const last = this.page.at(-1);
		if (!this.hasMore || !last) return;
		await this.loadPage([...this.cursors, last.id]);
	}

	async previousPage(): Promise<void> {
		if (!this.hasPrevious) return;
		await this.loadPage(this.cursors.slice(0, -1));
	}

	async boost(): Promise<void> {
		const guildId = this.guildId;
		const generation = this.statusGeneration;
		if (!guildId) return;
		const sent = await GuildBoostCommands.boostGuild(guildId, this.slots);
		if (sent && this.guildId === guildId && this.statusGeneration === generation) await this.open(guildId);
	}

	async removeBoost(boostId: string): Promise<void> {
		const guildId = this.guildId;
		const generation = this.statusGeneration;
		if (!guildId) return;
		await GuildBoostCommands.removeGuildBoost(guildId, boostId);
		if (this.guildId === guildId && this.statusGeneration === generation) await this.open(guildId);
	}

	// `cursors` is the before-cursor stack once this page is shown; the last entry is the page to fetch.
	private async loadPage(cursors: Array<string | undefined>): Promise<void> {
		const guildId = this.guildId;
		const generation = this.statusGeneration;
		if (!guildId) return;
		this.loading = true;
		try {
			const boosts = await GuildBoostCommands.fetchGuildBoosts(guildId, cursors.at(-1));
			runInAction(() => {
				if (this.guildId !== guildId || this.statusGeneration !== generation) return;
				this.cursors = cursors;
				this.page = boosts;
				this.hasMore = boosts.length === GuildBoostCommands.GUILD_BOOSTS_PAGE_SIZE;
			});
		} catch {
			runInAction(() => {
				if (this.guildId === guildId && this.statusGeneration === generation) this.failed = true;
			});
		} finally {
			runInAction(() => {
				if (this.statusGeneration === generation) this.loading = false;
			});
		}
	}

	private async loadStatus(): Promise<void> {
		const guildId = this.guildId;
		const generation = this.statusGeneration;
		if (!guildId) return;
		try {
			const counts = await GuildBoostCommands.fetchGuildBoostCount(guildId);
			runInAction(() => {
				if (this.guildId !== guildId || this.statusGeneration !== generation) return;
				this.status = getGuildBoostStatus(counts);
				// Count-only changes have no gateway event; keep the header's existing guild snapshot fresh.
				const guild = Guilds.getGuild(guildId);
				if (guild) {
					Guilds.handleGuildUpdate({
						...guild.toJSON(),
						premium_tier: counts.premiumTier ?? 0,
						premium_subscription_count: counts.premiumSubscriptionCount ?? 0,
					});
				}
			});
		} catch {
			runInAction(() => {
				if (this.guildId === guildId && this.statusGeneration === generation) this.failed = true;
			});
		}
	}

	private async loadSlots(): Promise<void> {
		const guildId = this.guildId;
		const generation = this.statusGeneration;
		try {
			const slots = await GuildBoostCommands.fetchBoostSlots();
			runInAction(() => {
				if (this.guildId === guildId && this.statusGeneration === generation) this.slots = slots;
			});
		} catch {
			runInAction(() => {
				if (this.guildId === guildId && this.statusGeneration === generation) this.failed = true;
			});
		}
	}
}

const guildBoosts = new GuildBoosts();
ResettableStates.register(guildBoosts, guildBoosts.close);
AccountScopedWork.registerCancellation(() => guildBoosts.close());

export default guildBoosts;
