// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/api/models/User';
import {getEffectiveSuspiciousFlags, type LegacyAccountRestrictionSubject} from '@app/api/user/UserHelpers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {AccountLimitedError} from '@fluxer/errors/src/domains/user/AccountLimitedError';

type AccountLimitSubject = Pick<User, 'isBot' | 'isSystem' | 'flags'>;

export function isAccountLimitExempt(user: AccountLimitSubject): boolean {
	return (
		user.isBot || user.isSystem || (user.flags & UserFlags.STAFF) !== 0n || (user.flags & UserFlags.LIMIT_EXEMPT) !== 0n
	);
}

export function isAccountLimited(user: AccountLimitSubject): boolean {
	return (user.flags & UserFlags.ACCOUNT_LIMITED) !== 0n && !isAccountLimitExempt(user);
}

export function isLegacyAccountRestricted(user: LegacyAccountRestrictionSubject): boolean {
	return getEffectiveSuspiciousFlags(user) !== 0;
}

export function isMicupAccountLimited(user: AccountLimitSubject & LegacyAccountRestrictionSubject): boolean {
	return isLegacyAccountRestricted(user) || isAccountLimited(user);
}

export function assertAccountNotLimited(user: AccountLimitSubject & LegacyAccountRestrictionSubject): void {
	if (isMicupAccountLimited(user)) {
		throw new AccountLimitedError();
	}
}
