// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {Logger} from '@app/api/Logger';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

// Micup: cosmetics, badges, boosts, follow and feed add their account
// deletion, data export and block work through these hooks, so no feature task edits UserDeletionService,
// HarvestUserData or UserRelationshipService, and an unregistered hook changes nothing.
export type UserLifecycleHookName =
	| 'cosmetics'
	| 'badges'
	| 'boosts'
	| 'follow'
	| 'feed'
	| 'shop'
	| 'referral'
	| 'micupbot'
	| 'profile';

// Runs as its own lifecycle lane job and can run more than once (lane retries, a resumed deletion): keep it idempotent.
export type UserDeletionHook = (context: {userId: UserID}) => Promise<void>;
// Returns a JSON value; the data export writes it as <name>.json. A throw fails the export attempt, which is retried.
export type UserHarvestHook = (context: {userId: UserID}) => Promise<unknown>;
export type UserBlockedHook = (context: {userId: UserID; targetId: UserID}) => Promise<void>;
// Runs after every committed user row write (UserAccountRepository). Keep it cheap: most writes are not what a hook
// looks for, and a hook failure is logged, never thrown into the write. It may run more than once for the same
// account; keep it idempotent.
export type UserAccountWriteHook = (context: {previous: UserRow | null; updated: UserRow}) => Promise<void>;
// Runs after a permanent admin ban (a zero-hour ban, stored as banned for +100 years) and a confirmed CSAM ban, once
// the sessions are closed; never after a timed ban, an unban or a user disabling their own account. It may run more
// than once for the same account; keep it idempotent.
export type UserBannedHook = (context: {userId: UserID}) => Promise<void>;
// Runs after a write that ties or unties two accounts, either way: a relationship row (friend, request, block) or a
// follow. The repository calls it after each committed write; keep it cheap and idempotent.
export type UserPairChangedHook = (context: {userId: UserID; targetId: UserID}) => Promise<void>;
// Runs after the account joins or leaves a guild (its user_guilds partition changed). It names only the account: a
// hook never fans out to the guild's members.
export type UserGuildsChangedHook = (context: {userId: UserID}) => Promise<void>;

const deletionHooks = new Map<UserLifecycleHookName, UserDeletionHook>();
const harvestHooks = new Map<UserLifecycleHookName, UserHarvestHook>();
const blockedHooks = new Map<UserLifecycleHookName, UserBlockedHook>();
const accountWriteHooks = new Map<UserLifecycleHookName, UserAccountWriteHook>();
const bannedHooks = new Map<UserLifecycleHookName, UserBannedHook>();
const pairChangedHooks = new Map<UserLifecycleHookName, UserPairChangedHook>();
const guildsChangedHooks = new Map<UserLifecycleHookName, UserGuildsChangedHook>();

function register<T>(hooks: Map<UserLifecycleHookName, T>, name: UserLifecycleHookName, hook: T): () => void {
	const previous = hooks.get(name);
	hooks.set(name, hook);
	return () => {
		if (previous) {
			hooks.set(name, previous);
		} else {
			hooks.delete(name);
		}
	};
}

export function registerUserDeletionHook(name: UserLifecycleHookName, hook: UserDeletionHook): () => void {
	return register(deletionHooks, name, hook);
}

export function registerUserHarvestHook(name: UserLifecycleHookName, hook: UserHarvestHook): () => void {
	return register(harvestHooks, name, hook);
}

export function registerUserBlockedHook(name: UserLifecycleHookName, hook: UserBlockedHook): () => void {
	return register(blockedHooks, name, hook);
}

export function registerUserAccountWriteHook(name: UserLifecycleHookName, hook: UserAccountWriteHook): () => void {
	return register(accountWriteHooks, name, hook);
}

export function registerUserBannedHook(name: UserLifecycleHookName, hook: UserBannedHook): () => void {
	return register(bannedHooks, name, hook);
}

export function registerUserPairChangedHook(name: UserLifecycleHookName, hook: UserPairChangedHook): () => void {
	return register(pairChangedHooks, name, hook);
}

