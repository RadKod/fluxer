// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import type {PremiumExpirationByDayRow} from '@app/api/database/types/PremiumLedgerTypes';
import {Logger} from '@app/api/Logger';
import {
	getCosmeticService,
	getPremiumLedgerRepository,
	getPremiumLedgerService,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {
	PREMIUM_EXPIRATION_SHARDS,
	type PremiumLedgerService,
	premiumExpirationDay,
} from '@app/api/premium/ledger/PremiumLedgerService';
import {checkHasActivePaidPremium, getEffectivePremiumUntil, PREMIUM_GRACE_PERIOD_MS} from '@app/api/user/UserHelpers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {processUser} from '@app/api/worker/tasks/ProcessExpiredPremiumSweep';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {seconds} from 'itty-time';

// Five days reach past the three day grace that upstream gift premium gets on top of its end.
const WINDOW_DAYS = 5;
const PAGE_SIZE = 500;
const ROW_CONCURRENCY = 16;
// Kept as long as an expiration row can live (its 400 day TTL floor), so a run catching up from an old cursor skips
// settled days with one KV read instead of reading partitions full of deleted rows.
const SETTLED_TTL_SECONDS = seconds('400 days');
// The oldest day that still had unsettled rows. Runs start there when it is older than the window, so a day left
// unsettled by a failing user or by hours the job did not run is read again until it settles or its rows expire.
const CURSOR_KEY = 'premium:expirations:cursor';

type Outcome = 'settled' | 'pending';

interface ExpirationContext {
	deps: ReturnType<typeof getWorkerDependencies>;
	cosmetics: Pick<CosmeticService, 'removePremiumOnlyCosmetics'>;
	ledger: PremiumLedgerService;
	repository: PremiumLedgerRepository;
}

function settledKey(day: number, shard: number): string {
	return `premium:expirations:settled:${day}:${shard}`;
}

function paidPremiumEndsAt(user: User): Date | null {
	const until = getEffectivePremiumUntil(user);
	if (!until) {
		return null;
	}
	const graceEndMs = user.premiumGraceEndsAt?.getTime() ?? until.getTime() + PREMIUM_GRACE_PERIOD_MS;
	return new Date(Math.max(until.getTime(), graceEndMs));
}

async function moveToDayOf(ctx: ExpirationContext, day: number, userId: UserID, at: Date): Promise<Outcome> {
	if (premiumExpirationDay(at) === day) {
		return 'pending';
	}
	await ctx.ledger.trackExpiration(userId, at);
	return 'settled';
}

async function processExpiration(ctx: ExpirationContext, day: number, userId: UserID): Promise<Outcome> {
	return ctx.ledger.withUserLock(userId, async () => {
		const {user, paidUntil} = await ctx.ledger.ensureUserPremiumLocked(userId);
		const now = Date.now();
		if (paidUntil && paidUntil.getTime() > now) {
			return moveToDayOf(ctx, day, userId, paidUntil);
		}
		if (!user) {
			return 'settled';
		}
		if (checkHasActivePaidPremium(user)) {
			const endsAt = paidPremiumEndsAt(user);
			return endsAt && endsAt.getTime() > now ? moveToDayOf(ctx, day, userId, endsAt) : 'settled';
		}
		const result = {
			processed: 0,
			stripped: 0,
			sanitized: 0,
			reconcileEnqueued: 0,
			storeRefreshEnqueued: 0,
			skipped: 0,
			failed: 0,
		};
		await processUser(user, ctx.deps, result);
		if (result.failed > 0 || result.storeRefreshEnqueued > 0) {
			return 'pending';
		}
		await ctx.cosmetics.removePremiumOnlyCosmetics(userId);
		return 'settled';
	});
}

async function processRow(ctx: ExpirationContext, row: PremiumExpirationByDayRow): Promise<Outcome> {
	try {
		const outcome = await processExpiration(ctx, row.day, row.user_id);
		if (outcome === 'settled') {
			await ctx.repository.deleteExpiration(row);
		}
		return outcome;
	} catch (error) {
		Logger.warn({userId: row.user_id.toString(), day: row.day, error}, 'Failed to process premium expiration');
		return 'pending';
	}
}

async function processPartition(ctx: ExpirationContext, day: number, shard: number, today: number): Promise<boolean> {
	const {kvClient} = ctx.deps;
	if (day < today && (await kvClient.get(settledKey(day, shard))) !== null) {
		return true;
	}
	let pending = 0;
	let afterUserId: UserID | undefined;
	for (;;) {
		const rows = await ctx.repository.listExpirations(day, shard, PAGE_SIZE, afterUserId);
		const outcomes = await mapWithConcurrency(rows, ROW_CONCURRENCY, (row) => processRow(ctx, row));
		pending += outcomes.filter((outcome) => outcome === 'pending').length;
		if (rows.length < PAGE_SIZE) {
			break;
		}
		afterUserId = rows[rows.length - 1]!.user_id;
	}
	if (day >= today || pending > 0) {
		return false;
	}
	await kvClient.setex(settledKey(day, shard), SETTLED_TTL_SECONDS, '1');
	return true;
}

const processPremiumExpirations: WorkerTaskHandler = async (_payload, helpers) => {
	const ctx: ExpirationContext = {
		deps: getWorkerDependencies(),
		cosmetics: getCosmeticService(),
		ledger: getPremiumLedgerService(),
		repository: getPremiumLedgerRepository(),
	};
	const {kvClient} = ctx.deps;
	const today = premiumExpirationDay(new Date());
	const cursor = Number(await kvClient.get(CURSOR_KEY));
	const firstDay = Math.min(today - WINDOW_DAYS + 1, Number.isSafeInteger(cursor) && cursor > 0 ? cursor : today);
	let oldestUnsettled = today;
	for (let day = firstDay; day <= today; day++) {
		for (let shard = 0; shard < PREMIUM_EXPIRATION_SHARDS; shard++) {
			// A partition that cannot be read stays unsettled for the next run instead of stopping the later days.
			const settled = await processPartition(ctx, day, shard, today).catch((error: unknown) => {
				helpers.logger.warn({day, shard, error}, 'Failed to read premium expirations');
				return false;
			});
			if (!settled) {
				oldestUnsettled = Math.min(oldestUnsettled, day);
			}
		}
	}
	await kvClient.set(CURSOR_KEY, String(oldestUnsettled));
	if (oldestUnsettled < today - WINDOW_DAYS + 1) {
		helpers.logger.warn({today, oldestUnsettled}, 'Premium expirations stay unsettled past the window');
	}
	helpers.logger.debug({today}, 'Processed premium expirations');
};

export default processPremiumExpirations;
