// SPDX-License-Identifier: AGPL-3.0-or-later

export function getGameActivityElapsed(startedAt: number, now = Date.now()): number {
	return Math.max(0, now - startedAt);
}

export class GameActivityMinuteClock {
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private now = Date.now();

	subscribe = (listener: () => void): (() => void) => {
		const first = this.listeners.size === 0;
		this.listeners.add(listener);
		if (first) {
			this.now = Date.now();
			if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibilityChange);
			this.start();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.stop();
				if (typeof document !== 'undefined')
					document.removeEventListener('visibilitychange', this.handleVisibilityChange);
			}
		};
	};

	getSnapshot = (): number => this.now;

	private tick = (): void => {
		this.now = Date.now();
		for (const listener of this.listeners) listener();
	};

	private handleVisibilityChange = (): void => {
		if (document.hidden) {
			this.stop();
		} else if (this.listeners.size > 0 && this.timer === null) {
			this.tick();
			this.start();
		}
	};

	private start(): void {
		if (this.timer !== null || this.listeners.size === 0 || typeof document === 'undefined' || document.hidden) return;
		this.timer = setInterval(this.tick, 60_000);
	}

	private stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}

export default new GameActivityMinuteClock();
