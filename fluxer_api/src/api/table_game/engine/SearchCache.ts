// SPDX-License-Identifier: AGPL-3.0-or-later

// A small in-process LRU of move generations by position key: every request loads a fresh engine state
// from KV, so an object keyed cache never hits across requests. A Map keeps insertion order: a hit moves to the
// newest end, and past `size` the oldest goes. A computed value `keep` turns down is returned but never held.
export type SearchCache<V> = (key: string, compute: () => V) => V;

export function searchCache<V>(size: number, keep: (value: V) => boolean = () => true): SearchCache<V> {
	const entries = new Map<string, V>();
	return (key, compute) => {
		let value = entries.get(key);
		if (value === undefined) {
			value = compute();
			if (!keep(value)) return value;
		} else entries.delete(key);
		entries.set(key, value);
		if (entries.size > size) entries.delete(entries.keys().next().value!);
		return value;
	};
}