export function registerUserGuildsChangedHook(name: UserLifecycleHookName, hook: UserGuildsChangedHook): () => void {
	return register(guildsChangedHooks, name, hook);
}

// One job per hook, like the owned application deletions: a failing hook never stops the account deletion, and the
// lifecycle lane retries its job (maxDeliver) until it succeeds or lands in the dead letter queue.
export async function scheduleUserDeletionHooks(
	userId: UserID,
	workerService: IWorkerService<WorkerTaskName>,
	hooks: ReadonlyMap<UserLifecycleHookName, UserDeletionHook> = deletionHooks,
): Promise<void> {
	for (const hook of hooks.keys()) {
		try {
			await workerService.addJob('processUserDeletionHook', {userId: userId.toString(), hook});
		} catch (error) {
			Logger.error({error, userId: userId.toString(), hook}, 'Failed to schedule user deletion hook');
		}
	}
}

export async function runUserDeletionHook(
	name: string,
	context: {userId: UserID},
	hooks: ReadonlyMap<string, UserDeletionHook> = deletionHooks,
): Promise<void> {
	const hook = hooks.get(name);
	if (!hook) {
		// Fail rather than skip: a hook this process never registered would otherwise leave the data behind silently.
		throw new Error(`Unknown user deletion hook ${name}`);
	}
	await hook(context);
}

export async function collectUserHarvestExtensions(
	context: {userId: UserID},
	hooks: ReadonlyMap<UserLifecycleHookName, UserHarvestHook> = harvestHooks,
): Promise<Array<{name: UserLifecycleHookName; data: unknown}>> {
	return Promise.all(Array.from(hooks, async ([name, hook]) => ({name, data: await hook(context)})));
}

// UserRelationshipService.blockUser calls this after it writes the block; blocking never fails because of a hook.
export async function onUserBlocked(
	context: {userId: UserID; targetId: UserID},
	hooks: ReadonlyMap<UserLifecycleHookName, UserBlockedHook> = blockedHooks,
): Promise<void> {
	await Promise.all(
		Array.from(hooks, async ([name, hook]) => {
			try {
				await hook(context);
			} catch (error) {
				Logger.error(
					{error, name, userId: context.userId.toString(), targetId: context.targetId.toString()},
					'User blocked hook failed',
				);
			}
		}),
	);
}

async function runLogged<C>(
	hooks: ReadonlyMap<UserLifecycleHookName, (context: C) => Promise<void>>,
	context: C,
	userId: string,
	message: string,
): Promise<void> {
	await Promise.all(
		Array.from(hooks, async ([name, hook]) => {
			try {
				await hook(context);
			} catch (error) {
				Logger.error({error, name, userId}, message);
			}
		}),
	);
}

export async function onUserAccountWritten(
	context: {previous: UserRow | null; updated: UserRow},
	hooks: ReadonlyMap<UserLifecycleHookName, UserAccountWriteHook> = accountWriteHooks,
): Promise<void> {
	await runLogged(hooks, context, context.updated.user_id.toString(), 'User account write hook failed');
}

export async function onUserBanned(
	context: {userId: UserID},
	hooks: ReadonlyMap<UserLifecycleHookName, UserBannedHook> = bannedHooks,
): Promise<void> {
	await runLogged(hooks, context, context.userId.toString(), 'User banned hook failed');
}

export async function onUserPairChanged(
	context: {userId: UserID; targetId: UserID},
	hooks: ReadonlyMap<UserLifecycleHookName, UserPairChangedHook> = pairChangedHooks,
): Promise<void> {
	await runLogged(hooks, context, context.userId.toString(), 'User pair changed hook failed');
}

export async function onUserGuildsChanged(
	context: {userId: UserID},
	hooks: ReadonlyMap<UserLifecycleHookName, UserGuildsChangedHook> = guildsChangedHooks,
): Promise<void> {
	await runLogged(hooks, context, context.userId.toString(), 'User guilds changed hook failed');
}
