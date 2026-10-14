// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import SessionManager from '@app/features/platform/state/AuthSession';
import {User} from '@app/features/user/models/User';
import {shouldShowDiscriminator} from '@app/features/user/utils/UserTagUtils';
import type {UserPrivate, User as WireUser} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {getObserverTree, makeAutoObservable, observableRef, reaction, runInAction} from 'mobx';

const CURRENT_USER_PRIVATE_WIRE_KEYS = [
	'is_staff',
	'email',
	'email_bounced',
	'account_limited',
	'mfa_enabled',
	'authenticator_types',
	'verified',
	'premium_type',
	'premium_since',
	'premium_until',
	'premium_will_cancel',
	'premium_billing_cycle',
	'premium_lifetime_sequence',
	'premium_grace_ends_at',
	'premium_discriminator',
	'premium_badge_hidden',
	'premium_badge_masked',
	'premium_badge_timestamp_hidden',
	'premium_badge_sequence_hidden',
	'premium_purchase_disabled',
	'premium_enabled_override',
	'premium_perks_disabled',
	'password_last_changed_at',
	'last_voice_activity_sharing_change_at',
	'nsfw_allowed',
	'public_profile_allowed',
	'pending_bulk_message_deletion',
	'has_dismissed_premium_onboarding',
	'has_ever_purchased',
	'has_unread_gift_inventory',
	'unread_gift_inventory_count',
	'age_verified_adult',
	'terms_agreed_at',
	'privacy_agreed_at',
	'traits',
	'timezone',
	'timezone_privacy_flags',
] as const;

function isPublicOnlyCurrentUserPayload(user: WireUser): boolean {
	return !CURRENT_USER_PRIVATE_WIRE_KEYS.some((key) => key in user);
}

function observerCount(target: object, key: string): number {
	return getObserverTree(target, key).observers?.length ?? 0;
}

class CurrentUserHydrationMismatchError extends Error {
	constructor(accountKey: string, userId: string) {
		super(`Cannot hydrate user ${userId} outside its active account ${accountKey}`);
		this.name = 'CurrentUserHydrationMismatchError';
	}
}

class Users {
	users: Record<string, User> = {};
	userCount = 0;
	private retainCounts = new Map<string, number>();
	viewAccountKey: string | null = null;
	private hydratedAccountKey: string | null = null;

	constructor() {
		makeAutoObservable<Users, 'hydratedAccountKey' | 'retainCounts'>(
			this,
			{hydratedAccountKey: observableRef, retainCounts: false},
			{autoBind: true},
		);
	}

	retainUsers(userIds: Iterable<string>): void {
		for (const userId of userIds) {
			this.retainCounts.set(userId, (this.retainCounts.get(userId) ?? 0) + 1);
		}
	}

	releaseUsers(userIds: Iterable<string>): void {
		for (const userId of userIds) {
			const count = this.retainCounts.get(userId) ?? 0;
			if (count > 1) {
				this.retainCounts.set(userId, count - 1);
			} else {
				this.retainCounts.delete(userId);
			}
		}
	}

	evictUsers(userIds: Iterable<string>, keep: ReadonlySet<string>): void {
		const currentUserId = this.currentUserId;
		const users = this.users;
		// While observed, usersList reads every entry, so each one carries that single extra observer.
		// Debug names are not unique in production builds, so it is discounted by count, not by name.
		const listObservers = observerCount(this, 'usersList') > 0 ? 1 : 0;
		let evictedCount = 0;
		for (const userId of userIds) {
			if (
				userId === currentUserId ||
				keep.has(userId) ||
				this.retainCounts.has(userId) ||
				!(userId in users) ||
				observerCount(users, userId) > listObservers
			) {
				continue;
			}
			// TEMPORARY: users is one dictionary; the delete that drops it to a quarter full rehashes the rest in one go
			// (~5 ms at 100K cached users, linear). Past ~150K cached users back this store with an observable map.
			delete users[userId];
			evictedCount += 1;
		}
		this.userCount -= evictedCount;
	}

	get currentUser(): User | null {
		const currentAccountKey = SessionManager.currentAccountKey;
		const currentUserId = SessionManager.userId;
		if (currentAccountKey === null || currentUserId === null || this.hydratedAccountKey !== currentAccountKey) {
			return null;
		}
		return this.users[currentUserId] ?? null;
	}

	get currentUserId(): string | null {
		return SessionManager.userId;
	}

	get isCurrentUserHydrated(): boolean {
		const currentAccountKey = SessionManager.currentAccountKey;
		const currentUserId = SessionManager.userId;
		return (
			currentAccountKey !== null &&
			currentUserId !== null &&
			this.hydratedAccountKey === currentAccountKey &&
			this.users[currentUserId] !== undefined
		);
	}

