// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CassandraConsistencyName} from '@pkgs/cassandra/src/Client';

// With writes at QUORUM/LOCAL_QUORUM, a read at the same level already overlaps every
// acknowledged write (R + W > RF), so an ALL read only adds the chance of failing when a
// single replica is down.
export function resolveAllReadConsistency(base: CassandraConsistencyName | undefined): CassandraConsistencyName {
	return base === 'localQuorum' || base === 'quorum' ? base : 'all';
}
