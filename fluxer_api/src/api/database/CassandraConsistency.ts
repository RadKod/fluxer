// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CassandraConsistencyName} from '@pkgs/cassandra/src/Client';

// With writes at QUORUM/LOCAL_QUORUM, a read at the same level already overlaps every
// acknowledged write (R + W > RF), so an ALL read only adds the chance of failing when a
// single replica is down.
export function resolveReadConsistency(
	requested: 'all' | 'serial',
	base: CassandraConsistencyName | undefined,
): 'all' | 'serial' | 'local_quorum' | 'quorum' {
	if (requested === 'all' && (base === 'local_quorum' || base === 'quorum')) {
		return base;
	}
	return requested;
}
