// SPDX-License-Identifier: AGPL-3.0-or-later
// the profile access decision and the owner's side of the profile view in KV from
// the first release, so a popular profile does not heat the owner's partitions. The viewer–owner record carries the level
// it was computed under, so a level change needs no scan of pair keys.

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {feedDayStart} from '@app/api/feed/FeedRepository';
import type {ProfileBond} from '@app/api/user/profile/ProfileAccessRules';
import type {ProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import {MISSING_SIDE, type ProfileSide, type Relation} from '@app/api/user/services/ProfileAccessService';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// What a read saw; a write after it passes it back, so the write lands only over what was read (see write()).
export type CacheRead<T> = {state: 'hit'; value: T} | {state: 'miss'} | {state: 'forgotten'; marker: string};

export interface CachedRelation extends Relation {
	audience: ProfileAudience;
}

const SIDE_TTL_SECONDS = 60;
const RELATION_TTL_SECONDS = 60;
const VIEW_TTL_SECONDS = 60;
// A forget writes a marker of its own ('-' and a random token) for 5 s. A fill after a plain miss uses SETNX, so a fill
// that read before the change cannot land; a read that saw a marker began after that change, so its fill replaces that
// very marker (no 5 s uncached burst) — but not a newer one: a second change keeps its marker (a compare-and-set).
const FORGET_MARKER = '-';
const FORGET_SECONDS = 5;
const REPLACE_COMMAND = 'profileCacheReplace';
const REPLACE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
	return 1
end
return 0
`;

interface ScriptableKVProvider extends IKVProvider {
	evalScript(command: string, script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Sets `key` to `encoded` for `ttl` seconds only while it still holds `expected`; true when it did (Lua CAS). */
export async function replaceIfUnchanged(
	provider: IKVProvider,
	key: string,
	expected: string,
	encoded: string,
	ttl: number,
): Promise<boolean> {
	const kv = provider as Partial<ScriptableKVProvider>;
	if (typeof kv.evalScript !== 'function') throw new Error('The profile access cache needs a KV provider with scripts');
	return (await kv.evalScript(REPLACE_COMMAND, REPLACE_SCRIPT, 1, key, expected, encoded, ttl)) === 1;
}
// A day's stranger set lives until this long after that day ends, whatever hour a target is added.
const STRANGER_AFTER_DAY_SECONDS = 3_600;
// distinct stranger profiles one account may open a day.
export const STRANGER_DAILY_CAP = 1_000;

// TEMPORARY: a 2 s copy per API process, so one popular owner's keys are read at most once per 2 s per process however many
// viewers open it. Ceiling: 5 000 entries per kind (a side ~0.5 KB, at most ~4 KB with 200 communities; a view ~1-2 KB);
// expired entries go on read, the oldest first when full. A change reaches other processes within 2 s.
const LOCAL_TTL_MS = 2_000;
const LOCAL_MAX = 5_000;

class LocalCopies<T> {
	private readonly entries = new Map<string, {at: number; value: T}>();
	constructor(private readonly now: () => number) {}
	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (this.now() - entry.at >= LOCAL_TTL_MS) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}
	set(key: string, value: T): void {
		this.entries.delete(key);
		if (this.entries.size >= LOCAL_MAX) this.entries.delete(this.entries.keys().next().value!);
		this.entries.set(key, {at: this.now(), value});
	}
	delete(key: string): void {
		this.entries.delete(key);
	}
}

interface Kind<T> {
	ttl: number;
	encode: (value: T) => string;
	decode: (raw: string) => T;
	local?: LocalCopies<T>;
}

const bit = (value: boolean) => (value ? 1 : 0);

const SIDE_CODEC = {
	encode: (side: ProfileSide): string =>
		side.exists
			? JSON.stringify({
					a: side.audience,
					b: bit(side.bot),
					h: bit(side.feedHidden),
					p: bit(side.publicHidden),
					s: bit(side.spammer),
					g: side.guildIds,
				})
			: '{"x":0}',
	decode: (raw: string): ProfileSide => {
		const data = JSON.parse(raw);
		if (data.x === 0) return MISSING_SIDE;
		return {
			exists: true,
			audience: data.a,
			bot: data.b === 1,
			feedHidden: data.h === 1,
			publicHidden: data.p === 1,
			spammer: data.s === 1,
			guildIds: data.g,
		};
	},
};

const RELATION_CODEC = {
	encode: (relation: CachedRelation): string =>
		JSON.stringify({
			a: relation.audience,
			b: relation.bond,
			k: bit(relation.blocked),
			f: bit(relation.friend),
			m: bit(relation.sharedGuild),
		}),
	decode: (raw: string): CachedRelation => {
		const data = JSON.parse(raw) as {a: ProfileAudience; b: ProfileBond; k: number; f: number; m: number};
		return {audience: data.a, bond: data.b, blocked: data.k === 1, friend: data.f === 1, sharedGuild: data.m === 1};
	},
};

export class ProfileAccessCache {
	private readonly side: Kind<ProfileSide>;
	private readonly relation: Kind<CachedRelation>;
	private readonly view: Kind<string>;

	constructor(
		private readonly kv: IKVProvider,
		private readonly now: () => number = Date.now,
	) {
		this.side = {ttl: SIDE_TTL_SECONDS, ...SIDE_CODEC, local: new LocalCopies(now)};
		this.relation = {ttl: RELATION_TTL_SECONDS, ...RELATION_CODEC};
		this.view = {ttl: VIEW_TTL_SECONDS, encode: (raw) => raw, decode: (raw) => raw, local: new LocalCopies(now)};
	}

	readSide(targetId: UserID): Promise<CacheRead<ProfileSide>> {
		return this.read(this.side, `profile:side:${targetId}`);
	}

	writeSide(targetId: UserID, side: ProfileSide, seen: CacheRead<ProfileSide>): Promise<void> {
		return this.write(this.side, `profile:side:${targetId}`, side, seen);
	}

	forgetSide(targetId: UserID): Promise<void> {
		return this.forget(this.side, `profile:side:${targetId}`);
	}

	readRelation(viewerId: UserID, targetId: UserID): Promise<CacheRead<CachedRelation>> {
		return this.read(this.relation, `profile:rel:${viewerId}:${targetId}`);
	}

	writeRelation(
		viewerId: UserID,
		targetId: UserID,
		relation: CachedRelation,
		seen: CacheRead<CachedRelation>,
	): Promise<void> {
		return this.write(this.relation, `profile:rel:${viewerId}:${targetId}`, relation, seen);
	}

	// One key at a time: the two may sit on different cluster slots.
	async forgetRelations(userId: UserID, otherId: UserID): Promise<void> {
		await this.forget(this.relation, `profile:rel:${userId}:${otherId}`);
		await this.forget(this.relation, `profile:rel:${otherId}:${userId}`);
	}

	/** The owner's side of the profile view, as A4 encodes it. */
	readView(targetId: UserID): Promise<CacheRead<string>> {
		return this.read(this.view, `profile:view:${targetId}`);
	}

	writeView(targetId: UserID, encoded: string, seen: CacheRead<string>): Promise<void> {
		return this.write(this.view, `profile:view:${targetId}`, encoded, seen);
	}

	forgetView(targetId: UserID): Promise<void> {
		return this.forget(this.view, `profile:view:${targetId}`);
	}

	/**
	 * whether `viewerId` may open one more stranger profile on `day`; a target already opened that day is free.
	 * TEMPORARY: check then add, so racing requests may pass the cap by a few; a Lua script if it ever must be exact.
	 */
	async allowStranger(viewerId: UserID, targetId: UserID, day: number): Promise<boolean> {
		const key = `profile:stranger:${viewerId}:${day}`;
		const member = targetId.toString();
		if ((await this.kv.sismember(key, member)) === 1) return true;
		if ((await this.kv.scard(key)) >= STRANGER_DAILY_CAP) return false;
		// Every add of the day aims at the same moment, so a late add does not keep the set alive into the next day.
		const ttl = Math.ceil((feedDayStart(day + 1).getTime() - this.now()) / 1000) + STRANGER_AFTER_DAY_SECONDS;
		await this.kv.pipeline().sadd(key, member).expire(key, ttl).exec();
		return true;
	}

	private async read<T>(kind: Kind<T>, key: string): Promise<CacheRead<T>> {
		const copy = kind.local?.get(key);
		if (copy !== undefined) return {state: 'hit', value: copy};
		const raw = await this.kv.get(key);
		if (raw === null) return {state: 'miss'};
		if (raw.startsWith(FORGET_MARKER)) return {state: 'forgotten', marker: raw};
		const value = kind.decode(raw);
		kind.local?.set(key, value);
		return {state: 'hit', value};
	}

	// After a miss: SETNX. After a marker or a record: replace exactly what was read (a record re-encodes to its stored
	// string), so a forget between the read and the write keeps its marker.
	private async write<T>(kind: Kind<T>, key: string, value: T, seen: CacheRead<T>): Promise<void> {
		const encoded = kind.encode(value);
		const stored =
			seen.state === 'miss'
				? await this.kv.setnx(key, encoded, kind.ttl)
				: await replaceIfUnchanged(
						this.kv,
						key,
						seen.state === 'forgotten' ? seen.marker : kind.encode(seen.value),
						encoded,
						kind.ttl,
					);
		if (stored) kind.local?.set(key, value);
	}

	private async forget<T>(kind: Kind<T>, key: string): Promise<void> {
		kind.local?.delete(key);
		await this.kv.setex(key, FORGET_SECONDS, `${FORGET_MARKER}${randomUUID()}`);
	}
}
