// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {isMicupAccountLimited} from '@app/api/user/AccountLimit';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

// Accounts whose public posts nobody outside their own reach sees: banned or disabled, flagged for suspicious activity,
// deleted or deleting themselves. Spammers are handled apart (profile rule here; Keşfet filters them separately).
export const PUBLIC_HIDDEN_AUTHOR_FLAGS =
	UserFlags.DISABLED | UserFlags.DELETED | UserFlags.DISABLED_SUSPICIOUS_ACTIVITY | UserFlags.SELF_DELETED;

const HOUR_MS = 3_600_000;
export const TREND_HALF_LIFE_MS = 6 * HOUR_MS;
export const TREND_WINDOW_MS = 72 * HOUR_MS;
// Forward decay: a reaction's weight grows by ln 2 per half-life from this epoch instead of old scores shrinking,
// so a score is written only when its post gets a reaction and the ranking never needs a sweep.
export const TREND_EPOCH_MS = Date.UTC(2026, 8, 1);
export const TREND_WEIGHTS = {post: 2, like: 4, firstComment: 12, pollVote: 1} as const;
export const TREND_DAILY_CONTRIBUTIONS = 300;
// Reports that count toward hiding a post have their own small allowance, apart from the 300 reactions.
export const TREND_DAILY_REPORTS = 10;
// Contributions one account may give one author's posts a day, so a ring of accounts cannot carry each other up alone. Taking back a counted like is never capped.
export const TREND_DAILY_PER_AUTHOR = 3;
export const TREND_REPORTS_TO_HIDE = 3;
const TREND_ACTOR_MIN_AGE_MS = 72 * HOUR_MS;
const DISCOVER_AUTHOR_MIN_AGE_MS = 24 * HOUR_MS;
const DISCOVER_VIDEO_AUTHOR_MIN_AGE_MS = 7 * 24 * HOUR_MS;
const PUBLIC_COMMENTER_MIN_AGE_MS = 24 * HOUR_MS;
// Comments one account may write on one public post of another author in its 72 hours.
export const PUBLIC_COMMENTS_PER_ACCOUNT = 20;

// PUBLIC_HIDDEN_AUTHOR_FLAGS plus spammers: a spammer's public post keeps the profile rule and never reaches Keşfet.
export const DISCOVER_HIDDEN_AUTHOR_FLAGS = PUBLIC_HIDDEN_AUTHOR_FLAGS | UserFlags.SPAMMER;

export interface TrendAccount {
	readonly id: UserID;
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly hasVerifiedPhone: boolean;
	readonly flags: bigint;
	readonly suspiciousActivityFlags: number;
	readonly isBot: boolean;
	readonly isSystem: boolean;
	isUnclaimedAccount(): boolean;
}

export interface TrendState {
	L: number | null;
	hw: number;
	v: number;
}

export function logAddExp(a: number, b: number): number {
	if (a === Number.NEGATIVE_INFINITY) return b;
	if (b === Number.NEGATIVE_INFINITY) return a;
	return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
}

/** One counter flush: only the part of the counter above its high-water mark adds to the score (unlike + like = 0). */
export function applyTrendFlush(
	state: TrendState | null,
	value: number,
	nowMs: number,
): {state: TrendState; ranked: boolean} {
	const current = state ?? {L: null, hw: 0, v: 0};
	const delta = value - current.hw;
	if (delta <= 0) return {state: {...current, v: value}, ranked: false};
	const weight = Math.log(delta) + ((nowMs - TREND_EPOCH_MS) * Math.LN2) / TREND_HALF_LIFE_MS;
	return {state: {L: logAddExp(current.L ?? Number.NEGATIVE_INFINITY, weight), hw: value, v: value}, ranked: true};
}

function isCleanAccount(account: TrendAccount): boolean {
	return (
		account.emailVerified &&
		(account.flags & DISCOVER_HIDDEN_AUTHOR_FLAGS) === 0n &&
		!isMicupAccountLimited(account) &&
		!account.isUnclaimedAccount()
	);
}

