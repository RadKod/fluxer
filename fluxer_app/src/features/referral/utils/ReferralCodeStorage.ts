// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {isReferralCodeShape} from '@fluxer/schema/src/domains/referral/ReferralCode';

// A /r/<code> visit stores the code here until the visitor registers; 30 days is how long a link click stays valid.
const STORAGE_KEY = 'referralCode';
export const REFERRAL_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredReferralCode {
	code: string;
	at: number;
}

export function saveReferralCode(raw: string, now: number = Date.now()): boolean {
	const code = raw.toLowerCase();
	// The shape the server generates: a check keeps junk out of the request body.
	if (!isReferralCodeShape(code)) return false;
	AppStorage.setItem(STORAGE_KEY, JSON.stringify({code, at: now} satisfies StoredReferralCode));
	return true;
}

export function readReferralCode(now: number = Date.now()): string | null {
	let stored: Partial<StoredReferralCode> | null = null;
	try {
		stored = JSON.parse(AppStorage.getItem(STORAGE_KEY) ?? 'null');
	} catch {
		stored = null;
	}
	if (
		stored &&
		typeof stored.code === 'string' &&
		typeof stored.at === 'number' &&
		isReferralCodeShape(stored.code) &&
		now >= stored.at &&
		now - stored.at < REFERRAL_CODE_TTL_MS
	) {
		return stored.code;
	}
	clearReferralCode();
	return null;
}

export function clearReferralCode(): void {
	AppStorage.removeItem(STORAGE_KEY);
}
