// SPDX-License-Identifier: AGPL-3.0-or-later

import {BANNED_PROFILE_SUBSTRINGS_REFRESH_CHANNEL} from '@app/api/constants/ContentModeration';
import {fetchMany} from '@app/api/database/CassandraQueryExecution';
import type {BannedProfileSubstringRow, BannedProfileSubstringScope} from '@app/api/database/types/AdminArchiveTypes';
import {Logger} from '@app/api/Logger';
import {BannedProfileSubstrings} from '@app/api/Tables';
import {
	compileUsernameDictionary,
	type UsernameDictionary,
	type UsernameDictionaryEntries,
} from '@app/api/user/username/UsernamePolicyService';
import {PhraseMatcherSet} from '@app/api/utils/PhraseMatcherSet';
import {RefreshedCache} from '@app/api/utils/RefreshedCache';

type ProfileScope = BannedProfileSubstringScope;

const PROFILE_SCOPES: ReadonlyArray<ProfileScope> = ['username', 'global_name', 'nickname', 'bio', 'pronouns'];
const PROFILE_NAME_SCOPES = new Set<ProfileScope>(['username', 'global_name', 'nickname']);
const DICTIONARY_SCOPES = ['uname_exact', 'uname_contains', 'uname_allow'] as const;
const LOAD_DICTIONARY_SCOPE = BannedProfileSubstrings.select({where: BannedProfileSubstrings.where.eq('scope')});

export async function loadUsernameDictionaryGeneration(gen: number): Promise<UsernameDictionaryEntries> {
	if (!Number.isSafeInteger(gen) || gen < 0) throw new Error('Invalid username dictionary generation');
	const lists = await Promise.all(
		DICTIONARY_SCOPES.map(async (scope) => {
			const rows = await fetchMany<{substring: string}>(LOAD_DICTIONARY_SCOPE.bind({scope: `${scope}:g${gen}`}));
			return rows.map((row) => row.substring);
		}),
	);
	return {uname_exact: lists[0], uname_contains: lists[1], uname_allow: lists[2]};
}

export class ProfileSubstringBlocklistCache extends RefreshedCache {
	private usernameDictionaries = new Map<number, UsernameDictionary>();
	private usernameLoads = new Map<string, Promise<UsernameDictionary>>();
	private byScope = new Map<ProfileScope, PhraseMatcherSet>();
	constructor() {
		super({name: 'profile-substring blocklist cache', channels: [BANNED_PROFILE_SUBSTRINGS_REFRESH_CHANNEL]});
	}
	protected async load(): Promise<void> {
		const rows = (
			await Promise.all(
				PROFILE_SCOPES.map((scope) => fetchMany<BannedProfileSubstringRow>(LOAD_DICTIONARY_SCOPE.bind({scope}))),
			)
		).flat();
		const phrases = new Map<ProfileScope, Array<string>>(PROFILE_SCOPES.map((scope) => [scope, []]));
		for (const row of rows) phrases.get(row.scope as ProfileScope)?.push(row.substring);
		const next = new Map<ProfileScope, PhraseMatcherSet>();
		for (const [scope, values] of phrases) {
			const matcher = new PhraseMatcherSet();
			matcher.replaceAll(values);
			next.set(scope, matcher);
		}
		this.byScope = next;
		Logger.debug(
			{counts: Object.fromEntries(Array.from(next.entries()).map(([k, v]) => [k, v.size]))},
			'Profile-substring blocklist cache refreshed',
		);
	}
	getUsernameDictionary(gen: number, hash: string): UsernameDictionary | null {
		const dictionary = this.usernameDictionaries.get(gen);
		return dictionary?.manifest.hash === hash ? dictionary : null;
	}
	loadUsernameDictionary(gen: number, hash: string): Promise<UsernameDictionary> {
		const cached = this.getUsernameDictionary(gen, hash);
		if (cached) return Promise.resolve(cached);
		const key = `${gen}:${hash}`;
		const pending = this.usernameLoads.get(key);
		if (pending) return pending;
		const loading = loadUsernameDictionaryGeneration(gen)
			.then((entries) => {
				const dictionary = compileUsernameDictionary(gen, entries);
				if (dictionary.manifest.hash !== hash) throw new Error('Username dictionary hash mismatch');
				this.usernameDictionaries.set(gen, dictionary);
				// Micup: snapshots keep their dictionary alive; the shared cache only retains the two latest loaded generations.
				while (this.usernameDictionaries.size > 2)
					this.usernameDictionaries.delete(this.usernameDictionaries.keys().next().value!);
				return dictionary;
			})
			.finally(() => this.usernameLoads.delete(key));
		this.usernameLoads.set(key, loading);
		return loading;
	}
	private getMatchersForCheck(scope: ProfileScope): Array<PhraseMatcherSet> {
		if (PROFILE_NAME_SCOPES.has(scope))
			return Array.from(PROFILE_NAME_SCOPES)
				.map((nameScope) => this.byScope.get(nameScope))
				.filter((matcher): matcher is PhraseMatcherSet => !!matcher && matcher.size > 0);
		const matcher = this.byScope.get(scope);
		return matcher && matcher.size > 0 ? [matcher] : [];
	}
	containsBannedSubstring(scope: ProfileScope, text: string): boolean {
		return !!text && this.getMatchersForCheck(scope).some((matcher) => matcher.containsBannedPhrase(text));
	}
	isSubstringBanned(scope: ProfileScope, substring: string): boolean {
		return this.getMatchersForCheck(scope).some((matcher) => matcher.isPhraseBanned(substring));
	}
	add(scope: ProfileScope, substring: string): void {
		let matcher = this.byScope.get(scope);
		if (!matcher) {
			matcher = new PhraseMatcherSet();
			this.byScope.set(scope, matcher);
		}
		matcher.add(substring);
	}
	remove(scope: ProfileScope, substring: string): void {
		this.byScope.get(scope)?.remove(substring);
	}
	resetForTesting(): void {
		this.resetRefreshState();
		this.byScope = new Map();
		this.usernameDictionaries.clear();
		this.usernameLoads.clear();
	}
}

export const profileSubstringBlocklistCache = new ProfileSubstringBlocklistCache();