function accountAgeMs(userId: UserID, nowMs: number): number {
	return nowMs - snowflakeToDate(userId).getTime();
}

export function isTrendActorEligible(actor: TrendAccount, nowMs: number): boolean {
	return isCleanAccount(actor) && accountAgeMs(actor.id, nowMs) >= TREND_ACTOR_MIN_AGE_MS;
}

/** A stranger who reaches a public post only through its public flag may comment. */
export function isPublicCommenterEligible(account: TrendAccount, nowMs: number): boolean {
	return (
		account.emailVerified &&
		!account.isUnclaimedAccount() &&
		accountAgeMs(account.id, nowMs) >= PUBLIC_COMMENTER_MIN_AGE_MS
	);
}

/** A stranger's standing to follow through Keşfet and to open a public profile: public commenter, clean flags. */
export function hasStrangerFollowStanding(user: TrendAccount, nowMs: number): boolean {
	return (
		(user.flags & DISCOVER_HIDDEN_AUTHOR_FLAGS) === 0n &&
		!isMicupAccountLimited(user) &&
		isPublicCommenterEligible(user, nowMs)
	);
}

export function isDiscoverAuthorEligible(author: TrendAccount, nowMs: number, options: {hasVideo: boolean}): boolean {
	const minAge = options.hasVideo ? DISCOVER_VIDEO_AUTHOR_MIN_AGE_MS : DISCOVER_AUTHOR_MIN_AGE_MS;
	return isCleanAccount(author) && accountAgeMs(author.id, nowMs) >= minAge;
}

export function isInTrendWindow(postId: bigint, nowMs: number): boolean {
	return nowMs - snowflakeToDate(postId).getTime() <= TREND_WINDOW_MS;
}

export function feedPostHasVideo(row: Pick<FeedPostRow, 'media'>): boolean {
	return (row.media ?? []).some((media) => media.content_type.startsWith('video/'));
}

export const DISCOVER_SNAPSHOT_SIZE = 1000;
const DIVERSITY = {firstWindow: 100, perAuthorInFirst: 2, spacing: 20};

/**
 * Score order with author variety: an author at most once in any `spacing` posts in a row (one per page) and
 * at most `perAuthorInFirst` times in the first `firstWindow`. A post that cannot be placed waits and goes in at the
 * first place that allows it; whatever is still waiting at the end is appended in score order, so an instance with few
 * authors still gets a full list. Runs in the cron build only (candidates × waiting, waiting ≤ authors).
 */
export function diversifyByAuthor<T extends {authorId: string}>(items: Array<T>, rules = DIVERSITY): Array<T> {
	const out: Array<T> = [];
	const lastAt = new Map<string, number>();
	const inFirst = new Map<string, number>();
	const allowed = (entry: T): boolean => {
		const position = out.length;
		const last = lastAt.get(entry.authorId);
		if (last !== undefined && position - last < rules.spacing) return false;
		return position >= rules.firstWindow || (inFirst.get(entry.authorId) ?? 0) < rules.perAuthorInFirst;
	};
	const place = (entry: T): void => {
		if (out.length < rules.firstWindow) inFirst.set(entry.authorId, (inFirst.get(entry.authorId) ?? 0) + 1);
		lastAt.set(entry.authorId, out.length);
		out.push(entry);
	};
	const waiting: Array<T> = [];
	for (const entry of items) {
		for (let index = 0; index < waiting.length; ) {
			if (allowed(waiting[index]!)) {
				place(waiting.splice(index, 1)[0]!);
				index = 0;
			} else {
				index++;
			}
		}
		if (allowed(entry)) place(entry);
		else waiting.push(entry);
	}
	for (const entry of waiting) out.push(entry);
	return out;
}

/**
 * The offset of a version.offset cursor. The version names the snapshot for logs; a newer snapshot continues at the
 * same offset and the client drops posts it already shows.
 */
export function parseDiscoverCursor(cursor: string | undefined): number {
	return cursor ? Number(cursor.split('.')[1]) : 0;
}
