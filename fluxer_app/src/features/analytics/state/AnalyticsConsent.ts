// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {makeAutoObservable} from 'mobx';

// Bump when the banner text or what is collected changes: every earlier answer is asked again (KVKK consent is
// tied to the text it was given for).
export const ANALYTICS_CONSENT_VERSION = 1;
// Survives logout (AuthSession keeps it): the choice belongs to the device, not to the account.
export const ANALYTICS_CONSENT_STORAGE_KEY = 'analytics_consent';
const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export type AnalyticsChoice = 'granted' | 'denied';

interface StoredAnalyticsConsent {
	version: number;
	choice: AnalyticsChoice;
}

function readChoice(): AnalyticsChoice | null {
	const stored = AppStorage.getJSON<Partial<StoredAnalyticsConsent>>(ANALYTICS_CONSENT_STORAGE_KEY);
	if (stored?.version !== ANALYTICS_CONSENT_VERSION) return null;
	return stored.choice === 'granted' || stored.choice === 'denied' ? stored.choice : null;
}

let followingOtherTabs = false;

// Nothing is read or stored until a valid measurement id arrives, so a build without analytics never touches it.
class AnalyticsConsent {
	measurementId: string | null = null;
	choice: AnalyticsChoice | null = null;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	get isAvailable(): boolean {
		return this.measurementId !== null;
	}

	get shouldAsk(): boolean {
		return this.isAvailable && this.choice === null;
	}

	get isGranted(): boolean {
		return this.isAvailable && this.choice === 'granted';
	}

	configure(measurementId: string | null | undefined): string | null {
		this.measurementId = measurementId && GA4_MEASUREMENT_ID.test(measurementId) ? measurementId : null;
		if (this.measurementId) {
			this.reloadChoice();
			if (!followingOtherTabs) {
				followingOtherTabs = true;
				AppStorage.subscribe(this.reloadChoice, {key: ANALYTICS_CONSENT_STORAGE_KEY, source: 'external'});
			}
		}
		return this.measurementId;
	}

	setChoice(choice: AnalyticsChoice): void {
		if (!this.isAvailable) return;
		this.choice = choice;
		AppStorage.setJSON<StoredAnalyticsConsent>(ANALYTICS_CONSENT_STORAGE_KEY, {
			version: ANALYTICS_CONSENT_VERSION,
			choice,
		});
	}

	clearChoice(): void {
		if (!this.isAvailable) return;
		this.choice = null;
		AppStorage.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
	}

	reloadChoice(): void {
		this.choice = readChoice();
	}
}

export default new AnalyticsConsent();
