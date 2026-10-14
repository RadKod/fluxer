// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db, isConditionalQuery, type PreparedQuery} from '@app/api/database/CassandraTypes';
import {
	UserByUsername,
	UsernameClaims,
	UsernameHoldsByBucket,
	UsernameOpIntents,
	UsernameOwners,
	Users,
} from '@app/api/Tables';
import {
	type InMemoryCassandraOptions,
	InMemoryCassandraQueryExecutor,
} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {UsernameOwnershipRepository} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {UsernameRepairSweeper} from '../UsernameRepairSweeper';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';
import {OwnershipInvariants} from './OwnershipInvariants';

const uid = createUserID(200n);
const ctx = {adminId: createUserID(999n), reason: 'test', note: 'test'};
let now: number;
let db: InMemoryCassandraQueryExecutor;
let policy: FakeUsernamePolicyService;
let invariant: OwnershipInvariants;
let originalBackend: 'cassandra' | 'postgres';
const service = (extra = {}) =>
	new UsernameOwnershipService({
		policy,
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
		...extra,
	});
async function seed() {
	await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy'), discriminator: Db.set(4567)}));
	await executeQuery(UserByUsername.upsertAll({username: 'legacy', discriminator: 4567, user_id: uid}));
}
beforeEach(() => {
	originalBackend = Config.database.backend;
	Config.database.backend = 'cassandra';
	// The in-memory store stamps untimestamped writes with the real clock; the service clock must not trail it.
	now = Date.parse('2099-10-09T12:00:00Z');
	policy = new FakeUsernamePolicyService();
});
afterEach(() => {
	Config.database.backend = originalBackend;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});
