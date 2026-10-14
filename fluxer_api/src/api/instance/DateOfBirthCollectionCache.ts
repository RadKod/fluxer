// SPDX-License-Identifier: AGPL-3.0-or-later

let cachedCollectDateOfBirth: boolean | null = null;

export function getDefaultDateOfBirthCollection(): boolean {
	return true;
}

export function instanceCollectsDateOfBirth(): boolean {
	return cachedCollectDateOfBirth ?? getDefaultDateOfBirthCollection();
}

export function setCachedDateOfBirthCollection(collect: boolean): void {
	cachedCollectDateOfBirth = collect;
}
