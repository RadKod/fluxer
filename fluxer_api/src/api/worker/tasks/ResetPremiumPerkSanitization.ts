// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getPremiumLedgerRepository, getPremiumLedgerService} from '@app/api/middleware/ServiceSingletons';
import {propagatePartialUserChange} from '@app/api/user/services/PartialUserChangePropagation';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	userId: z.string().regex(/^\d+$/),
});

const GUILD_CONCURRENCY = 8;
const LOCK_EXTEND_INTERVAL_MS = 10_000;

const resetPremiumPerkSanitization: WorkerTaskHandler = async (payload) => {
	const userId = createUserID(BigInt(PayloadSchema.parse(payload).userId));
	const {userRepository, guildRepository, userCacheService} = getWorkerDependencies();
	const repository = getPremiumLedgerRepository();
	const restoredUser = await getPremiumLedgerService().withUserLock(userId, async (keepAlive) => {
		const user = await userRepository.findUnique(userId);
		if (!user || !checkIsPremium(user)) {
			return null;
		}
		const guildIds = await userRepository.getUserGuildIds(userId);
		let lockExtendedAt = Date.now();
		const cleared = await mapWithConcurrency(guildIds, GUILD_CONCURRENCY, async (guildId) => {
			if (Date.now() - lockExtendedAt >= LOCK_EXTEND_INTERVAL_MS) {
				lockExtendedAt = Date.now();
				await keepAlive();
			}
			const member = await guildRepository.getMember(guildId, userId);
			return member?.isPremiumSanitized === true && (await repository.clearMemberPremiumSanitization(guildId, userId));
		});
		return cleared.includes(true) ? user : null;
	});
	if (restoredUser) {
		await propagatePartialUserChange({userCacheService}, restoredUser);
	}
};

export default resetPremiumPerkSanitization;
