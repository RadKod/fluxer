// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {UsernameMigrationConfig} from '@app/api/instance/AccountIdentityModeCache';
import type {InstanceConfigRepository, UsernamePolicyConfig} from '@app/api/instance/InstanceConfigRepository';
import {profileSubstringBlocklistCache} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {LOOKALIKE_DIGITS} from '@fluxer/schema/src/primitives/MicupBrandGuard';
import {UsernameLookupType, UsernameType} from '@fluxer/schema/src/primitives/UserValidators';

export type UsernameDictionaryScope = 'uname_exact' | 'uname_contains' | 'uname_allow';
export type UsernameDictionaryEntries = Readonly<Record<UsernameDictionaryScope, ReadonlyArray<string>>>;
export interface UsernameDictionaryManifest {
	readonly hash: string;
	readonly count: number;
	readonly counts: Readonly<Record<UsernameDictionaryScope, number>>;
}
export interface UsernameDictionary {
	readonly gen: number;
	readonly manifest: UsernameDictionaryManifest;
	contains(name: string): boolean;
}

const DICTIONARY_SCOPES = ['uname_exact', 'uname_contains', 'uname_allow'] as const;
const MAX_ENTRIES = 20_000;

function canonicalEntries(entries: UsernameDictionaryEntries): UsernameDictionaryEntries {
	const lists = {} as Record<UsernameDictionaryScope, Array<string>>;
	let count = 0;
	for (const scope of DICTIONARY_SCOPES) {
		lists[scope] = Array.from(
			new Set(
				entries[scope].map((entry) => {
					const canonical = entry.trim().toLowerCase();
					if (!/^[a-z0-9]{1,32}$/.test(canonical)) throw new Error('Invalid username dictionary entry');
					return canonical;
				}),
			),
		).sort();
		count += lists[scope].length;
	}
	if (count > MAX_ENTRIES) throw new Error('Username dictionary exceeds 20000 entries');
	return lists;
}

function manifestFor(entries: UsernameDictionaryEntries): UsernameDictionaryManifest {
	const counts = Object.freeze({
		uname_exact: entries.uname_exact.length,
		uname_contains: entries.uname_contains.length,
		uname_allow: entries.uname_allow.length,
	});
	return Object.freeze({
		hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
		count: Object.values(counts).reduce((sum, count) => sum + count, 0),
		counts,
	});
}

export function computeUsernameDictionaryManifest(entries: UsernameDictionaryEntries): UsernameDictionaryManifest {
	return manifestFor(canonicalEntries(entries));
}

function collapseRuns(value: string, maximum: number): string {
	return value.replace(maximum === 1 ? /(.)\1+/g : /(.)\1{2,}/g, (run) => run[0].repeat(maximum));
}

function readings(name: string): Set<string> {
	const base = name.replaceAll('_', '');
	const leet = (value: string, one: string) =>
		value.replace(/[0-9]/g, (digit) =>
			digit === '1' ? one : digit === '9' ? 'g' : (LOOKALIKE_DIGITS[digit] ?? digit),
		);
	const forms = new Set([base, leet(base, 'i'), leet(base, 'l'), leet(base.replaceAll('l', 'i'), 'i')]);
	for (const value of Array.from(forms)) forms.add(value.replaceAll('rn', 'm'));
	return forms;
}

function alphabetIndex(charCode: number): number {
	return charCode <= 57 ? charCode - 48 : charCode - 87;
}

// Micup: dense ASCII transitions bound matching work to the name length, independent of dictionary size.
class AhoCorasick {
	private readonly transitions: Uint32Array;
	private readonly terminal: Uint8Array;

	constructor(patterns: ReadonlyArray<string>) {
		const capacity = 1 + patterns.reduce((sum, pattern) => sum + pattern.length, 0);
		const transitions = new Uint32Array(capacity * 36);
		const terminal = new Uint8Array(capacity);
		const failure = new Uint32Array(capacity);
		let nodes = 1;
		for (const pattern of patterns) {
			let node = 0;
			for (let i = 0; i < pattern.length; i++) {
				const index = node * 36 + alphabetIndex(pattern.charCodeAt(i));
				if (transitions[index] === 0) transitions[index] = nodes++;
				node = transitions[index];
			}
			terminal[node] = 1;
		}
		const queue = new Uint32Array(nodes);
		let head = 0;
		let tail = 0;
		for (let char = 0; char < 36; char++) if (transitions[char]) queue[tail++] = transitions[char];
		while (head < tail) {
			const node = queue[head++];
			const offset = node * 36;
			const fallback = failure[node] * 36;
			for (let char = 0; char < 36; char++) {
				const next = transitions[offset + char];
				if (next) {
					failure[next] = transitions[fallback + char];
					terminal[next] |= terminal[failure[next]];
					queue[tail++] = next;
				} else transitions[offset + char] = transitions[fallback + char];
			}
		}
		this.transitions = transitions;
		this.terminal = terminal;
	}

