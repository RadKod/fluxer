// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {
	applyTrendFlush,
	diversifyByAuthor,
	hasStrangerFollowStanding,
	isDiscoverAuthorEligible,
	isInTrendWindow,
	isPublicCommenterEligible,
	isTrendActorEligible,
	logAddExp,
	parseDiscoverCursor,
	TREND_EPOCH_MS,
	TREND_HALF_LIFE_MS,
	type TrendAccount,
} from '@app/api/feed/discover/FeedDiscoverRules';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {describe, expect, it} from 'vitest';

const NOW = TREND_EPOCH_MS + 30 * 86_400_000;
const HOUR = 3_600_000;
const account = (ageMs: number, patch: Partial<TrendAccount> = {}): TrendAccount => ({
	id: createUserID(createSnowflakeFromTimestamp(NOW - ageMs)),
	email: 'discover@example.com',
	emailVerified: true,
	hasVerifiedPhone: false,
	flags: 0n,
	suspiciousActivityFlags: 0,
	isBot: false,
	isSystem: false,
	isUnclaimedAccount: () => false,
	...patch,
});

describe('Keşfet trend rules', () => {
	it('adds scores in log space', () => {
		expect(logAddExp(Math.log(2), Math.log(2))).toBeCloseTo(Math.log(4));
		expect(logAddExp(Number.NEGATIVE_INFINITY, 1.5)).toBe(1.5);
	});
	it('weighs a reaction one half-life later twice as much (forward decay)', () => {
		const early = applyTrendFlush(null, 4, NOW).state.L!;
		const late = applyTrendFlush(null, 4, NOW + TREND_HALF_LIFE_MS).state.L!;
		expect(late - early).toBeCloseTo(Math.LN2);
	});
	it('does not count a like again after it was taken back (high-water mark)', () => {
		const liked = applyTrendFlush(null, 4, NOW);
		const unliked = applyTrendFlush(liked.state, 0, NOW + 1);
		const relike = applyTrendFlush(unliked.state, 4, NOW + 2);
		expect(unliked.ranked).toBe(false);
		expect(relike.ranked).toBe(false);
		expect(relike.state.L).toBe(liked.state.L);
	});
	it('counts reactions only from clean accounts at least 72 hours old', () => {
		expect(isTrendActorEligible(account(73 * HOUR), NOW)).toBe(true);
		expect(isTrendActorEligible(account(71 * HOUR), NOW)).toBe(false);
		expect(isTrendActorEligible(account(100 * HOUR, {emailVerified: false}), NOW)).toBe(false);
		for (const flag of ['SPAMMER', 'DISABLED', 'DELETED', 'DISABLED_SUSPICIOUS_ACTIVITY', 'SELF_DELETED'] as const) {
			expect(isTrendActorEligible(account(100 * HOUR, {flags: UserFlags[flag]}), NOW)).toBe(false);
		}
		expect(isTrendActorEligible(account(100 * HOUR, {flags: UserFlags.ACCOUNT_LIMITED}), NOW)).toBe(false);
		expect(isTrendActorEligible(account(100 * HOUR, {isUnclaimedAccount: () => true}), NOW)).toBe(false);
	});
	it('lets a stranger comment on a public post from a verified, claimed account at least 24 hours old', () => {
		expect(isPublicCommenterEligible(account(25 * HOUR), NOW)).toBe(true);
		expect(isPublicCommenterEligible(account(23 * HOUR), NOW)).toBe(false);
		expect(isPublicCommenterEligible(account(100 * HOUR, {emailVerified: false}), NOW)).toBe(false);
		expect(isPublicCommenterEligible(account(100 * HOUR, {isUnclaimedAccount: () => true}), NOW)).toBe(false);
	});
	it('lists authors from 24 hours, video authors from 7 days', () => {
		expect(isDiscoverAuthorEligible(account(25 * HOUR), NOW, {hasVideo: false})).toBe(true);
		expect(isDiscoverAuthorEligible(account(25 * HOUR), NOW, {hasVideo: true})).toBe(false);
		expect(isDiscoverAuthorEligible(account(8 * 24 * HOUR), NOW, {hasVideo: true})).toBe(true);
	});
	it('keeps limited accounts out of discovery and stranger follow standing', () => {
		const limited = account(8 * 24 * HOUR, {flags: UserFlags.ACCOUNT_LIMITED});
		expect(isDiscoverAuthorEligible(limited, NOW, {hasVideo: false})).toBe(false);
		expect(hasStrangerFollowStanding(limited, NOW)).toBe(false);
		expect(hasStrangerFollowStanding(account(8 * 24 * HOUR), NOW)).toBe(true);
	});
	it.each([0n, UserFlags.STAFF, UserFlags.LIMIT_EXEMPT])(
		'keeps legacy-restricted accounts out of discovery despite exemption %s',
		(flags) => {
			const restricted = {...account(8 * 24 * HOUR, {flags}), suspiciousActivityFlags: 4};
			expect(isTrendActorEligible(restricted, NOW)).toBe(false);
			expect(isDiscoverAuthorEligible(restricted, NOW, {hasVideo: false})).toBe(false);
			expect(hasStrangerFollowStanding(restricted, NOW)).toBe(false);
		},
	);
	it.each([UserFlags.STAFF, UserFlags.LIMIT_EXEMPT])(
		'honours account limit exemptions in discovery standing',
		(exempt) => {
			const user = account(8 * 24 * HOUR, {flags: UserFlags.ACCOUNT_LIMITED | exempt});
			expect(isDiscoverAuthorEligible(user, NOW, {hasVideo: false})).toBe(true);
			expect(hasStrangerFollowStanding(user, NOW)).toBe(true);
		},
	);
	it('keeps a post in the window for 72 hours', () => {
		expect(isInTrendWindow(createSnowflakeFromTimestamp(NOW - 71 * HOUR), NOW)).toBe(true);
		expect(isInTrendWindow(createSnowflakeFromTimestamp(NOW - 73 * HOUR), NOW)).toBe(false);
	});
});

describe('diversifyByAuthor', () => {
	const item = (id: number, authorId: string) => ({id, authorId});
	it('keeps an author to one post in any 20 in a row and two in the first 100 when there are enough authors', () => {
		const input = [
			item(1, 'a'),
			item(2, 'a'),
			item(3, 'a'),
			...Array.from({length: 150}, (_, i) => item(10 + i, `u${i}`)),
		];
		const out = diversifyByAuthor(input);
		const aPositions = out.flatMap((entry, index) => (entry.authorId === 'a' ? [index] : []));
		expect(aPositions).toEqual([0, 20, 100]);
		expect(out).toHaveLength(input.length);
	});
	it('appends what cannot be spaced out at the end rather than dropping it (few authors)', () => {
		const out = diversifyByAuthor([item(1, 'a'), item(2, 'a'), item(3, 'b')]);
		expect(out.map((entry) => entry.id)).toEqual([1, 3, 2]);
	});
});

describe('parseDiscoverCursor', () => {
	it('reads the offset and starts from 0 without a cursor', () => {
		expect(parseDiscoverCursor(undefined)).toBe(0);
		expect(parseDiscoverCursor('1790000000000.40')).toBe(40);
	});
});
