// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';

export type HoverPreloadKind = 'channel' | 'profile' | 'guild-count';

interface PendingPreload {
	owner: object;
	dueAt: number;
	preload: () => void;
}

class HoverPreloadScheduler {
	// Each kind retains only the most recent hovered row, regardless of list size.
	private readonly pending = new Map<HoverPreloadKind, PendingPreload>();
	private timer: number | null = null;
	private timerDueAt: number | null = null;

	schedule(kind: HoverPreloadKind, owner: object, preload: () => void, delayMs: number): void {
		if (typeof window === 'undefined' || AccountScopedWork.isSuspended) return;
		this.pending.set(kind, {owner, preload, dueAt: Date.now() + delayMs});
		this.arm();
	}

	cancel(kind: HoverPreloadKind, owner: object): void {
		if (this.pending.get(kind)?.owner !== owner) return;
		this.pending.delete(kind);
		this.arm();
	}

	reset(): void {
		this.pending.clear();
		this.arm();
	}

	private arm(): void {
		const nextDueAt = this.pending.size > 0 ? Math.min(...Array.from(this.pending.values(), (job) => job.dueAt)) : null;
		if (nextDueAt === this.timerDueAt) return;
		if (this.timer != null) window.clearTimeout(this.timer);
		this.timer = null;
		this.timerDueAt = nextDueAt;
		if (nextDueAt == null) return;
		this.timer = window.setTimeout(
			() => {
				this.timer = null;
				this.timerDueAt = null;
				const now = Date.now();
				try {
					for (const [kind, job] of this.pending) {
						if (job.dueAt > now) continue;
						this.pending.delete(kind);
						job.preload();
					}
				} finally {
					this.arm();
				}
			},
			Math.max(0, nextDueAt - Date.now()),
		);
	}
}

const hoverPreloadScheduler = new HoverPreloadScheduler();
ResettableStates.register(hoverPreloadScheduler, () => hoverPreloadScheduler.reset());
AccountScopedWork.registerCancellation(() => hoverPreloadScheduler.reset());
export default hoverPreloadScheduler;