	contains(value: string): boolean {
		let node = 0;
		for (let i = 0; i < value.length; i++) {
			node = this.transitions[node * 36 + alphabetIndex(value.charCodeAt(i))];
			if (this.terminal[node]) return true;
		}
		return false;
	}
}

export function compileUsernameDictionary(gen: number, entries: UsernameDictionaryEntries): UsernameDictionary {
	if (!Number.isSafeInteger(gen) || gen < 0) throw new Error('Invalid username dictionary generation');
	const canonical = canonicalEntries(entries);
	const exact = new Set(canonical.uname_exact.map((entry) => collapseRuns(entry, 1)));
	const allow = new Set(canonical.uname_allow);
	const single: Array<string> = [];
	const double: Array<string> = [];
	for (const entry of canonical.uname_contains) {
		if (/(.)\1/.test(entry)) double.push(collapseRuns(entry, 2));
		else single.push(collapseRuns(entry, 1));
	}
	const singleMatcher = new AhoCorasick(single);
	const doubleMatcher = new AhoCorasick(double);
	return Object.freeze({
		gen,
		manifest: manifestFor(canonical),
		contains(name: string): boolean {
			if (allow.has(name.replaceAll('_', ''))) return false;
			const forms = readings(name);
			for (const form of forms) if (exact.has(collapseRuns(form, 1))) return true;
			// Micup: strip digits from every leet reading too; exact matching deliberately retains digits.
			for (const form of Array.from(forms)) forms.add(form.replace(/[0-9]/g, ''));
			for (const form of forms) {
				if (singleMatcher.contains(collapseRuns(form, 1)) || doubleMatcher.contains(collapseRuns(form, 2))) return true;
			}
			return false;
		},
	});
}

const UNPUBLISHED_DICTIONARY = compileUsernameDictionary(0, {uname_exact: [], uname_contains: [], uname_allow: []});

export type UsernameActor = {kind: 'human'; userId: UserID} | {kind: 'bot'; userId: UserID | null};
export type UsernamePolicyRejection =
	| 'INVALID'
	| 'RESERVED_TERM'
	| 'BLOCKED'
	| 'TOO_SHORT'
	| 'REQUIRES_ENTITLEMENT'
	| 'UNAVAILABLE';
export interface UsernamePolicySnapshot {
	policyRevision: number;
	tiers: Record<1 | 2 | 3, 'locked' | 'for_sale' | 'public'>;
	migration: {
		state: 'legacy' | 'preparing' | 'selecting';
		epoch: number;
		startedAt: Date | null;
		forcedAt: Date | null;
	};
	admission: {globalPerSecond: number; paused: boolean};
	dictionary: UsernameDictionary;
}

export class UsernameUnavailableError extends Error {
	constructor(cause?: unknown) {
		super('Username policy is unavailable', {cause});
		this.name = 'UsernameUnavailableError';
	}
}

type PolicyRepository = Pick<
	InstanceConfigRepository,
	| 'getUsernamePolicyConfig'
	| 'getUsernameMigrationConfig'
	| 'readUsernamePolicyConfig'
	| 'readUsernameMigrationConfig'
	| 'openUsernameReserveMutation'
	| 'readUsernameReserveFence'
	| 'closeUsernameReserveMutation'
>;
interface DictionaryCache {
	getUsernameDictionary(gen: number, hash: string): UsernameDictionary | null;
	loadUsernameDictionary(gen: number, hash: string): Promise<UsernameDictionary>;
}

