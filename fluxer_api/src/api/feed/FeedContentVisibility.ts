// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {isContentHidden} from '@app/api/user/UserHelpers';

export function isFeedContentVisible(
	cutoffs: ReadonlyMap<UserID, Date | null>,
	authorId: UserID,
	contentId: bigint,
): boolean {
	return cutoffs.has(authorId) && !isContentHidden({contentHiddenSince: cutoffs.get(authorId)!}, contentId);
}
