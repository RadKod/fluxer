// SPDX-License-Identifier: AGPL-3.0-or-later

import {planArt, planSavingsPercent} from '@app/features/premium/utils/PremiumPlanSavings';
import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import {describe, expect, it} from 'vitest';

const NOW = Date.parse('2026-10-08T00:00:00Z');
const entry = (months: 1 | 3 | 12, cents: number, sale = cents, endsAt: string | null = null): ShopPackageEntry => ({
	kind: 'package',
	sku: `premium:${months}`,
	months,
	price: {
		base_usd_cents: cents,
		sale_usd_cents: sale,
		premium_usd_cents: null,
		campaign_percent: sale === cents ? null : Math.round((1 - sale / cents) * 100),
		campaign_ends_at: endsAt,
	},
});

describe('planSavingsPercent', () => {
	it('compares a package month with the one month package, from the prices on sale now', () => {
		const all = [entry(1, 500), entry(3, 1350), entry(12, 4800)];
		expect(planSavingsPercent(all[1], all, NOW)).toBe(10);
		expect(planSavingsPercent(all[2], all, NOW)).toBe(20);
	});
	it('takes a running campaign on either side into account, and drops an ended one', () => {
		const running = [entry(1, 500, 400, '2026-10-09T00:00:00Z'), entry(3, 1500)];
		expect(planSavingsPercent(running[1], running, NOW)).toBeNull();
		const ended = [entry(1, 500, 400, '2026-10-07T00:00:00Z'), entry(3, 1350)];
		expect(planSavingsPercent(ended[1], ended, NOW)).toBe(10);
	});
	it('says nothing for the one month package, without one, or when nothing is saved', () => {
		const all = [entry(1, 500), entry(3, 1500)];
		expect(planSavingsPercent(all[0], all, NOW)).toBeNull();
		expect(planSavingsPercent(all[1], all, NOW)).toBeNull();
		expect(planSavingsPercent(entry(12, 4800), [entry(12, 4800)], NOW)).toBeNull();
	});
});

describe('planSavingsPercent at the edges', () => {
	it('never says 100% for a paid plan, and hides a plan with no price', () => {
		const huge = [entry(1, 10_000_000), entry(12, 600)];
		expect(planSavingsPercent(huge[1], huge, NOW)).toBe(99);
		const free = [entry(1, 500), entry(3, 0)];
		expect(planSavingsPercent(free[1], free, NOW)).toBeNull();
	});
	it('rounds down, so it never promises more than the prices give', () => {
		const all = [entry(1, 1000), entry(3, 2001)];
		expect(planSavingsPercent(all[1], all, NOW)).toBe(33);
		const almost = [entry(1, 1000), entry(3, 2980)];
		expect(planSavingsPercent(almost[1], almost, NOW)).toBeNull();
	});
});

describe('planArt', () => {
	it('gives the year its own picture and the shorter packages the month one', () => {
		expect(planArt(12)).toBe('year');
		expect(planArt(3)).toBe('month');
		expect(planArt(1)).toBe('month');
	});
});
