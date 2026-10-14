// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import type {UsernameClaimRow, UsernameOpIntentRow} from '@app/api/database/types/UserTypes';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {registerCounter} from '@fluxer/hono/src/middleware/Metrics';
import type {UsernameOwnershipService} from './UsernameOwnershipService';

interface RepairState {
	[key: string]: string | number | null;
	oldest_day: string;
	cursor_day: string;
	cursor_bucket: number;
	after_user_id: string | null;
	after_op_id: string | null;
}
interface RepairConfig {
	readUsernameRepairState(): Promise<unknown>;
	compareAndSetUsernameRepairState(expected: RepairState | null, next: RepairState): Promise<boolean>;
}
interface Dependencies {
	ownership: UsernameOwnershipService;
	config?: RepairConfig;
	now?: () => number;
}
export interface UsernameRepairSweepResult {
	processed: number;
	budgetExceeded: boolean;
	remaining: boolean;
	failed: number;
	deferred: number;
}
const DAY_MS = 86400000;
const MAX_ROWS = 5000;
const BUDGET_MS = 20000;
const CONCURRENCY = 8;
const failedRepairs = registerCounter(
	'fluxer_api_username_intent_repair_failed_total',
	'Failed username intent repair attempts',
);
const deferredRepairs = registerCounter(
	'fluxer_api_username_intent_repair_deferred_total',
	'Username intent repairs deferred by backoff',
);
const date = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextDay = (day: string) => date(Date.parse(`${day}T00:00:00Z`) + DAY_MS);
function decode(raw: unknown): RepairState | null {
	if (raw === null) return null;
	if (typeof raw !== 'object' || raw === null) throw new Error('Invalid username repair cursor');
	const row = raw as RepairState;
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(row.cursor_day) ||
		!Number.isInteger(row.cursor_bucket) ||
		row.cursor_bucket < 0 ||
		row.cursor_bucket >= 64 ||
		(row.after_user_id !== null && !/^\d+$/.test(row.after_user_id)) ||
		(row.after_op_id !== null && typeof row.after_op_id !== 'string')
	)
		throw new Error('Invalid username repair cursor');
	if (row.oldest_day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(row.oldest_day) || row.oldest_day > row.cursor_day))
		throw new Error('Invalid username repair oldest day');
	return {...row, oldest_day: row.oldest_day ?? row.cursor_day};
}
export class UsernameRepairSweeper {
	static readonly intervalMs = 30000;
	private readonly config: RepairConfig;
	private readonly now: () => number;
	private readonly retries = new Map<string, {failures: number; after: number}>();
	constructor(private readonly dependencies: Dependencies) {
		this.config = dependencies.config ?? new InstanceConfigRepository();
		this.now = dependencies.now ?? Date.now;
	}
	async cleanupHoldBucket(
		bucket: number,
		after: string | null = null,
		limit = 100,
	): Promise<{claims: Array<UsernameClaimRow>; next: string | null}> {
		const repository = this.dependencies.ownership.repository;
		repository.assertSupported();
		if (
			!Number.isInteger(bucket) ||
			bucket < 0 ||
			bucket >= 1024 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new Error('Invalid username hold index page');
		const rows = await repository.listHoldIndex(bucket, after, limit);
		const claims: Array<UsernameClaimRow> = [];
		for (const index of rows) {
			let claim = await this.dependencies.ownership.readClaimForAvailability(index.username);
			if (index.held_at.getTime() >= this.now() - 300000) {
				if (claim?.state === 'held') claims.push(claim);
				continue;
			}
			for (let retry = 0; retry < 4; retry++) {
				const wall = BigInt(Math.floor(this.now() * 1000));
				const nextTimestamp = (claim?.index_ts ?? 0n) + 2n;
				const timestamp = wall > nextTimestamp ? wall : nextTimestamp;
				// Micup: advance the authority beyond a speculative index before writing its current state.
				const moved = claim
					? await repository.casClaim(claim, {index_ts: timestamp})
					: await repository.insertClaim({
							username: index.username,
							state: 'released',
							user_id: null,
							owned_gen: null,
							op_id: null,
							prev_state: null,
							prev_blocked_until: null,
							from_hold: false,
							blocked_until: null,
							held_by: null,
							note: null,
							updated_at: new Date(this.now()),
							index_ts: timestamp,
							version: 0,
						});
				if (!moved || moved.index_ts < timestamp) {
					claim = moved;
					continue;
				}
				claim = moved;
				if (claim.state === 'held') {
					await repository.writeHoldIndex(claim);
					claims.push(claim);
				} else await repository.deleteHoldIndex(claim);
				break;
			}
		}
		return {claims, next: rows.length === limit ? rows[rows.length - 1]!.username : null};
	}
	private async repairIntent(intent: UsernameOpIntentRow): Promise<boolean> {
		if (intent.created_at.getTime() >= this.now() - 60000) return false;
		const {ownership} = this.dependencies;
		const repository = ownership.repository;
		let owner = await repository.ensureOwner(intent.user_id);
		if (owner.op_id) {
			await ownership.repair(intent.user_id);
			owner = (await repository.readOwner(intent.user_id))!;
			if (owner.op_id) return false;
		}
		// Micup: a persisted version fence prevents any delayed acquire before deleting its intent.
		const fenced = await repository.casOwner(owner, {version: owner.version + 1});
		if (!fenced || fenced.op_id !== null || fenced.version <= owner.version) return false;
		await repository.deleteIntent(intent.user_id, intent.op_id, intent.created_at, intent.bucket);
		return true;
	}
	async run(): Promise<UsernameRepairSweepResult> {
		this.dependencies.ownership.repository.assertSupported();
		const started = this.now();
		let expected = (await this.config.readUsernameRepairState()) as RepairState | null;
		let original = decode(expected);
		if (!original) {
			const initial: RepairState = {
				oldest_day: date(started - DAY_MS),
				cursor_day: date(started - DAY_MS),
				cursor_bucket: 0,
				after_user_id: null,
				after_op_id: null,
			};
			if (!(await this.config.compareAndSetUsernameRepairState(null, initial))) {
				expected = (await this.config.readUsernameRepairState()) as RepairState | null;
				original = decode(expected);
			} else {
				original = initial;
				expected = initial;
			}
		}
		if (!original) throw new Error('Username repair cursor unavailable');
		const state = {...original};
		// Micup: preserve the raw checkpoint for CAS while upgrading an older cursor in memory.
		if (state.cursor_day > date(started)) {
			state.cursor_day = state.oldest_day;
			state.cursor_bucket = 0;
			state.after_user_id = null;
			state.after_op_id = null;
		}
		let processed = 0;
		let failed = 0;
		let deferred = 0;
		let budgetExceeded = false;
		let remaining = false;
		const today = date(started);
		const expired = () => this.now() - started >= BUDGET_MS || processed >= MAX_ROWS;
		const result = () => ({processed, budgetExceeded, remaining: remaining || budgetExceeded, failed, deferred});
		while (state.cursor_day <= today) {
			if (expired()) {
				budgetExceeded = true;
				break;
			}
			const after =
				state.after_user_id === null
					? null
					: {user_id: createUserID(BigInt(state.after_user_id)), op_id: state.after_op_id!};
			const rows = await this.dependencies.ownership.repository.listIntents(
				state.cursor_day,
				state.cursor_bucket,
				after,
				Math.min(CONCURRENCY, MAX_ROWS - processed),
			);
			if (rows.length) {
				const results = await Promise.all(
					rows.map(async (row) => {
						const key = `${state.cursor_day}:${row.user_id}:${row.op_id}`;
						const prior = this.retries.get(key);
						if (prior && prior.after > this.now()) {
							deferred++;
							deferredRepairs.inc();
							return false;
						}
						try {
							const repaired = await this.repairIntent(row);
							if (!repaired && row.created_at.getTime() < this.now() - 60000)
								throw new Error('Username intent recovery was not confirmed');
							if (repaired) this.retries.delete(key);
							return repaired;
						} catch (cause) {
							failed++;
							failedRepairs.inc();
							const failures = Math.min((prior?.failures ?? 0) + 1, 8);
							const after = this.now() + Math.min(30000 * 2 ** (failures - 1), 3600000);
							if (!this.retries.has(key) && this.retries.size >= MAX_ROWS)
								this.retries.delete(this.retries.keys().next().value!);
							this.retries.set(key, {failures, after});
							Logger.warn({cause, userId: row.user_id, failures, retryAfter: after}, 'Username intent repair failed');
							return false;
						}
					}),
				);
				processed += rows.length;
				const firstRemaining = results.indexOf(false);
				const last = rows[rows.length - 1]!;
				state.after_user_id = last.user_id.toString();
				state.after_op_id = last.op_id;
				if (firstRemaining >= 0) remaining = true;
				continue;
			}
			state.after_user_id = null;
			state.after_op_id = null;
			if (state.cursor_bucket < 63) {
				state.cursor_bucket++;
				continue;
			}
			// Micup: complete days are rechecked from bucket zero before advancing beyond the close grace.
			let empty = true;
			for (let bucket = 0; bucket < 64; bucket++) {
				if (expired()) {
					budgetExceeded = true;
					empty = false;
					break;
				}
				if ((await this.dependencies.ownership.repository.listIntents(state.cursor_day, bucket, null, 1)).length) {
					empty = false;
					break;
				}
			}
			const closed = this.now() > Date.parse(`${nextDay(state.cursor_day)}T00:00:00Z`) + 3600000;
			state.cursor_bucket = 0;
			if (empty && closed && state.oldest_day === state.cursor_day) state.oldest_day = nextDay(state.cursor_day);
			if (!empty) remaining = true;
			state.cursor_day = nextDay(state.cursor_day);
			if (budgetExceeded) break;
		}
		// Micup: one checkpoint per sweep; a crash only rescans the idempotent intents since the last checkpoint.
		if (!(await this.config.compareAndSetUsernameRepairState(expected, state))) return {...result(), remaining: true};
		if (budgetExceeded) Logger.warn({processed, cursor: state}, 'Username repair sweep budget exceeded');
		return result();
	}
}
