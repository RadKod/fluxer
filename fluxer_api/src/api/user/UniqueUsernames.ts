// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomInt} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getCacheService, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {USERNAME_MODE_DISCRIMINATOR} from '@app/api/user/UserTag';
import {USERNAME_CLAIM_ERROR_CODES} from '@app/api/user/username/UsernameOwnershipService';
import {UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {DELETED_USER_USERNAME, UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import {ms} from 'itty-time';

type UsernameLookup = Pick<UserRepository, 'findUsersByUsername'>;

interface UniqueUsernameDeps {
	users: UsernameLookup;
	cache: ICacheService;
}

export interface UsernameReservation {
	readonly username: string;
	release(): Promise<void>;
}

export interface ParsedLoginHandle {
	username: string;
	discriminator: number | null;
}

const USERNAME_MAX_LENGTH = 32;
const RESERVATION_TTL_SECONDS = 15;
const RESERVATION_WAIT_MS = ms('5 seconds');
const RESERVATION_RETRY_MS = 50;
const DERIVE_ATTEMPTS = 20;
const LOGIN_HANDLE_REGEX = /^([a-zA-Z0-9_]{1,32})(?:#(\d{1,4}))?$/;

export async function readUsernameMigration() {
	try {
		return await getInstanceConfigRepository().getUsernameMigrationConfig();
	} catch (cause) {
		throw new FluxerError({
			code: APIErrorCodes.USERNAME_UNAVAILABLE,
			status: 503,
			cause: cause instanceof Error ? cause : undefined,
		});
	}
}

export async function resolveUsernameHandle(
	users: Pick<IUserRepository, 'findUnique' | 'findByUsernameDiscriminator'>,
	input: string,
	discriminator?: number,
): Promise<User | null> {
	const parsed = parseLoginHandle(input.replace(/^@/, ''));
	if (
		!parsed ||
		(parsed.discriminator !== null && discriminator !== undefined && parsed.discriminator !== discriminator)
	)
		return null;
	const tag = discriminator ?? parsed.discriminator;
	if (tag !== null && tag !== undefined) {
		if (!Number.isInteger(tag) || tag < 0 || tag > 9999) return null;
		const user = await users.findByUsernameDiscriminator(parsed.username, tag);
		return user?.usernameState === 'selected' ? null : user;
	}
	// No name is claimed before the migration starts, so a bare name cannot resolve yet.
	if ((await readUsernameMigration()).state === 'legacy') return null;
	try {
		const id = await getUsernameOwnershipService().resolveBareName(parsed.username.toLowerCase());
		return id === null ? null : await users.findUnique(id);
	} catch (cause) {
		throw new FluxerError({
			code: APIErrorCodes.USERNAME_UNAVAILABLE,
			status: 503,
			cause: cause instanceof Error ? cause : undefined,
		});
	}
}

interface CachedUsernameClaim {
	state: 'absent' | 'pending' | 'assigned' | 'held' | 'released' | 'banned';
	userId: string | null;
	blockedUntil: string | null;
}

export async function checkUsernameClaimAvailability(
	name: string,
	userId: UserID | null,
): Promise<{
	taken: boolean;
	reason: string | null;
	available_at: string | null;
}> {
	const rejected = (reason: string, available_at: string | null = null) => ({taken: true, reason, available_at});
	const canonical = name.toLowerCase();
	if (!/^[a-z0-9_]{1,32}$/.test(canonical)) return rejected('INVALID');
	try {
		const policy = new UsernamePolicyService();
		const snapshot = await policy.readCached();
		if (snapshot.migration.state !== 'selecting') return rejected('UNAVAILABLE');
		const ownership = getUsernameOwnershipService();
		const entitlement =
			userId !== null && canonical.length <= 3 && snapshot.tiers[canonical.length as 1 | 2 | 3] !== 'public'
				? await ownership.repository.readEntitlement(userId)
				: null;
		const reason = policy.check(
			canonical,
			{kind: 'human', userId: userId ?? createUserID(0n)},
			false,
			snapshot,
			entitlement?.revoked_at == null ? (entitlement?.username ?? null) : null,
		);
		if (reason) return rejected(reason);
		const cache = getCacheService();
		const key = `username-availability:${canonical}`;
		let claim: CachedUsernameClaim | null = null;
		try {
			claim = await cache.get<CachedUsernameClaim>(key);
		} catch {
			/* Micup: cache is advisory. */
		}
		if (claim === null) {
			const row = await ownership.readClaimForAvailability(canonical);
			claim = {
				state: row?.state ?? 'absent',
				userId: row?.user_id?.toString() ?? null,
				blockedUntil: row?.blocked_until?.toISOString() ?? null,
			};
			if (claim.state !== 'pending') {
				try {
					await cache.set(key, claim, 5);
				} catch {
					/* Micup: cache is advisory. */
				}
			}
		}
		if (claim?.state === 'assigned' && claim.userId !== userId?.toString()) return rejected('TAKEN');
		if (claim?.state === 'held') return rejected('RESERVED');
		if (claim?.state === 'banned') return rejected('BLOCKED');
		if (claim?.state === 'pending') return rejected('BUSY');
		if (claim?.state === 'released' && claim.blockedUntil && Date.parse(claim.blockedUntil) > Date.now() - 1000)
			return rejected('RELEASE_EMBARGO', claim.blockedUntil);
		if (userId !== null && !(claim?.state === 'assigned' && claim.userId === userId.toString())) {
			const status = await ownership.getPrivateStatus(userId);
			if (
				!status.freeChangeAvailable &&
				status.changeAvailableAt &&
				status.changeAvailableAt.getTime() > Date.now() - 1000
			)
				return rejected('COOLDOWN', status.changeAvailableAt.toISOString());
		}
		return {taken: false, reason: null, available_at: null};
	} catch {
		return rejected('UNAVAILABLE');
	}
}

export async function assertBotUsernameAvailable(userId: UserID | null, name: string, isAdmin = false): Promise<void> {
	try {
		const canonical = name.toLowerCase();
		const policy = new UsernamePolicyService();
		const cached = await policy.readCached();
		// Micup: before migration and the first dictionary, bot names keep upstream validation and skip ownership reads.
		const upstream = cached.migration.state === 'legacy' && cached.dictionary.gen === 0;
		const snapshot = upstream ? cached : await policy.readAuthoritative();
		const ownership = upstream ? null : getUsernameOwnershipService();
		const entitlement = userId === null || !ownership ? null : await ownership.repository.readEntitlement(userId);
		const code = policy.check(
			canonical,
			{kind: 'bot', userId},
			isAdmin,
			snapshot,
			entitlement?.revoked_at == null ? (entitlement?.username ?? null) : null,
		);
		if (code)
			throw new FluxerError({code: USERNAME_CLAIM_ERROR_CODES[code], status: code === 'UNAVAILABLE' ? 503 : 409});
		if (!ownership) return;
		const claim = await ownership.readClaimForAvailability(canonical);
		const reason =
			claim?.state === 'held'
				? 'RESERVED'
				: claim?.state === 'banned'
					? 'BLOCKED'
					: claim?.state === 'assigned'
						? 'TAKEN'
						: claim?.state === 'pending'
							? 'BUSY'
							: claim?.state === 'released' && claim.blocked_until && claim.blocked_until.getTime() > Date.now() - 1000
								? 'RELEASE_EMBARGO'
								: null;
		if (reason)
			throw new FluxerError({
				code: USERNAME_CLAIM_ERROR_CODES[reason],
				status: 409,
				data: reason === 'RELEASE_EMBARGO' ? {available_at: claim!.blocked_until!.toISOString()} : undefined,
			});
	} catch (cause) {
		if (cause instanceof FluxerError) throw cause;
		throw new FluxerError({
			code: APIErrorCodes.USERNAME_UNAVAILABLE,
			status: 503,
			cause: cause instanceof Error ? cause : undefined,
		});
	}
}

function usernameTakenError(): InputValidationError {
	return InputValidationError.fromCode('username', ValidationErrorCodes.USERNAME_ALREADY_TAKEN);
}

export function assertNoDiscriminatorChange(requested: number | undefined, current: number): void {
	if (requested === undefined || requested === current || requested === USERNAME_MODE_DISCRIMINATOR) return;
	throw InputValidationError.fromCode('discriminator', ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE);
}

export function parseLoginHandle(input: string): ParsedLoginHandle | null {
	const match = LOGIN_HANDLE_REGEX.exec(input.trim());
	if (!match) return null;
	return {
		username: match[1]!,
		discriminator: match[2] === undefined ? null : Number.parseInt(match[2], 10),
	};
}

function isPerson(user: User): boolean {
	return !user.isBot && (user.flags & UserFlags.DELETED) === 0n;
}

async function findUsernameHolders(users: UsernameLookup, username: string): Promise<Array<User>> {
	const usernameLower = username.toLowerCase();
	const holders = new Map<UserID, User>();
	for (const user of await users.findUsersByUsername(username)) {
		if (user.username.toLowerCase() === usernameLower) holders.set(user.id, user);
	}
	return [...holders.values()];
}

async function findPeopleByUsername(users: UsernameLookup, username: string): Promise<Array<User>> {
	return (await findUsernameHolders(users, username)).filter(isPerson);
}

export async function findPersonByLoginHandle(
	users: UsernameLookup & Pick<IUserRepository, 'findUnique' | 'findByUsernameDiscriminator'>,
	handle: ParsedLoginHandle,
): Promise<User | null> {
	const migration = await readUsernameMigration();
	if (migration.state !== 'legacy') {
		const user = await resolveUsernameHandle(users, handle.username, handle.discriminator ?? undefined);
		return user !== null && isPerson(user) ? user : null;
	}
	const people = await findPeopleByUsername(users, handle.username);
	const matches =
		handle.discriminator === null ? people : people.filter((user) => user.discriminator === handle.discriminator);
	return matches.length === 1 ? matches[0]! : null;
}

export async function isUsernameTaken(
	users: UsernameLookup,
	username: string,
	exceptUserId?: UserID,
): Promise<boolean> {
	if (username.toLowerCase() === DELETED_USER_USERNAME.toLowerCase()) return true;
	const holders = await findUsernameHolders(users, username);
	return holders.some(
		(user) =>
			user.id !== exceptUserId &&
			(isPerson(user) ||
				(!user.isBot && user.pendingDeletionAt !== null) ||
				user.discriminator === USERNAME_MODE_DISCRIMINATOR),
	);
}

async function acquireReservationLock(cache: ICacheService, key: string): Promise<string | null> {
	const deadline = Date.now() + RESERVATION_WAIT_MS;
	while (Date.now() < deadline) {
		const token = await cache.acquireLock(key, RESERVATION_TTL_SECONDS);
		if (token) return token;
		await new Promise((resolve) => setTimeout(resolve, RESERVATION_RETRY_MS));
	}
	return null;
}

export async function reserveUsername(
	deps: UniqueUsernameDeps,
	username: string,
	exceptUserId?: UserID,
): Promise<UsernameReservation> {
	const key = `unique-username:${username.toLowerCase()}`;
	const token = await acquireReservationLock(deps.cache, key);
	if (!token) throw usernameTakenError();
	const release = async () => {
		await deps.cache.releaseLock(key, token);
	};
	try {
		if (await isUsernameTaken(deps.users, username, exceptUserId)) throw usernameTakenError();
	} catch (error) {
		await release();
		throw error;
	}
	return {username, release};
}

function withNumericSuffix(base: string, suffix: number): string {
	const suffixText = String(suffix);
	return `${base.slice(0, USERNAME_MAX_LENGTH - suffixText.length)}${suffixText}`;
}

export async function deriveAvailableUsername(users: UsernameLookup, base: string): Promise<string> {
	for (let attempt = 0; attempt < DERIVE_ATTEMPTS; attempt++) {
		const candidate = attempt === 0 ? base : withNumericSuffix(base, randomInt(1, 10000));
		if (!(await isUsernameTaken(users, candidate))) return candidate;
	}
	throw usernameTakenError();
}
