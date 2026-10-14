// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DAYS_HOURS_LEFT_DESCRIPTOR,
	HOURS_MINUTES_LEFT_DESCRIPTOR,
	LESS_THAN_A_MINUTE_LEFT_DESCRIPTOR,
	MINUTES_LEFT_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import type {I18n} from '@lingui/core';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// A campaign's time left, as ShopCountdown and the shop hero write it: "2d 4h left", "3h 12m left", "12m left", then
// "Less than a minute left".
export function formatTimeLeft(leftMs: number, i18n: I18n): string {
	const days = Math.floor(leftMs / DAY_MS);
	const hours = Math.floor((leftMs % DAY_MS) / HOUR_MS);
	const minutes = Math.floor((leftMs % HOUR_MS) / MINUTE_MS);
	if (days > 0) return i18n._(DAYS_HOURS_LEFT_DESCRIPTOR, {days, hours});
	if (hours > 0) return i18n._(HOURS_MINUTES_LEFT_DESCRIPTOR, {hours, minutes});
	if (minutes > 0) return i18n._(MINUTES_LEFT_DESCRIPTOR, {minutes});
	return i18n._(LESS_THAN_A_MINUTE_LEFT_DESCRIPTOR);
}
