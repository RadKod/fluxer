// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import * as CosmeticCommands from '@app/features/cosmetics/commands/CosmeticCommands';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import type {
	CosmeticItemResponse,
	UltraFront,
	UltraLayout,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {makeAutoObservable, observable} from 'mobx';

const BATCH_WINDOW_MS = 50;
const MAX_IDS_PER_REQUEST = 50;
// The cool-down Fluxer's image cache gives a failed image.
const FRONT_RETRY_MS = 60_000;

// Admin-set ultra decoration sizes, read by item ID: users carry only the item ID, so the gateway
// sends nothing more. Each ID is asked once per session; an ID the server does not answer, or a failed request, keeps
// the fixed sizes. The in-front images  come the same way.
class UltraLayouts {
	private readonly layouts = observable.map<string, UltraLayout | null>({}, {deep: false});
	private readonly fronts = observable.map<string, UltraFront | null>({}, {deep: false});
	private readonly failedAt = observable.map<string, number>({}, {deep: false});
	private generation = 0;
	private asked = new Set<string>();
	private queue: Array<string> = [];
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		makeAutoObservable<UltraLayouts, 'layouts' | 'fronts' | 'failedAt' | 'asked' | 'queue' | 'timer' | 'generation'>(
			this,
			{layouts: false, fronts: false, failedAt: false, asked: false, queue: false, timer: false, generation: false},
			{autoBind: true},
		);
	}

	layoutFor(itemId: string): UltraLayout | null {
		this.ask(itemId);
		return this.layouts.get(itemId) ?? null;
	}

	// undefined until the item is read: nothing draws yet ; null draws behind as before.
	frontFor(itemId: string): UltraFront | null | undefined {
		this.ask(itemId);
		const failedAt = this.failedAt.get(itemId);
		if (failedAt !== undefined && Date.now() - failedAt < FRONT_RETRY_MS) return null;
		return this.fronts.get(itemId);
	}

	// The in-front images failed to load: the item draws behind for a minute, then its next render tries the front
	// again. No timer, so a failing image never turns into a retry loop.
	frontFailed(itemId: string): void {
		this.failedAt.set(itemId, Date.now());
	}

	prime(items: ReadonlyArray<CosmeticItemResponse>): void {
		for (const item of items) {
			if (item.type !== 'avatar_ultra') continue;
			this.layouts.set(item.id, item.ultra_layout ?? null);
			this.fronts.set(item.id, item.ultra_front ?? null);
		}
	}

	// Called while rendering, so it only touches the unobserved queue; the answer lands later through settle.
	reset(): void {
		this.generation++;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.queue = [];
		this.asked.clear();
		this.layouts.clear();
		this.fronts.clear();
		this.failedAt.clear();
	}

	private ask(itemId: string): void {
		if (AccountScopedWork.isSuspended) return;
		if (this.fronts.has(itemId) || this.asked.has(itemId)) return;
		this.asked.add(itemId);
		this.queue.push(itemId);
		this.timer ??= setTimeout(this.flush, BATCH_WINDOW_MS);
	}

	// An ID the server leaves out, or a failed request, draws behind with the fixed sizes.
	private settle(ids: ReadonlyArray<string>, items: ReadonlyArray<CosmeticItemResponse>): void {
		this.prime(items);
		for (const id of ids) if (!this.fronts.has(id)) this.fronts.set(id, null);
	}

	private flush(): void {
		const generation = this.generation;
		const ids = this.queue;
		this.queue = [];
		this.timer = null;
		for (let start = 0; start < ids.length; start += MAX_IDS_PER_REQUEST) {
			const chunk = ids.slice(start, start + MAX_IDS_PER_REQUEST);
			CosmeticCommands.fetchItems(chunk).then(
				(items) => {
					if (generation === this.generation) this.settle(chunk, items);
				},
				() => {
					if (generation === this.generation) this.settle(chunk, []);
				},
			);
		}
	}
}

const ultraLayouts = new UltraLayouts();
ResettableStates.register(ultraLayouts, ultraLayouts.reset);
AccountScopedWork.registerCancellation(() => ultraLayouts.reset());

export default ultraLayouts;