function install(options: InMemoryCassandraOptions = {}) {
	let checking = false;
	db = new InMemoryCassandraQueryExecutor({
		...options,
		beforeQuery: async (query, readOptions) => {
			if (!checking) await options.beforeQuery?.(query, readOptions);
		},
		afterQuery: async (query, readOptions) => {
			if (checking) return;
			checking = true;
			try {
				await invariant.instant();
			} finally {
				checking = false;
			}
			await options.afterQuery?.(query, readOptions);
		},
	});
	invariant = new OwnershipInvariants(db, () => now);
	setCassandraQueryExecutorForTesting(db);
}
const lwtSteps = [
	'acquire',
	'claim',
	'commit',
	'assign',
	'grant',
	'release',
	'revoke',
	'clear',
	'abort',
	'restore',
] as const;
function step(query: PreparedQuery): string | null {
	const table = query.kvMeta?.table.name;
	if (table === 'username_owners') {
		if (query.params.op_phase === 'pending') return 'acquire';
		if (query.params.op_phase === 'committed') return 'commit';
		if (query.params.op_phase === 'aborted') return 'abort';
		if (query.kvMeta?.action === 'patch' && 'op_id' in query.params && query.params.op_id === null) return 'clear';
	}
	if (table === 'username_claims') {
		if (query.params.state === 'pending') return 'claim';
		if (query.params.state === 'assigned') return 'assign';
		if (query.kvMeta?.action === 'delete' || query.params.state === 'held') return 'restore';
		if (query.params.state === 'released') return 'release';
	}
	if (table === 'username_entitlements') return query.params.revoked_at instanceof Date ? 'revoke' : 'grant';
	return null;
}
function traceStep(query: PreparedQuery): string | null {
	if (query.kvMeta?.table.name === 'username_op_intents' && query.kvMeta.action !== 'select')
		return query.kvMeta.action === 'delete' ? 'intent_delete' : 'intent';
	if (query.kvMeta?.table.name === 'users_by_username' && query.kvMeta.action !== 'select')
		return query.kvMeta.action === 'delete' ? 'old_index' : 'new_index';
	if (query.kvMeta?.table.name === 'users' && query.kvMeta.action === 'patch') return 'projection';
	return isConditionalQuery(query) ? step(query) : null;
}
describe('ownership fault recovery', () => {
	it.each(
		lwtSteps.flatMap((target) =>
			(['apply_then_timeout', 'timeout_before_apply'] as const).map((fault) => ({target, fault})),
		),
	)('$target resolves $fault by SERIAL reads', async ({target, fault}) => {
		let armed = false;
		let injected = false;
		install({
			lwtFault: (query: PreparedQuery) => {
				if (armed && !injected && step(query) === target) {
					injected = true;
					return fault;
				}
				return undefined;
			},
		});
		await seed();
		const api = service();
		if (['release', 'revoke'].includes(target)) await api.adminAssign('a', uid, ctx);
		if (['abort', 'restore'].includes(target)) {
			await api.adminHold('a', ctx);
			policy.onRead = () => {
				if (armed && policy.reads >= 2) policy.snapshot.policyRevision++;
			};
		}
		armed = true;
		await (['grant', 'abort', 'restore'].includes(target)
			? api.adminAssign('a', uid, ctx)
			: api.claimSelf(uid, 'first'));
		expect(injected, `${target} fault must execute`).toBe(true);
		now += 61000;
		policy.onRead = undefined;
		await service().repair(uid);
		if (['abort', 'restore'].includes(target))
			expect(await api.repository.readClaim('a')).toMatchObject({state: 'held'});
		await invariant.converged();
	});
	it.each(
		[
			'intent',
			'acquire',
			'claim',
			'commit',
			'assign',
			'grant',
			'release',
			'revoke',
			'new_index',
			'projection',
			'old_index',
			'clear',
			'intent_delete',
			'abort',
			'restore',
		].flatMap((target) => (['before', 'after'] as const).map((timing) => ({target, timing}))),
	)('process crash $timing $target converges through durable recovery', async ({target, timing}) => {
		let armed = false;
		let crashed = false;
		let checking = false;
		install({
			beforeQuery: (query) => {
				if (crashed) throw new Error('process stopped');
				if (armed && timing === 'before' && traceStep(query) === target) {
					crashed = true;
					throw new Error('process stopped');
				}
			},
			afterQuery: async (query: PreparedQuery) => {
				if (!armed || checking) return;
				checking = true;
				try {
					await invariant.instant();
				} finally {
					checking = false;
				}
				if (timing === 'after' && traceStep(query) === target) {
					crashed = true;
					throw new Error('process stopped');
				}
			},
		});
		await seed();
		const api = service();
		if (['release', 'revoke'].includes(target)) await api.adminAssign('a', uid, ctx);
		if (['abort', 'restore'].includes(target)) {
			await api.adminHold('a', ctx);
			policy.onRead = () => {
				if (armed && policy.reads >= 2) policy.snapshot.policyRevision++;
			};
		}
		armed = true;
		await (['grant', 'abort', 'restore'].includes(target)
			? api.adminAssign('a', uid, ctx)
			: api.claimSelf(uid, 'first'));
		expect(crashed, `${target} crash must execute`).toBe(true);
		armed = false;
		crashed = false;
		policy.onRead = undefined;
		now += 61000;
		await service().repair(uid);
		let cursor: unknown = null;
		await new UsernameRepairSweeper({
			ownership: service(),
			now: () => now,
			config: {
				readUsernameRepairState: async () => cursor,
				compareAndSetUsernameRepairState: async (expected, next) => {
					if (JSON.stringify(cursor) !== JSON.stringify(expected)) return false;
					cursor = structuredClone(next);
					return true;
				},
			},
		}).run();
		await invariant.converged();
	});
	it('two names for one user have one committed winner', async () => {
		install();
		await seed();
		const api = service();
		const results = await Promise.all([api.claimSelf(uid, 'first'), api.claimSelf(uid, 'second')]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		await api.repair(uid);
		await invariant.converged();
	});
	it('projection advances above legacy timestamps and deletes persisted old index', async () => {
		install();
		await seed();
		const future = BigInt(now * 1000) + 1000000000n;
		await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy')}, {timestamp: future}));
		const api = service();
		expect(await api.claimSelf(uid, 'first')).toMatchObject({ok: true});
		expect(await api.repository.hasIndex(uid, 'legacy', 4567)).toBe(false);
		expect((await api.repository.readOwner(uid))!.last_proj_ts).toBeGreaterThan(future);
		await invariant.converged();
	});
	it('Postgres ownership fails before any intent, claim or owner mutation', async () => {
		install();
		await seed();
		Config.database.backend = 'postgres';
		expect(await service().claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		for (const table of [UsernameOwners, UsernameClaims, UsernameOpIntents])
			expect(await db.executeQuery(table.select().bind({}))).toEqual([]);
		await invariant.converged();
	});
	it('losing speculative hold timestamp cannot strand the index after unhold', async () => {
		install();
		await seed();
		const api = service();
		await api.adminHold('first', ctx);
		await api.adminUnhold('first', ctx);
		const base = now;
		let prewritten!: () => void;
		let resume!: () => void;
		const written = new Promise<void>((resolve) => {
			prewritten = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			resume = resolve;
		});
		class PausedHoldRepository extends UsernameOwnershipRepository {
			override async writeHoldIndex(row: Parameters<UsernameOwnershipRepository['writeHoldIndex']>[0]) {
				await super.writeHoldIndex(row);
				prewritten();
				await wait;
			}
		}
		const slow = service({repository: new PausedHoldRepository(), now: () => base + 200});
		const fast = service({now: () => base + 100});
		const loser = slow.adminHold('first', ctx);
		await written;
		expect(await fast.adminHold('first', ctx)).toMatchObject({ok: true});
		resume();
		await loser;
		await service({now: () => base + 50}).adminUnhold('first', ctx);
		expect(await db.executeQuery(UsernameHoldsByBucket.select().bind({}))).toEqual([]);
		await invariant.converged();
	});
	it('delayed authoritative policy read cannot commit a sixty-second zombie', async () => {
		install();
		await seed();
		policy.onRead = () => {
			if (policy.reads === 2) now += 61000;
		};
		expect(await service().claimSelf(uid, 'first')).toMatchObject({ok: false});
		policy.onRead = undefined;
		await service().repair(uid);
		await invariant.converged();
	});
	it('an hour-delayed intent acknowledgement never sends acquire', async () => {
		install();
		await seed();
		class DelayedIntentRepository extends UsernameOwnershipRepository {
			override async writeIntent(...args: Parameters<UsernameOwnershipRepository['writeIntent']>) {
				await super.writeIntent(...args);
				now += 3600000;
			}
		}
		expect(await service({repository: new DelayedIntentRepository()}).claimSelf(uid, 'first')).toMatchObject({
			ok: false,
			code: 'BUSY',
		});
		expect((await service().repository.readOwner(uid))!.seq).toBe(0n);
		await invariant.converged();
	});
	it('a scheduler pause beyond thirty seconds after intent acknowledgement never sends acquire', async () => {
		install();
		await seed();
		class PausedAcknowledgementRepository extends UsernameOwnershipRepository {
			override async writeIntent(...args: Parameters<UsernameOwnershipRepository['writeIntent']>) {
				await super.writeIntent(...args);
				queueMicrotask(() =>
					queueMicrotask(() => {
						now += 31000;
					}),
				);
			}
		}
		expect(await service({repository: new PausedAcknowledgementRepository()}).claimSelf(uid, 'first')).toMatchObject({
			ok: false,
			code: 'BUSY',
		});
		expect((await service().repository.readOwner(uid))!.seq).toBe(0n);
		await invariant.converged();
	});
	it('moderation release follows the persisted embargo even when formerly reserved', async () => {
		install();
		await seed();
		const api = service();
		await api.adminHold('first', ctx);
		await api.adminAssign('first', uid, ctx);
		await api.forceReselect(uid, false, ctx);
		expect(await api.repository.readClaim('first')).toMatchObject({
			state: 'released',
			blocked_until: new Date(now + 14 * 86400000),
		});
		await invariant.converged();
	});
	it('reselection bypasses cooldown and persists the self commit change counter', async () => {
		install();
		await seed();
		const api = service();
		await api.claimSelf(uid, 'first');
		await api.forceReselect(uid, false, ctx);
		await api.claimSelf(uid, 'second');
		expect(await api.repository.readOwner(uid)).toMatchObject({free_change_used: true, changed_at: new Date(now)});
		await invariant.converged();
	});
	it('old finalizer delayed before projection cannot restore a replaced generation', async () => {
		let paused = false;
		let release!: () => void;
		let reached!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			reached = resolve;
		});
		install({
			beforeQuery: async (query) => {
				if (
					!paused &&
					query.kvMeta?.table.name === 'users_by_username' &&
					query.params.username === 'first' &&
					query.kvMeta.action === 'upsert'
				) {
					paused = true;
					reached();
					await wait;
				}
			},
		});
		await seed();
		const api = service();
		const original = api.claimSelf(uid, 'first');
		await ready;
		await service().repair(uid);
		expect(await service().claimSelf(uid, 'second')).toMatchObject({ok: true});
		release();
		await original;
		expect(await api.repository.readProjection(uid)).toMatchObject({username: 'second', discriminator: 0});
		await invariant.converged();
	});
	it('fourteen-day ABA does not let an old releaser free a new generation', async () => {
		let armed = false;
		let paused = false;
		let release!: () => void;
		let reached!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			reached = resolve;
		});
		install({
			beforeQuery: async (query) => {
				if (
					armed &&
					!paused &&
					query.kvMeta?.table.name === 'username_claims' &&
					query.kvMeta.action === 'select' &&
					query.params.username === 'first'
				) {
					paused = true;
					reached();
					await wait;
				}
			},
		});
		await seed();
		const api = service();
		await api.claimSelf(uid, 'first');
		armed = true;
		const original = api.claimSelf(uid, 'second');
		await ready;
		await service().repair(uid);
		now += 14 * 86400000;
		expect(await service().claimSelf(uid, 'first')).toMatchObject({ok: true});
		release();
		await original;
		expect(await api.repository.readClaim('first')).toMatchObject({state: 'assigned', owned_gen: 3n, user_id: uid});
		await invariant.converged();
	});
	it('an old entitlement finalizer cannot replace the grant of a newer assignment', async () => {
		install();
		await seed();
		let reads = 0;
		let release!: () => void;
		let reached!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			reached = resolve;
		});
		class PausedGrantRepository extends UsernameOwnershipRepository {
			override async readEntitlement(userId: typeof uid) {
				if (++reads === 2) {
					reached();
					await wait;
				}
				return super.readEntitlement(userId);
			}
		}
		const api = service({repository: new PausedGrantRepository()});
		const original = api.adminAssign('a', uid, ctx);
		await ready;
		await service().repair(uid);
		expect(await service().adminAssign('b', uid, ctx)).toMatchObject({ok: true});
		const newGrant = await api.repository.readEntitlement(uid);
		release();
		await original;
		expect(await api.repository.readEntitlement(uid)).toEqual(newGrant);
		await invariant.converged();
	});
});
