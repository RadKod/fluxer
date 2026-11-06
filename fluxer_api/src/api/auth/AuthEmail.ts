// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import * as AuthUtility from '@app/api/auth/AuthUtility';
import {confirmEmailOwnership} from '@app/api/auth/EmailOwnership';
import {createEmailVerificationToken} from '@app/api/BrandedTypes';
import type {User} from '@app/api/models/User';
import * as RandomUtils from '@app/api/utils/RandomUtils';
import {createRateLimitError} from '@app/api/utils/RateLimitUtils';
import {SuspiciousActivityFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {VerifyEmailRequest} from '@fluxer/schema/src/domains/auth/AuthSchemas';
import {ms} from 'itty-time';

export const EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS =
	SuspiciousActivityFlags.REQUIRE_VERIFIED_EMAIL |
	SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL |
	SuspiciousActivityFlags.REQUIRE_VERIFIED_EMAIL_OR_VERIFIED_PHONE |
	SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL_OR_VERIFIED_PHONE |
	SuspiciousActivityFlags.REQUIRE_VERIFIED_EMAIL_OR_REVERIFIED_PHONE |
	SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL_OR_REVERIFIED_PHONE;

export async function verifyEmail(ctx: ApiContext, data: VerifyEmailRequest): Promise<boolean> {
	const {users} = ctx.services;
	const tokenData = await users.getEmailVerificationToken(data.token);
	if (!tokenData) {
		return false;
	}
	let user = await users.findUnique(tokenData.userId);
	if (!user) {
		return false;
	}
	AuthUtility.assertNonBotUser(ctx, user);
	if (
		user.flags & UserFlags.DELETED ||
		!user.email ||
		user.email.trim().toLowerCase() !== tokenData.email.trim().toLowerCase()
	) {
		return false;
	}
	// Micup: verifying the email also clears the suspicious-activity requirements an email verification satisfies.
	if (user.suspiciousActivityFlags !== null && user.suspiciousActivityFlags !== 0) {
		const newFlags = user.suspiciousActivityFlags & ~EMAIL_CLEARABLE_SUSPICIOUS_ACTIVITY_FLAGS;
		if (newFlags !== user.suspiciousActivityFlags) {
			user = await users.patchUpsert(user.id, {suspicious_activity_flags: newFlags}, user.toRow());
		}
	}
	await confirmEmailOwnership(ctx, user);
	await users.deleteEmailVerificationToken(data.token);
	return true;
}

export async function resendVerificationEmail(ctx: ApiContext, user: User): Promise<void> {
	const {rateLimit} = ctx.services;
	AuthUtility.assertNonBotUser(ctx, user);
	const allowReverification =
		user.suspiciousActivityFlags !== null &&
		((user.suspiciousActivityFlags & SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL) !== 0 ||
			(user.suspiciousActivityFlags & SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL_OR_VERIFIED_PHONE) !== 0 ||
			(user.suspiciousActivityFlags & SuspiciousActivityFlags.REQUIRE_VERIFIED_EMAIL_OR_REVERIFIED_PHONE) !== 0 ||
			(user.suspiciousActivityFlags & SuspiciousActivityFlags.REQUIRE_REVERIFIED_EMAIL_OR_REVERIFIED_PHONE) !== 0);
	if (user.emailVerified && !allowReverification) {
		return;
	}
	const limit = await rateLimit.checkLimit({
		identifier: `email_verification:${user.email!}`,
		maxAttempts: 3,
		windowMs: ms('15 minutes'),
	});
	if (!limit.allowed) {
		throw createRateLimitError(limit);
	}
	await sendVerificationEmail(ctx, {user, email: user.email!});
}

export async function sendVerificationEmail(ctx: ApiContext, params: {user: User; email: string}): Promise<void> {
	const {users, email: emailService} = ctx.services;
	const {user, email} = params;
	const token = createEmailVerificationToken(await RandomUtils.randomString(64));
	await users.createEmailVerificationToken({
		token_: token,
		user_id: user.id,
		email,
	});
	await emailService.send('email_verification', email, {verificationToken: token}, user.locale);
}