	get usersList(): ReadonlyArray<User> {
		return Object.values(this.users);
	}

	getUser(userId: string): User | undefined {
		if (userId === this.currentUserId) {
			return this.currentUser ?? undefined;
		}
		return this.users[userId];
	}

	getCurrentUser(): User | undefined {
		return this.currentUser ?? undefined;
	}

	getUserByTag(tag: string): User | undefined {
		const lookup = tag.trim().replace(/^@/, '').toLowerCase();
		return this.usersList.find((user) =>
			shouldShowDiscriminator(user)
				? `${user.username}#${user.discriminator}`.toLowerCase() === lookup
				: user.username.toLowerCase() === lookup,
		);
	}

	getUsers(): ReadonlyArray<User> {
		return this.usersList;
	}

	handleGatewayReady(accountKey: string, currentUser: UserPrivate): void {
		this.assertCurrentAccountIdentity(accountKey, currentUser.id);
		const userRecord = new User(currentUser);
		this.users = {
			[currentUser.id]: userRecord,
		};
		this.userCount = 1;
		this.hydratedAccountKey = accountKey;
		this.viewAccountKey = accountKey;
		if (!userRecord.isClaimed()) {
			setTimeout(async () => {
				if (!this.isActiveUnclaimedAccount(accountKey, currentUser.id)) {
					return;
				}
				const {openClaimAccountModal} = await import('@app/features/auth/components/modals/ClaimAccountModal');
				if (!this.isActiveUnclaimedAccount(accountKey, currentUser.id)) {
					return;
				}
				openClaimAccountModal();
			}, 1000);
		}
	}

	hydrateFromSnapshot(accountKey: string, currentUser: UserPrivate, users: ReadonlyArray<WireUser>): void {
		this.assertCurrentAccountIdentity(accountKey, currentUser.id);
		const hydratedUsers: Record<string, User> = {
			[currentUser.id]: new User(currentUser),
		};
		for (const user of users) {
			if (user.id !== currentUser.id) {
				hydratedUsers[user.id] = new User(user);
			}
		}
		this.users = hydratedUsers;
		this.userCount = Object.keys(hydratedUsers).length;
		this.hydratedAccountKey = accountKey;
		this.viewAccountKey = accountKey;
	}

	resetAccountState(): void {
		this.retainCounts.clear();
		this.users = {};
		this.userCount = 0;
		this.hydratedAccountKey = null;
	}

	handleUserUpdate(
		user: WireUser,
		options?: {
			clearMissingOptionalFields?: boolean;
		},
	): void {
		const existingUser = this.users[user.id];
		if (
			user.id === this.currentUserId &&
			existingUser &&
			options?.clearMissingOptionalFields !== true &&
			isPublicOnlyCurrentUserPayload(user)
		) {
			return;
		}
		this.storeUser(existingUser, existingUser ? existingUser.withUpdates(user, options) : new User(user));
	}

	private storeUser(existingUser: User | undefined, nextUser: User): void {
		if (existingUser) {
			if (existingUser.equals(nextUser)) {
				return;
			}
		} else {
			this.userCount += 1;
		}
		this.users[nextUser.id] = nextUser;
	}

	cacheUsers(
		users: Array<
			WireUser & {
				globalName?: never;
			}
		>,
	): void {
		runInAction(() => {
			for (const user of users) {
				const existingUser = this.users[user.id];
				if (user.id === this.currentUserId && existingUser && isPublicOnlyCurrentUserPayload(user)) {
					continue;
				}
				this.storeUser(existingUser, existingUser ? existingUser.withUpdates(user) : new User(user));
			}
		});
	}

	subscribe(callback: () => void): () => void {
		return reaction(
			() => this.userCount,
			() => callback(),
			{fireImmediately: true},
		);
	}

	private assertCurrentAccountIdentity(accountKey: string, userId: string): void {
		if (SessionManager.currentAccountKey !== accountKey || SessionManager.userId !== userId) {
			throw new CurrentUserHydrationMismatchError(accountKey, userId);
		}
	}

	private isActiveUnclaimedAccount(accountKey: string, userId: string): boolean {
		const currentUser = this.currentUser;
		return (
			this.hydratedAccountKey === accountKey &&
			SessionManager.currentAccountKey === accountKey &&
			currentUser?.id === userId &&
			!currentUser.isClaimed()
		);
	}
}

const users = new Users();
ResettableStates.register(users, users.resetAccountState);

export default users;
