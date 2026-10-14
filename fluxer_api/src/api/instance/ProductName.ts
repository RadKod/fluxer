// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';

let cachedProductName: string | null = null;

export function getDefaultProductName(): string {
	return Config.instance.branding.productName || 'sanalyer';
}

export function getInstanceProductName(): string {
	return cachedProductName ?? getDefaultProductName();
}

export function setCachedProductName(productName: string | null): void {
	cachedProductName = productName;
}