function snapshot(
	policy: UsernamePolicyConfig,
	migration: UsernameMigrationConfig,
	dictionary: UsernameDictionary,
): UsernamePolicySnapshot {
	return {
		policyRevision: policy.revision,
		tiers: {...policy.tiers},
		migration: {
			state: migration.state,
			epoch: migration.epoch,
			startedAt: migration.started_at === null ? null : new Date(migration.started_at),
			forcedAt: migration.forced_at === null ? null : new Date(migration.forced_at),
		},
		admission: {globalPerSecond: policy.admission.global_per_second, paused: policy.admission.paused},
		dictionary,
	};
}

export class UsernamePolicyService {
	constructor(
		private readonly repository: PolicyRepository = getInstanceConfigRepository(),
		private readonly cache: DictionaryCache = profileSubstringBlocklistCache,
	) {}

	async prevalidate(name: string, actor: UsernameActor, isAdmin: boolean): Promise<UsernamePolicyRejection | null> {
		try {
			// Micup: this advisory check cannot reject a grant that only the authoritative owner operation reads.
			return this.check(name, actor, isAdmin, await this.readCached(), name);
		} catch {
			return 'UNAVAILABLE';
		}
	}

	readCached(): Promise<UsernamePolicySnapshot> {
		return this.read(
			() => Promise.all([this.repository.getUsernamePolicyConfig(), this.repository.getUsernameMigrationConfig()]),
			true,
		);
	}

	readAuthoritative(): Promise<UsernamePolicySnapshot> {
		return this.read(
			() => Promise.all([this.repository.readUsernamePolicyConfig(), this.repository.readUsernameMigrationConfig()]),
			false,
		);
	}

	openReserveMutation(): Promise<number | null> {
		return this.repository.openUsernameReserveMutation();
	}

	async ownsReserveMutation(version: number): Promise<boolean> {
		const fence = await this.repository.readUsernameReserveFence();
		return fence.pending && fence.version === version;
	}

	closeReserveMutation(version: number): Promise<void> {
		return this.repository.closeUsernameReserveMutation(version);
	}

	private async read(
		load: () => Promise<[UsernamePolicyConfig, UsernameMigrationConfig]>,
		cached: boolean,
	): Promise<UsernamePolicySnapshot> {
		try {
			const [policy, migration] = await load();
			if (migration.state === 'legacy' && policy.dictionary_gen === 0)
				return snapshot(policy, migration, UNPUBLISHED_DICTIONARY);
			if (!policy.dictionary_hash) throw new UsernameUnavailableError();
			const dictionary =
				(cached ? this.cache.getUsernameDictionary(policy.dictionary_gen, policy.dictionary_hash) : null) ??
				(await this.cache.loadUsernameDictionary(policy.dictionary_gen, policy.dictionary_hash));
			if (dictionary.gen !== policy.dictionary_gen || dictionary.manifest.hash !== policy.dictionary_hash)
				throw new UsernameUnavailableError();
			return snapshot(policy, migration, dictionary);
		} catch (cause) {
			if (cause instanceof UsernameUnavailableError) throw cause;
			throw new UsernameUnavailableError(cause);
		}
	}

	check(
		name: string,
		actor: UsernameActor,
		isAdmin: boolean,
		snap: UsernamePolicySnapshot,
		entitledName: string | null,
	): UsernamePolicyRejection | null {
		if (!/^[a-z0-9_]{1,32}$/.test(name)) return 'INVALID';
		const adminAssignment = isAdmin && actor.kind === 'human';
		const validation = (isAdmin ? UsernameLookupType : UsernameType).safeParse(name);
		if (!validation.success) {
			return validation.error.issues.some(
				(issue) =>
					issue.message === ValidationErrorCodes.USERNAME_RESERVED_VALUE ||
					issue.message === ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_RESERVED_TERMS ||
					issue.message === ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_MICUP,
			)
				? 'RESERVED_TERM'
				: 'INVALID';
		}
		// Micup: keep upstream validation until the first dictionary is published, only before migration.
		if (snap.dictionary.gen === 0) return snap.migration.state === 'legacy' ? null : 'UNAVAILABLE';
		if (snap.dictionary.contains(name)) return 'BLOCKED';
		if (
			name.length <= 3 &&
			snap.tiers[name.length as 1 | 2 | 3] !== 'public' &&
			entitledName !== name &&
			!adminAssignment
		)
			return 'REQUIRES_ENTITLEMENT';
		return null;
	}
}
