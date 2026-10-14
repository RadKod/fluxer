// SPDX-License-Identifier: AGPL-3.0-or-later

import {TASKBAR_PIN_STORAGE_KEY} from '@app/features/platform/state/PersistentStorage';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {getElectronAPI, isNativeWindows} from '@app/features/ui/utils/NativeUtils';
import {makeAutoObservable, runInAction} from 'mobx';

const logger = new Logger('TaskbarPin');

export class TaskbarPin {
	dismissed = false;
	isHydrated = false;
	busy = false;
	attempted = false;
	nagbarRefreshed = false;
	state: {supported: boolean; pinned: boolean; lafRequired: boolean} | null = null;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, TASKBAR_PIN_STORAGE_KEY, ['dismissed'], {writeDelayMs: 0}).then(() => {
			runInAction(() => {
				this.isHydrated = true;
			});
		});
	}

	get canPin(): boolean {
		const api = getElectronAPI();
		return (
			!this.attempted &&
			isNativeWindows() &&
			Boolean(api?.getTaskbarPinState && api.requestTaskbarPin) &&
			Boolean(this.state?.supported && !this.state.pinned && !this.state.lafRequired)
		);
	}

	get canOffer(): boolean {
		return this.isHydrated && !this.dismissed && this.canPin;
	}

	dismiss(): void {
		this.dismissed = true;
	}

	async refresh(): Promise<void> {
		const api = getElectronAPI();
		if (!isNativeWindows() || !api?.getTaskbarPinState || !api.requestTaskbarPin) return;
		try {
			const state = await api.getTaskbarPinState();
			runInAction(() => {
				this.state = state;
			});
		} catch (error) {
			runInAction(() => {
				this.state = null;
			});
			logger.warn('Unable to read taskbar pin state', error);
		}
	}

	async requestPin(): Promise<boolean> {
		if (!this.canPin || this.busy) return false;
		this.busy = true;
		try {
			const pinned = await getElectronAPI()!.requestTaskbarPin!();
			runInAction(() => {
				this.dismiss();
				this.attempted = true;
				if (this.state) this.state.pinned = pinned;
			});
			return pinned;
		} catch (error) {
			logger.warn('Unable to request taskbar pinning', error);
			return false;
		} finally {
			runInAction(() => {
				this.busy = false;
			});
		}
	}
}

export default new TaskbarPin();
