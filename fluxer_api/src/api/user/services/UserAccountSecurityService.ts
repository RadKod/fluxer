// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import * as AuthPassword from '@app/api/auth/AuthPassword';
import * as AuthSession from '@app/api/auth/AuthSession';
import {assertEmailNotBlocklisted} from '@app/api/auth/EmailBlocklist';
import {createSudoModeRequiredError} from '@app/api/auth/services/SudoMethods';
import type {SudoVerificationResult} from '@app/api/auth/services/SudoVerificationService';
import {Config} from '@app/api/Config';
import type {UserRow} from '@app/api/database/types/UserTypes';
import type {DiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import {getFreshCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {getCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {profileSubstringBlocklistCache} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {AuthSession as AuthSessionModel} from '@app/api/models/AuthSession';
import type {User} from '@app/api/models/User';
import {enforceFluxerTagChangeRateLimit} from '@app/api/user/FluxerTagChangeRateLimit';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {
	assertBotUsernameAvailable,
	assertNoDiscriminatorChange,
	readUsernameMigration,
	reserveUsername,
	type UsernameReservation,
} from '@app/api/user/UniqueUsernames';
import {isProfileSubstringExempt} from '@app/api/user/UserHelpers';
import {UsernameOwnershipRepository} from '@app/api/user/username/UsernameOwnershipRepository';
import {USERNAME_CLAIM_ERROR_CODES} from '@app/api/user/username/UsernameOwnershipService';
import {UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {hashPassword} from '@app/api/utils/PasswordUtils';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ContentBlockedError} from '@fluxer/errors/src/domains/content/ContentBlockedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {UserUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import type {IRateLimitService} from '@pkgs/rate_limit/src/IRateLimitService';

interface UserUpdateMetadata {
	invalidateAuthSessions?: boolean;
	usernameClaim?: string;
	identityDeadlineAt?: number;
	usernameReservation?: UsernameReservation;
}

type UserFieldUpdates = Partial<UserRow>;

interface UserAccountSecurityServiceDeps {
	apiContext: ApiContext;
	userAccountRepository: UserRepository;
	discriminatorService: DiscriminatorService;
	rateLimitService: IRateLimitService;
	limitConfigService: LimitConfigService;
}

export interface AuthSessionReplacement {
	token: string;
	authSessionIdHash: string;
}

export class UserAccountSecurityService {
	constructor(private readonly deps: UserAccountSecurityServiceDeps) {}

	async processSecurityUpdates(params: {
		user: User;
		data: UserUpdateRequest;
		sudoContext?: SudoVerificationResult;
	}): Promise<{
		updates: UserFieldUpdates;
		metadata: UserUpdateMetadata;
	}> {
		const {user, data, sudoContext} = params;
		const identityDeadlineAt = Date.now() + 30_000;
		const updates: UserFieldUpdates = {
			password_hash: user.passwordHash,
			global_name: user.isBot ? null : user.globalName,
			email: user.email,
		};
		const metadata: UserUpdateMetadata = {
			invalidateAuthSessions: false,
		};
		const isUnclaimedAccount = user.isUnclaimedAccount();
		const identityVerifiedViaSudo = sudoContext?.method === 'mfa' || sudoContext?.method === 'sudo_token';
		const identityVerifiedViaPassword = sudoContext?.method === 'password';
		const rawEmail = data.email?.trim();
		const normalizedEmail = rawEmail?.toLowerCase();
		const tagChangeRequested = data.username !== undefined || data.discriminator !== undefined;
		const accountIdentity = tagChangeRequested ? await getInstanceConfigRepository().getAccountIdentity() : null;
		const migration = tagChangeRequested ? await readUsernameMigration() : null;
		const usernameSignIn = accountIdentity?.mode === AccountIdentityModes.USERNAME;
		const ownershipIdentity = !user.isBot && migration !== null && migration.state !== 'legacy';
		const legacyUnique = !ownershipIdentity && !user.isBot && accountIdentity?.tagStyle === TagStyles.NONE;
		if (legacyUnique) assertNoDiscriminatorChange(data.discriminator, user.discriminator);
		if (!ownershipIdentity && data.discriminator === 0) {
			throw InputValidationError.fromCode(
				'discriminator',
				ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE,
			);
		}
		if (
			ownershipIdentity &&
			data.discriminator !== undefined &&
			data.discriminator !== user.discriminator &&
			!(data.username !== undefined && data.discriminator === 0)
		) {
			throw InputValidationError.fromCode(
				'discriminator',
				ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE,
			);
		}
		const hasPasswordRequiredChanges =
			(data.username !== undefined && data.username !== user.username) ||
			(data.discriminator !== undefined && data.discriminator !== user.discriminator) ||
			(data.email !== undefined && normalizedEmail !== user.email?.toLowerCase()) ||
			data.new_password !== undefined;
		const requiresVerification = hasPasswordRequiredChanges && !isUnclaimedAccount;
		if (requiresVerification && !identityVerifiedViaSudo && !identityVerifiedViaPassword) {
			throw await createSudoModeRequiredError(this.deps.apiContext, user);
		}
		if (isUnclaimedAccount && data.new_password) {
			updates.password_hash = await this.hashNewPassword(data.new_password);
			updates.password_last_changed_at = new Date();
			metadata.invalidateAuthSessions = false;
		} else if (data.new_password) {
			if (!data.password) {
				throw InputValidationError.fromCode('password', ValidationErrorCodes.PASSWORD_NOT_SET);
			}
			if (!identityVerifiedViaSudo && !identityVerifiedViaPassword) {
				throw await createSudoModeRequiredError(this.deps.apiContext, user);
			}
			updates.password_hash = await this.hashNewPassword(data.new_password);
			updates.password_last_changed_at = new Date();
			metadata.invalidateAuthSessions = true;
		}
		if (user.isBot && data.username !== undefined && data.username !== user.username) {
			await assertBotUsernameAvailable(user.id, data.username);
		}
		if (
			!ownershipIdentity &&
			!user.isBot &&
			data.username !== undefined &&
			data.username.toLowerCase() !== user.username.toLowerCase()
		) {
			try {
				const policy = new UsernamePolicyService();
				const snapshot = await policy.readCached();
				const canonical = data.username.toLowerCase();
				const entitlement =
					snapshot.dictionary.gen > 0 &&
					canonical.length <= 3 &&
					snapshot.tiers[canonical.length as 1 | 2 | 3] !== 'public'
						? await new UsernameOwnershipRepository().readEntitlement(user.id)
						: null;
				const rejection = policy.check(
					canonical,
					{kind: 'human', userId: user.id},
					false,
					snapshot,
					entitlement?.revoked_at == null ? (entitlement?.username ?? null) : null,
				);
				if (rejection)
					throw new FluxerError({
						code: USERNAME_CLAIM_ERROR_CODES[rejection],
						status: rejection === 'UNAVAILABLE' ? 503 : 400,
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
		if (ownershipIdentity && data.username !== undefined) {
			metadata.usernameClaim = data.username;
		} else if (data.username !== undefined) {
			const {newUsername, newDiscriminator} = legacyUnique
				? {newUsername: data.username, newDiscriminator: user.discriminator}
				: await this.updateUsername({
						user,
						username: data.username,
						requestedDiscriminator: data.discriminator,
					});
			if (
				!isProfileSubstringExempt(user) &&
				profileSubstringBlocklistCache.containsBannedSubstring('username', newUsername)
			) {
				throw new ContentBlockedError();
			}
			updates.username = newUsername;
			updates.discriminator = newDiscriminator;
		} else if (!ownershipIdentity && data.discriminator !== undefined) {
			updates.discriminator = legacyUnique
				? user.discriminator
				: await this.updateDiscriminator({user, discriminator: data.discriminator});
		}
		if (updates.discriminator === 0) {
			throw InputValidationError.fromCode(
				'discriminator',
				ValidationErrorCodes.DISCRIMINATOR_NOT_SUPPORTED_ON_INSTANCE,
			);
		}
		if (updates.username !== undefined || updates.discriminator !== undefined) {
			if (!user.isBot && getFreshCachedAccountIdentity() === null)
				throw new FluxerError({code: APIErrorCodes.USERNAME_UNAVAILABLE, status: 503});
			metadata.identityDeadlineAt = identityDeadlineAt;
		}
		await this.enforceFluxerTagChangeRateLimit({
			user,
			nextUsername: updates.username ?? user.username,
			nextDiscriminator: updates.discriminator ?? user.discriminator,
			errorPath: data.discriminator !== undefined && data.username === undefined ? 'discriminator' : 'username',
		});
		const usernameRealChange =
			data.username !== undefined && data.username.toLowerCase() !== user.username.toLowerCase();
		const discriminatorChanged = updates.discriminator !== undefined && updates.discriminator !== user.discriminator;
		const shouldMarkPremiumDiscriminator =
			!usernameSignIn &&
			(accountIdentity?.tagStyle ?? TagStyles.RANDOM) === TagStyles.RANDOM &&
			(discriminatorChanged || usernameRealChange) &&
			user.isPremium() &&
			user.premiumType !== UserPremiumTypes.LIFETIME;
		if (shouldMarkPremiumDiscriminator && (user.premiumFlags & PremiumFlags.DISCRIMINATOR) === 0) {
			updates.premium_flags = user.premiumFlags | PremiumFlags.DISCRIMINATOR;
		}
		if (user.isBot) {
			updates.global_name = null;
		} else if (data.global_name !== undefined) {
			if (
				data.global_name &&
				!isProfileSubstringExempt(user) &&
				profileSubstringBlocklistCache.containsBannedSubstring('global_name', data.global_name)
			) {
				throw new ContentBlockedError();
			}
			updates.global_name = data.global_name;
		}
		if (rawEmail) {
			if (normalizedEmail && normalizedEmail !== user.email?.toLowerCase()) {
				await assertEmailNotBlocklisted(normalizedEmail, 'email');
				const existing = await this.deps.userAccountRepository.findByEmail(normalizedEmail);
				if (existing && existing.id !== user.id) {
					throw InputValidationError.fromCode('email', ValidationErrorCodes.EMAIL_ALREADY_IN_USE);
				}
			}
			updates.email = rawEmail;
		}
		if (legacyUnique && usernameRealChange) {
			metadata.usernameReservation = await reserveUsername(
				{users: this.deps.apiContext.services.users, cache: this.deps.apiContext.services.cache},
				updates.username!,
				user.id,
			);
		}
		return {updates, metadata};
	}

	async invalidateAndRecreateSessions({
		user,
		oldAuthSession,
		request,
	}: {
		user: User;
		oldAuthSession: AuthSessionModel;
		request: Request;
	}): Promise<AuthSessionReplacement> {
		const replacement = await AuthSession.replaceCurrentAuthSession(this.deps.apiContext, {
			user,
			currentAuthSession: oldAuthSession,
			request,
		});
		return {token: replacement.token, authSessionIdHash: replacement.newAuthSessionIdHash};
	}

	private async hashNewPassword(newPassword: string): Promise<string> {
		if (await AuthPassword.isPasswordPwned(this.deps.apiContext, newPassword)) {
			throw InputValidationError.fromCode('new_password', ValidationErrorCodes.PASSWORD_IS_TOO_COMMON);
		}
		return await hashPassword(newPassword);
	}

	private async updateUsername({
		user,
		username,
		requestedDiscriminator,
	}: {
		user: User;
		username: string;
		requestedDiscriminator?: number;
	}): Promise<{
		newUsername: string;
		newDiscriminator: number;
	}> {
		const normalizedRequestedDiscriminator =
			requestedDiscriminator == null ? undefined : Number(requestedDiscriminator);
		if (
			user.username.toLowerCase() === username.toLowerCase() &&
			(normalizedRequestedDiscriminator === undefined || normalizedRequestedDiscriminator === user.discriminator)
		) {
			return {
				newUsername: username,
				newDiscriminator: user.discriminator,
			};
		}
		const ctx = createLimitMatchContext({user});
		const hasCustomDiscriminator = resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			ctx,
			'feature_custom_discriminator',
			0,
		);
		const isCaseOnlyChange = user.username.toLowerCase() === username.toLowerCase();
		if (hasCustomDiscriminator === 0) {
			if (isCaseOnlyChange) {
				return {
					newUsername: username,
					newDiscriminator: user.discriminator,
				};
			}
			const discriminatorResult = await this.deps.discriminatorService.generateDiscriminator({
				username,
				requestedDiscriminator: undefined,
				user: undefined,
			});
			if (!discriminatorResult.available || discriminatorResult.discriminator === -1) {
				throw InputValidationError.fromCode(
					'username',
					ValidationErrorCodes.TOO_MANY_USERS_WITH_USERNAME_TRY_DIFFERENT,
				);
			}
			return {
				newUsername: username,
				newDiscriminator: discriminatorResult.discriminator,
			};
		}
		const discriminatorToUse = normalizedRequestedDiscriminator ?? user.discriminator;
		if (this.requiresVisionaryForDiscriminator0000(user, discriminatorToUse)) {
			throw InputValidationError.fromCode('discriminator', ValidationErrorCodes.VISIONARY_REQUIRED_FOR_DISCRIMINATOR);
		}
		const discriminatorResult = await this.deps.discriminatorService.generateDiscriminator({
			username,
			requestedDiscriminator: discriminatorToUse,
			user,
		});
		if (!discriminatorResult.available || discriminatorResult.discriminator === -1) {
			throw InputValidationError.fromCode(
				'username',
				discriminatorToUse !== undefined
					? ValidationErrorCodes.TAG_ALREADY_TAKEN
					: ValidationErrorCodes.TOO_MANY_USERS_WITH_USERNAME_TRY_DIFFERENT,
			);
		}
		return {
			newUsername: username,
			newDiscriminator: discriminatorResult.discriminator,
		};
	}

	private async updateDiscriminator({user, discriminator}: {user: User; discriminator: number}): Promise<number> {
		const ctx = createLimitMatchContext({user});
		const hasCustomDiscriminator = resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			ctx,
			'feature_custom_discriminator',
			0,
		);
		if (hasCustomDiscriminator === 0) {
			throw InputValidationError.fromCode(
				'discriminator',
				ValidationErrorCodes.CHANGING_DISCRIMINATOR_REQUIRES_PREMIUM,
			);
		}
		if (this.requiresVisionaryForDiscriminator0000(user, discriminator)) {
			throw InputValidationError.fromCode('discriminator', ValidationErrorCodes.VISIONARY_REQUIRED_FOR_DISCRIMINATOR);
		}
		const discriminatorResult = await this.deps.discriminatorService.generateDiscriminator({
			username: user.username,
			requestedDiscriminator: discriminator,
			user,
		});
		if (!discriminatorResult.available) {
			throw InputValidationError.fromCode('discriminator', ValidationErrorCodes.TAG_ALREADY_TAKEN);
		}
		return discriminator;
	}

	private requiresVisionaryForDiscriminator0000(user: User, discriminator: number): boolean {
		// in mirror premium mode #0000 is a Visionary reward, as on Fluxer's hosted instance; an account that already
		// wears it keeps it until it changes its name.
		if (Config.instance.selfHosted && getCachedInstancePremiumMode() !== 'mirror') {
			return false;
		}
		return discriminator === 0 && user.premiumType !== UserPremiumTypes.LIFETIME;
	}

	private async enforceFluxerTagChangeRateLimit(params: {
		user: User;
		nextUsername: string;
		nextDiscriminator: number;
		errorPath: 'username' | 'discriminator';
	}): Promise<void> {
		const {user, nextUsername, nextDiscriminator, errorPath} = params;
		if (nextUsername === user.username && nextDiscriminator === user.discriminator) {
			return;
		}
		await enforceFluxerTagChangeRateLimit({
			rateLimitService: this.deps.rateLimitService,
			userId: user.id,
			errorPath,
		});
	}
}
