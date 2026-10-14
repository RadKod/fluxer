// SPDX-License-Identifier: AGPL-3.0-or-later
import type {UsernameActor, UsernamePolicyRejection, UsernamePolicySnapshot} from '../UsernamePolicyService';

export class FakeUsernamePolicyService {
	snapshot: UsernamePolicySnapshot = {
		policyRevision: 1,
		tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
		migration: {state: 'selecting', epoch: 1, startedAt: new Date(0), forcedAt: new Date(0)},
		admission: {globalPerSecond: 1000, paused: false},
		dictionary: {
			gen: 1,
			manifest: {hash: 'test', count: 0, counts: {uname_exact: 0, uname_contains: 0, uname_allow: 0}},
			contains: () => false,
		},
	};
	reads = 0;
	onRead?: () => void;
	async prevalidate(): Promise<UsernamePolicyRejection | null> {
		return null;
	}
	async readCached(): Promise<UsernamePolicySnapshot> {
		return this.snapshot;
	}
	async readAuthoritative(): Promise<UsernamePolicySnapshot> {
		this.reads++;
		this.onRead?.();
		return this.snapshot;
	}
	async openReserveMutation(): Promise<number | null> {
		return null;
	}
	async ownsReserveMutation(): Promise<boolean> {
		return true;
	}
	async closeReserveMutation(): Promise<void> {}
	check(
		name: string,
		_actor: UsernameActor,
		isAdmin: boolean,
		snap: UsernamePolicySnapshot,
		entitledName: string | null,
	): UsernamePolicyRejection | null {
		if (!/^[a-z0-9_]{1,32}$/.test(name)) return 'INVALID';
		if (snap.dictionary.contains(name)) return 'BLOCKED';
		if (name.length <= 3 && snap.tiers[name.length as 1 | 2 | 3] !== 'public' && !isAdmin && entitledName !== name)
			return 'REQUIRES_ENTITLEMENT';
		return null;
	}
}
