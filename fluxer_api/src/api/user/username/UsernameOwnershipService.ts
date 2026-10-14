// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {UsernameClaimRow, UsernameOwnerRow} from '@app/api/database/types/UserTypes';
import {Logger} from '@app/api/Logger';
import {type APIErrorCode, APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {registerCounter} from '@fluxer/hono/src/middleware/Metrics';
import {clearOperation, holdBucket, UsernameOwnershipRepository} from './UsernameOwnershipRepository';
import type {UsernamePolicyRejection, UsernamePolicyService, UsernamePolicySnapshot} from './UsernamePolicyService';

export type UsernameClaimError =
	| 'TAKEN'
	| 'RESERVED'
	| 'BLOCKED'
	| 'RELEASE_EMBARGO'
	| 'COOLDOWN'
	| 'BUSY'
	| 'RATE_LIMITED'
	| UsernamePolicyRejection;
export const USERNAME_CLAIM_ERROR_CODES = {
	TAKEN: APIErrorCodes.USERNAME_TAKEN,
	RESERVED: APIErrorCodes.USERNAME_RESERVED,
	BLOCKED: APIErrorCodes.USERNAME_BLOCKED,
	RELEASE_EMBARGO: APIErrorCodes.USERNAME_RELEASE_EMBARGO,
	COOLDOWN: APIErrorCodes.USERNAME_COOLDOWN,
	BUSY: APIErrorCodes.USERNAME_BUSY,
	RATE_LIMITED: APIErrorCodes.USERNAME_RATE_LIMITED,
	INVALID: APIErrorCodes.USERNAME_INVALID,
	RESERVED_TERM: APIErrorCodes.USERNAME_RESERVED_TERM,
	TOO_SHORT: APIErrorCodes.USERNAME_TOO_SHORT,
	REQUIRES_ENTITLEMENT: APIErrorCodes.USERNAME_REQUIRES_ENTITLEMENT,
	UNAVAILABLE: APIErrorCodes.USERNAME_UNAVAILABLE,
} as const satisfies Record<UsernameClaimError, APIErrorCode>;
export type UsernameClaimResult =
	| {ok: true; username: string; noop: boolean}
	| {ok: false; code: UsernameClaimError; availableAt?: Date};
export interface AdminContext {
	adminId: UserID;
	reason: string;
}
export class UsernameOwnershipUnavailableError extends Error {
	readonly code = 'UNAVAILABLE';
	constructor(cause?: unknown) {
		super('Username ownership is unavailable', {cause});
	}
}
class UsernameProjectionMismatchError extends UsernameOwnershipUnavailableError {}
// Micup: a repair found an operation but could not finish it; the projection may already be complete.
export class UsernameRepairIncompleteError extends UsernameOwnershipUnavailableError {}
interface Dependencies {
	policy: Pick<
		UsernamePolicyService,
		| 'prevalidate'
		| 'readCached'
		| 'readAuthoritative'
		| 'check'
		| 'openReserveMutation'
		| 'ownsReserveMutation'
		| 'closeReserveMutation'
	>;
	repository?: UsernameOwnershipRepository;
	now?: () => number;
	clock?: () => Promise<{offsetMs: number; uncertaintyMs: number}>;
	admit?: (snapshot: UsernamePolicySnapshot) => Promise<boolean>;
	propagate: (userId: UserID) => Promise<void>;
	neutralDiscriminator: (userId: UserID) => Promise<number>;
}
const FOURTEEN_DAYS = 14 * 86400000;
const STALE_MS = 60000;
const ATTEMPTS = 4;
const projectionMismatches = registerCounter(
	'fluxer_api_username_projection_mismatch_total',
	'Username projections still inconsistent after timestamp advancement',
);
type Kind = NonNullable<UsernameOwnerRow['op_kind']>;

export class UsernameOwnershipService {
	readonly repository: UsernameOwnershipRepository;
	projectionMismatchCount = 0;
	private readonly now: () => number;
	private clockSample: {at: number; bound: number} | null = null;
	constructor(private readonly dependencies: Dependencies) {
		this.repository = dependencies.repository ?? new UsernameOwnershipRepository();
		this.now = dependencies.now ?? Date.now;
	}
	private async safeTime(): Promise<number> {
		this.repository.assertSupported();
		const start = this.now();
		if (!this.clockSample || start < this.clockSample.at || start - this.clockSample.at >= 60000) {
			try {
				const sample = this.dependencies.clock
					? await this.dependencies.clock()
					: await (async () => {
							const coordinator = await this.repository.coordinatorTime();
							const end = this.now();
							return {offsetMs: coordinator.getTime() - (start + end) / 2, uncertaintyMs: (end - start) / 2};
						})();
				const bound = Math.abs(sample.offsetMs) + sample.uncertaintyMs;
				if (!Number.isFinite(bound) || sample.uncertaintyMs < 0 || bound > 1000)
					throw new Error('Unsafe coordinator clock');
				this.clockSample = {at: this.now(), bound};
			} catch (cause) {
				this.clockSample = null;
				Logger.warn({cause}, 'Username ownership coordinator clock is unavailable');
				throw new UsernameOwnershipUnavailableError(cause);
			}
		}
		return this.now() - this.clockSample.bound;
	}
	claimSelf(userId: UserID, name: string): Promise<UsernameClaimResult> {
		return this.allocate(userId, name, 'self');
	}
	adminAssign(name: string, userId: UserID, ctx: AdminContext): Promise<UsernameClaimResult> {
		this.assertReason(ctx);
		return this.allocate(userId, name, 'admin_assign', ctx);
	}
	private assertReason(ctx: AdminContext): void {
		if (!ctx.reason.trim()) throw new Error('Admin reason is required');
	}
	private async allocate(
		userId: UserID,
		rawName: string,
		kind: Kind,
		ctx?: AdminContext,
		extras: Partial<UsernameOwnerRow> = {},
	): Promise<UsernameClaimResult> {
		const name = rawName.toLowerCase();
		const actor = {kind: 'human' as const, userId};
		const isAllocation = kind === 'self' || kind === 'admin_assign';
		let acquired: UsernameOwnerRow | null = null;
		let admittedRevision: number | null = null;
		try {
			if (isAllocation) {
				const rejection = await this.dependencies.policy.prevalidate(name, actor, kind === 'admin_assign');
				if (rejection) return {ok: false, code: rejection};
				// Micup: admission runs before any Cassandra work, so a rejected attempt costs only one Valkey lease.
				const cached = await this.dependencies.policy.readCached();
				admittedRevision = cached.policyRevision;
				if (cached.migration.state !== 'selecting') return {ok: false, code: 'UNAVAILABLE'};
				if (cached.admission.paused || !this.dependencies.admit || !(await this.dependencies.admit(cached)))
					return {ok: false, code: 'RATE_LIMITED'};
			}
			const safeNow = await this.safeTime();
			for (let retry = 0; retry < 3; retry++) {
				const snap = await this.dependencies.policy.readAuthoritative();
				if ((isAllocation || kind === 'moderation') && snap.migration.state !== 'selecting')
					return {ok: false, code: 'UNAVAILABLE'};
				// Micup: the admission lease is valid only for the policy revision it was granted under.
				if (isAllocation && (snap.admission.paused || snap.policyRevision !== admittedRevision))
					return {ok: false, code: 'RATE_LIMITED'};
				let owner = await this.repository.readOwner(userId);
				if (owner?.op_id) {
					await this.repair(userId);
					continue;
				}
				if (owner?.status === 'deleted') return {ok: false, code: 'BLOCKED'};
				const projection = await this.repository.readProjection(userId);
				if (!projection || projection.bot || projection.system) return {ok: false, code: 'UNAVAILABLE'};
				if (!owner) {
					owner = await this.repository.ensureOwner(userId);
					if (owner.version !== 0 || owner.op_id !== null || owner.seq !== 0n) continue;
				}
				if (isAllocation && owner.username === name) return {ok: true, username: name, noop: true};
				const entitlement = await this.repository.readEntitlement(userId);
				if (isAllocation) {
					const rejection = this.dependencies.policy.check(
						name,
						actor,
						kind === 'admin_assign',
						snap,
						entitlement?.revoked_at === null ? entitlement.username : null,
					);
					if (rejection) return {ok: false, code: rejection};
					if (
						kind === 'self' &&
						owner.selected_at !== null &&
						owner.status !== 'reselect_required' &&
						owner.free_change_used &&
						owner.changed_at &&
						owner.changed_at.getTime() + FOURTEEN_DAYS > safeNow
					)
						return {ok: false, code: 'COOLDOWN', availableAt: new Date(owner.changed_at.getTime() + FOURTEEN_DAYS)};
				}
				const opId = randomUUID();
				const at = new Date(this.now());
				const ts = this.nextTimestamp(owner.last_proj_ts);
				const op: Partial<UsernameOwnerRow> = {
					...extras,
					seq: owner.seq + 1n,
					last_proj_ts: ts,
					op_id: opId,
					op_seq: owner.seq + 1n,
					op_kind: kind,
					op_phase: 'pending',
					op_new: isAllocation ? name : null,
					op_old: owner.username,
					op_old_gen: owner.owned_gen,
					op_at: at,
					op_proj_ts: ts,
					op_policy_rev: snap.policyRevision,
					op_dict_gen: snap.dictionary.gen,
					op_grant_ref:
						kind === 'self' && entitlement?.username === name && entitlement.revoked_at === null
							? entitlement.grant_ref
							: null,
					op_old_grant_ref: entitlement?.bound_gen === owner.owned_gen ? entitlement.grant_ref : null,
					op_old_index_username: projection.username,
					op_old_index_disc: projection.discriminator,
					op_ent_version: entitlement?.version ?? null,
					op_admin_id: ctx?.adminId ?? null,
					op_reason: ctx?.reason ?? null,
				};
				await this.repository.writeIntent(userId, opId, at);
				const acknowledged = this.now();
				// Micup: a paused caller may not acquire from an intent whose acknowledgement expired.
				const acquireNow = await this.safeTime();
				if (this.now() - acknowledged > 30000 || this.now() < acknowledged || at.getTime() < acquireNow - STALE_MS) {
					await this.repository.deleteIntent(userId, opId, at);
					return {ok: false, code: 'BUSY'};
				}
				owner = (await this.repository.casOwner(owner, op))!;
				if (owner?.op_id !== opId) {
					await this.repository.deleteIntent(userId, opId, at);
					return {ok: false, code: 'BUSY'};
				}
				acquired = owner;
				if (isAllocation) {
					const claimFailure = await this.acquireClaim(owner);
					if (claimFailure) {
						await this.abort(owner);
						return claimFailure;
					}
				}
				const committed = await this.commit(owner);
				if (!committed) {
					await this.abort(owner);
					return {ok: false, code: 'UNAVAILABLE'};
				}
				await this.finalize(committed);
				return {ok: true, username: name, noop: false};
			}
			return {ok: false, code: 'BUSY'};
		} catch (cause) {
			// Micup: acquired intents remain discoverable if synchronous recovery is unavailable.
			if (acquired && !(cause instanceof UsernameProjectionMismatchError)) {
				try {
					await this.repair(userId);
				} catch {
					/* Micup: the persistent intent is retried by the sweeper. */
				}
			}
			if (!isAllocation) throw new UsernameOwnershipUnavailableError(cause);
			return {ok: false, code: 'UNAVAILABLE'};
		}
	}
	private nextTimestamp(previous: bigint): bigint {
		const wall = BigInt(Math.floor(this.now() * 1000));
		return wall > previous ? wall : previous + 1n;
	}
	private async acquireClaim(owner: UsernameOwnerRow): Promise<Extract<UsernameClaimResult, {ok: false}> | null> {
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const now = await this.safeTime();
			let claim = await this.repository.readClaim(owner.op_new!);
			if (
				claim?.op_id === owner.op_id &&
				claim.user_id === owner.user_id &&
				claim.owned_gen === owner.op_seq &&
				(claim.state === 'pending' || claim.state === 'assigned')
			)
				return null;
			if (claim?.state === 'pending') {
				claim = await this.readClaimForAvailability(claim.username);
				if (claim?.state === 'pending') return {ok: false, code: 'BUSY'};
			}
			if (claim?.state === 'banned') return {ok: false, code: 'BLOCKED'};
			if (claim?.state === 'assigned') return {ok: false, code: 'TAKEN'};
			if (claim?.blocked_until && claim.blocked_until.getTime() > now)
				return {ok: false, code: 'RELEASE_EMBARGO', availableAt: claim.blocked_until};
			if (claim?.state === 'held' && owner.op_kind !== 'admin_assign') return {ok: false, code: 'RESERVED'};
			const next: UsernameClaimRow = {
				username: owner.op_new!,
				state: 'pending',
				user_id: owner.user_id,
				owned_gen: owner.op_seq,
				op_id: owner.op_id,
				prev_state: claim?.state ?? 'none',
				prev_blocked_until: claim?.blocked_until ?? null,
				from_hold: false,
				blocked_until: claim?.blocked_until ?? null,
				held_by: claim?.state === 'held' ? claim.held_by : null,
				note: claim?.note ?? null,
				updated_at: owner.op_at!,
				version: (claim?.version ?? -1) + 1,
				index_ts: claim?.index_ts ?? 0n,
			};
			if (claim) {
				const {username: _, ...values} = next;
				claim = await this.repository.casClaim(claim, values);
			} else claim = await this.repository.insertClaim(next);
			if (
				claim?.op_id === owner.op_id &&
				claim.state === 'pending' &&
				claim.user_id === owner.user_id &&
				claim.owned_gen === owner.op_seq
			)
				return null;
		}
		return {ok: false, code: 'BUSY'};
	}
	private async commit(initial: UsernameOwnerRow): Promise<UsernameOwnerRow | null> {
		let row: UsernameOwnerRow | null = initial;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			if (row?.op_id !== initial.op_id || row.op_phase === 'aborted') return null;
			if (row.op_phase === 'committed') return row;
			const snap = await this.dependencies.policy.readAuthoritative();
			const now = await this.safeTime();
			if (
				snap.policyRevision !== row.op_policy_rev ||
				snap.dictionary.gen !== row.op_dict_gen ||
				(row.op_new && snap.migration.state !== 'selecting') ||
				(row.op_kind === 'moderation' && snap.migration.state !== 'selecting') ||
				row.op_at!.getTime() < now - STALE_MS
			)
				return null;
			const values: Partial<UsernameOwnerRow> = {
				op_phase: 'committed',
				owned_gen: row.op_seq!,
				username: row.op_new,
				status: row.op_kind === 'delete' ? 'deleted' : row.op_kind === 'moderation' ? 'reselect_required' : 'active',
				reselect_reason: row.op_kind === 'moderation' ? row.op_reason : null,
			};
			if (row.op_new) {
				if (row.selected_at === null) values.selected_at = row.op_at;
				// A selection made under a forced reselect uses up the one change that is otherwise free of waiting.
				if (row.op_kind === 'self' && (row.selected_at !== null || row.status === 'reselect_required')) {
					values.free_change_used = true;
					values.changed_at = row.op_at;
				}
			}
			row = await this.repository.casOwner(row, values);
		}
		return null;
	}
	private async restoreClaim(initial: UsernameClaimRow): Promise<void> {
		let row: UsernameClaimRow | null = initial;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			if (!row || row.op_id !== initial.op_id || row.state !== 'pending') {
				if (row?.state === 'held') await this.repository.writeHoldIndex(row);
				return;
			}
			row =
				row.prev_state === 'none'
					? await this.repository.deleteClaim(row)
					: await this.repository.casClaim(row, {
							state: row.prev_state as 'held' | 'released',
							blocked_until: row.prev_blocked_until,
							user_id: null,
							owned_gen: null,
							op_id: null,
							prev_state: null,
							prev_blocked_until: null,
							from_hold: false,
							...(row.prev_state === 'held' ? {index_ts: this.nextTimestamp(row.index_ts)} : {}),
						});
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async abort(initial: UsernameOwnerRow): Promise<void> {
		let row = await this.repository.readOwner(initial.user_id);
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			if (!row || row.op_id !== initial.op_id) return;
			if (row.op_phase === 'committed') {
				await this.finalize(row);
				return;
			}
			if (row.op_phase === 'pending') {
				row = await this.repository.casOwner(row, {op_phase: 'aborted'});
				continue;
			}
			if (row.op_new) {
				const claim = await this.repository.readClaim(row.op_new);
				if (claim?.state === 'pending' && claim.op_id === row.op_id) await this.restoreClaim(claim);
				else if (claim?.state === 'held') await this.repository.writeHoldIndex(claim);
			}
			const done = await this.repository.casOwner(row, clearOperation());
			if (done?.op_id !== row.op_id) {
				await this.repository.deleteIntent(row.user_id, row.op_id!, row.op_at!);
				return;
			}
			row = done;
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async finalizeClaim(owner: UsernameOwnerRow): Promise<void> {
		if (!owner.op_new) return;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const claim = await this.repository.readClaim(owner.op_new);
			if (claim?.state === 'assigned' && claim.user_id === owner.user_id && claim.owned_gen === owner.op_seq) return;
			if (
				claim?.state !== 'pending' ||
				claim.op_id !== owner.op_id ||
				claim.user_id !== owner.user_id ||
				claim.owned_gen !== owner.op_seq
			)
				throw new UsernameOwnershipUnavailableError();
			await this.repository.casClaim(claim, {
				state: 'assigned',
				held_by: owner.op_kind === 'admin_assign' ? owner.op_admin_id : null,
				from_hold: claim.prev_state === 'held',
				prev_state: null,
				prev_blocked_until: null,
				updated_at: owner.op_at!,
			});
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async finalizeEntitlement(owner: UsernameOwnerRow): Promise<void> {
		if (!owner.op_new || (!owner.op_grant_ref && !(owner.op_kind === 'admin_assign' && owner.op_new.length <= 3)))
			return;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const row = await this.repository.readEntitlement(owner.user_id);
			const grant = owner.op_kind === 'admin_assign' ? owner.op_id : owner.op_grant_ref;
			if (row?.grant_ref === grant && row.bound_gen === owner.op_seq && row.revoked_at === null) return;
			if (owner.op_kind === 'self') {
				if (!row || row.grant_ref !== grant || row.bound_gen !== null || row.revoked_at !== null)
					throw new UsernameOwnershipUnavailableError();
				await this.repository.writeEntitlement(row, {...row, bound_gen: owner.op_seq});
			} else {
				if ((row?.version ?? null) !== owner.op_ent_version) throw new UsernameOwnershipUnavailableError();
				await this.repository.writeEntitlement(row, {
					user_id: owner.user_id,
					username: owner.op_new,
					source: 'admin',
					grant_ref: owner.op_id!,
					bound_gen: owner.op_seq,
					created_at: owner.op_at!,
					revoked_at: null,
					version: (row?.version ?? -1) + 1,
				});
			}
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async releaseOld(owner: UsernameOwnerRow): Promise<void> {
		if (!owner.op_old || owner.op_old === owner.op_new) return;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const old = await this.repository.readClaim(owner.op_old);
			if (old?.state !== 'assigned' || old.user_id !== owner.user_id || old.owned_gen !== owner.op_old_gen) return;
			const held = old.from_hold && (owner.op_kind === 'self' || owner.op_kind === 'admin_assign');
			const indexTs = held ? this.nextTimestamp(old.index_ts) : old.index_ts;
			const next = {
				...old,
				state: owner.op_ban_old ? ('banned' as const) : held ? ('held' as const) : ('released' as const),
				user_id: null,
				owned_gen: null,
				op_id: null,
				blocked_until: new Date(owner.op_at!.getTime() + FOURTEEN_DAYS),
				updated_at: owner.op_at!,
				index_ts: indexTs,
			};
			if (held) await this.repository.writeHoldIndex(next);
			await this.repository.casClaim(old, next);
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async revokeOld(owner: UsernameOwnerRow): Promise<void> {
		if (!owner.op_old_grant_ref) return;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const old = await this.repository.readEntitlement(owner.user_id);
			if (
				!old ||
				old.grant_ref !== owner.op_old_grant_ref ||
				old.bound_gen !== owner.op_old_gen ||
				old.revoked_at !== null
			)
				return;
			await this.repository.writeEntitlement(old, {...old, revoked_at: owner.op_at});
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private identity(owner: UsernameOwnerRow): {
		username: string;
		discriminator: number;
		state: 'selected' | 'reselect_required' | null;
	} {
		if (owner.op_kind === 'delete') return {...JSON.parse(owner.op_anon_identity!), state: null};
		if (owner.op_kind === 'moderation')
			return {username: 'kullanici', discriminator: owner.op_neutral_disc!, state: 'reselect_required'};
		return {username: owner.op_new!, discriminator: 0, state: 'selected'};
	}
	private async project(owner: UsernameOwnerRow): Promise<void> {
		let row = owner;
		const identity = this.identity(row);
		let advanced = false;
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const current = await this.repository.readOwner(row.user_id);
			if (current?.op_id !== row.op_id || current.op_phase !== 'committed') return;
			row = current;
			await this.repository.writeProjection(row, identity);
			const projection = await this.repository.readProjection(row.user_id);
			const newIndex =
				row.op_kind === 'delete' ||
				(await this.repository.hasIndex(row.user_id, identity.username, identity.discriminator));
			const sameKey =
				row.op_old_index_username?.toLowerCase() === identity.username.toLowerCase() &&
				row.op_old_index_disc === identity.discriminator;
			const oldIndexAbsent =
				row.op_old_index_username === null ||
				row.op_old_index_disc === null ||
				(sameKey && row.op_kind !== 'delete') ||
				!(await this.repository.hasIndex(row.user_id, row.op_old_index_username, row.op_old_index_disc));
			if (
				projection?.username === identity.username &&
				projection.discriminator === identity.discriminator &&
				(projection.username_state ?? null) === identity.state &&
				projection.identity_version === row.op_seq &&
				newIndex &&
				oldIndexAbsent
			) {
				await this.dependencies.propagate(row.user_id);
				return;
			}
			if (advanced) {
				this.projectionMismatchCount++;
				projectionMismatches.inc();
				Logger.warn({userId: row.user_id, opId: row.op_id}, 'Username projection mismatch after timestamp advance');
				throw new UsernameProjectionMismatchError();
			}
			const largest = [
				projection?.username_time ?? 0n,
				projection?.discriminator_time ?? 0n,
				projection?.state_time ?? 0n,
				projection?.identity_time ?? 0n,
				row.op_proj_ts!,
			].reduce((a, b) => (a > b ? a : b));
			// Micup: key-only indexes have no WRITETIME; pass the maximum permitted legacy clock skew.
			const indexBound = BigInt(Math.floor(this.now() * 1000)) + 1000001n;
			const timestamp = (!newIndex || !oldIndexAbsent) && indexBound > largest ? indexBound : largest + 1n;
			const moved = await this.repository.casOwner(row, {op_proj_ts: timestamp, last_proj_ts: timestamp});
			if (moved?.op_id !== row.op_id) return;
			advanced = moved.op_proj_ts! >= timestamp;
			row = moved;
		}
		throw new UsernameOwnershipUnavailableError();
	}
	private async finalize(owner: UsernameOwnerRow): Promise<void> {
		await this.finalizeClaim(owner);
		await this.finalizeEntitlement(owner);
		await this.releaseOld(owner);
		await this.revokeOld(owner);
		await this.project(owner);
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const current = await this.repository.readOwner(owner.user_id);
			if (!current || current.op_id !== owner.op_id) {
				await this.repository.deleteIntent(owner.user_id, owner.op_id!, owner.op_at!);
				return;
			}
			if (current.op_phase !== 'committed') throw new UsernameOwnershipUnavailableError();
			await this.repository.casOwner(current, clearOperation());
		}
		throw new UsernameOwnershipUnavailableError();
	}
	async repair(userId: UserID): Promise<boolean> {
		const now = await this.safeTime();
		const owner = await this.repository.readOwner(userId);
		if (!owner?.op_id) return false;
		try {
			if (owner.op_phase === 'committed') await this.finalize(owner);
			else if (owner.op_phase === 'aborted' || owner.op_at!.getTime() < now - STALE_MS) await this.abort(owner);
		} catch (cause) {
			throw new UsernameRepairIncompleteError(cause);
		}
		return true;
	}
	async forceReselect(userId: UserID, banName: boolean, ctx: AdminContext): Promise<void> {
		this.assertReason(ctx);
		if ((await this.dependencies.policy.readAuthoritative()).migration.state !== 'selecting')
			throw new UsernameOwnershipUnavailableError();
		const discriminator = await this.dependencies.neutralDiscriminator(userId);
		if (!Number.isInteger(discriminator) || discriminator <= 0 || discriminator > 9999)
			throw new Error('Invalid neutral discriminator');
		const result = await this.allocate(userId, '', 'moderation', ctx, {
			op_ban_old: banName,
			op_neutral_disc: discriminator,
		});
		if (!result.ok) throw new UsernameOwnershipUnavailableError();
	}
	async deleteAccount(userId: UserID, anonymizedIdentity: {username: string; discriminator: number}): Promise<void> {
		await this.safeTime();
		const owner = await this.repository.readOwner(userId);
		if (owner?.status === 'deleted') {
			await this.repair(userId);
			return;
		}
		if (
			!anonymizedIdentity.username ||
			!Number.isInteger(anonymizedIdentity.discriminator) ||
			anonymizedIdentity.discriminator < 0 ||
			anonymizedIdentity.discriminator > 9999
		)
			throw new Error('Invalid anonymized identity');
		const result = await this.allocate(userId, '', 'delete', undefined, {
			op_anon_identity: JSON.stringify(anonymizedIdentity),
			op_ban_old: false,
		});
		if (!result.ok) throw new UsernameOwnershipUnavailableError();
	}
	async getPrivateStatus(userId: UserID): Promise<{
		state: 'legacy' | 'selected' | 'reselect_required';
		changeAvailableAt: Date | null;
		freeChangeAvailable: boolean;
	}> {
		const row = await this.repository.readOwner(userId);
		return {
			state: row?.status === 'reselect_required' ? 'reselect_required' : row?.username ? 'selected' : 'legacy',
			changeAvailableAt:
				row?.free_change_used && row.changed_at && row.status !== 'reselect_required'
					? new Date(row.changed_at.getTime() + FOURTEEN_DAYS)
					: null,
			freeChangeAvailable:
				row?.status !== 'deleted' && (!row?.selected_at || row.status === 'reselect_required' || !row.free_change_used),
		};
	}
	async resolveBareName(name: string): Promise<UserID | null> {
		const canonical = name.toLowerCase();
		if (!/^[a-z0-9_]{1,32}$/.test(canonical)) return null;
		const claim = await this.repository.readClaim(canonical);
		return claim?.state === 'assigned' ? claim.user_id : null;
	}
	async readClaimForAvailability(name: string): Promise<UsernameClaimRow | null> {
		const now = await this.safeTime();
		const canonical = name.toLowerCase();
		if (!/^[a-z0-9_]{1,32}$/.test(canonical)) throw new Error('Invalid username claim key');
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const claim = await this.repository.readClaim(canonical);
			if (claim?.state !== 'pending') return claim;
			const owner = claim.user_id === null ? null : await this.repository.readOwner(claim.user_id);
			if (owner?.op_id === claim.op_id) {
				if (owner.op_phase === 'committed') await this.finalizeClaim(owner);
				else if (owner.op_phase === 'pending' && owner.op_at!.getTime() >= now - STALE_MS) return claim;
				else await this.abort(owner);
			} else await this.restoreClaim(claim);
		}
		throw new UsernameOwnershipUnavailableError();
	}
	async listReservations(bucket: number, cursor: string | null, limit: number) {
		if (
			!Number.isInteger(bucket) ||
			bucket < 0 ||
			bucket > 1023 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			(cursor !== null && (!/^[a-z0-9_]{1,32}$/.test(cursor) || holdBucket(cursor) !== bucket))
		)
			throw new Error('Invalid reservation page');
		const rows = await this.repository.listHoldIndex(bucket, cursor, limit + 1);
		const page = rows.slice(0, limit);
		const items = [];
		for (const row of page) {
			const claim = await this.readClaimForAvailability(row.username);
			if (!claim) continue;
			if (claim.state !== 'held' && !(claim.state === 'pending' && claim.prev_state === 'held')) {
				// Micup: the durable claim stamp cannot erase a later hold; absent claims have no safe cleanup stamp.
				if (row.held_at.getTime() + 300_000 < this.now()) await this.repository.deleteHoldIndex(claim);
				continue;
			}
			items.push({
				username: claim.username,
				state: claim.state,
				user_id: claim.user_id?.toString() ?? null,
				owned_gen: claim.owned_gen?.toString() ?? null,
				held_by: claim.held_by?.toString() ?? null,
				note: claim.note ?? null,
				blocked_until: claim.blocked_until?.toISOString() ?? null,
				updated_at: claim.updated_at.toISOString(),
				index_ts: claim.index_ts.toString(),
			});
		}
		return {bucket, items, next_cursor: rows.length > limit ? page.at(-1)!.username : null};
	}
	async adminHold(name: string, ctx: AdminContext & {note: string}): Promise<UsernameClaimResult> {
		this.assertReason(ctx);
		const canonical = name.toLowerCase();
		if (!/^[a-z0-9_]{1,32}$/.test(canonical)) return {ok: false, code: 'INVALID'};
		// Micup: reservations exist only once preparation has closed legacy identity writes.
		const snap = await this.dependencies.policy.readCached().catch(() => null);
		if (!snap || snap.migration.state === 'legacy') return {ok: false, code: 'UNAVAILABLE'};
		await this.safeTime();
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const old = await this.readClaimForAvailability(canonical);
			if (old?.state === 'held') {
				await this.repository.writeHoldIndex(old);
				return {ok: true, username: canonical, noop: true};
			}
			if (old && old.state !== 'released') return {ok: false, code: old.state === 'banned' ? 'BLOCKED' : 'TAKEN'};
			const next: UsernameClaimRow = {
				username: canonical,
				state: 'held',
				user_id: null,
				owned_gen: null,
				op_id: null,
				prev_state: null,
				prev_blocked_until: null,
				from_hold: false,
				blocked_until: old?.blocked_until ?? null,
				held_by: ctx.adminId,
				note: ctx.note,
				updated_at: new Date(this.now()),
				index_ts: this.nextTimestamp(old?.index_ts ?? 0n),
				version: (old?.version ?? -1) + 1,
			};
			await this.repository.writeHoldIndex(next);
			const stored = old ? await this.repository.casClaim(old, next) : await this.repository.insertClaim(next);
			if (stored?.state === 'held' && stored.index_ts === next.index_ts)
				return {ok: true, username: canonical, noop: false};
			await this.reconcileHoldIndex(canonical, next.index_ts);
		}
		return {ok: false, code: 'BUSY'};
	}
	private async reconcileHoldIndex(name: string, speculativeTimestamp: bigint): Promise<void> {
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const current = await this.repository.readClaim(name);
			if (!current) return;
			let row = current;
			// Micup: a losing index-first write must not outrun the durable claim timestamp.
			if (row.index_ts <= speculativeTimestamp) {
				const moved = await this.repository.casClaim(row, {index_ts: speculativeTimestamp + 1n});
				if (!moved || moved.index_ts <= speculativeTimestamp) continue;
				row = moved;
			}
			if (row.state === 'held') await this.repository.writeHoldIndex(row);
			else await this.repository.deleteHoldIndex(row);
			return;
		}
		throw new UsernameOwnershipUnavailableError();
	}
	async adminUnhold(name: string, ctx: AdminContext): Promise<void> {
		this.assertReason(ctx);
		await this.safeTime();
		// Micup: while preparing, a release runs inside the reservation fence that the start CAS checks;
		// a release that crashes leaves the fence open and the start closed until it is run again.
		const fence = await this.dependencies.policy.openReserveMutation();
		await this.releaseHold(name, fence);
		if (fence !== null) await this.dependencies.policy.closeReserveMutation(fence);
	}
	private async releaseHold(name: string, fence: number | null): Promise<void> {
		for (let retry = 0; retry < ATTEMPTS; retry++) {
			const old = await this.readClaimForAvailability(name);
			if (!old) return;
			if (old.state !== 'held') {
				if (old.state === 'released') await this.repository.deleteHoldIndex(old);
				return;
			}
			// Micup: a later release that took over the fence also owns the decision to close it.
			if (fence !== null && !(await this.dependencies.policy.ownsReserveMutation(fence)))
				throw new UsernameOwnershipUnavailableError();
			const next = await this.repository.casClaim(old, {
				state: 'released',
				held_by: null,
				note: null,
				updated_at: new Date(this.now()),
				index_ts: this.nextTimestamp(old.index_ts),
			});
			if (next?.state === 'released' && next.index_ts > old.index_ts) {
				await this.repository.deleteHoldIndex(next);
				return;
			}
		}
		throw new UsernameOwnershipUnavailableError();
	}
}
