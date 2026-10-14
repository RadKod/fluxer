// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	getBakuDate,
	getEffectiveShopTryRate,
	getShopTryRateExpiresAt,
	parseCbarTryRate,
	planShopTryRateUpdate,
} from '@app/api/shop/ShopTryRate';
import {UpdateShopSettingsRequest} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {ShopSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {describe, expect, it} from 'vitest';

const xml = (value = '0.4', nominal = '10', date = '02.10.2026') =>
	`<ValCurs Date="${date}"><ValType><Valute Code="USD"><Nominal>1</Nominal><Value>1.7</Value></Valute><Valute Code="TRY"><Nominal>${nominal}</Nominal><Value>${value}</Value></Valute></ValType></ValCurs>`;
const now = new Date('2026-10-05T20:30:00Z');

describe('CBAR display rate', () => {
	it('expires automatic rates at Baku midnight after ten complete calendar days, never an override', () => {
		const config = {try_to_azn_rate_micro: 40_000, try_rate_date: '2026-10-02'};
		expect(getShopTryRateExpiresAt(config, new Date('2026-10-12T19:59:59Z'))).toBe('2026-10-12T20:00:00.000Z');
		expect(getShopTryRateExpiresAt(config, new Date('2026-10-12T20:00:00Z'))).toBeNull();
		expect(getShopTryRateExpiresAt({...config, try_to_azn_rate_override_micro: 50_000}, now)).toBeNull();
		expect(getShopTryRateExpiresAt({}, now)).toBeNull();
	});
	it('preserves an optional nullable automatic display expiry in the public schema', () => {
		const settings = {
			premium_sales_open: true,
			item_sales_open: true,
			premium_discount_percent: 0,
			usd_to_azn_rate: '1.7000',
		};
		for (const expiry of [null, '2026-10-12T20:00:00.000Z']) {
			expect(ShopSettingsResponse.parse({...settings, try_rate_expires_at: expiry})).toEqual({
				...settings,
				try_rate_expires_at: expiry,
			});
		}
		expect(ShopSettingsResponse.parse(settings)).toEqual(settings);
	});

	it('uses Baku calendar day, bulletin date and TRY nominal rather than the requested date', () => {
		expect(getBakuDate(now)).toBe('2026-10-06');
		expect(parseCbarTryRate(xml())).toEqual({rateMicro: 40_000, date: '2026-10-02'});
	});
	it.each([
		xml('0'),
		xml('20'),
		xml('0.0001'),
		xml('oops'),
		xml('0.4', 'lira'),
		xml('0.4', '0'),
		xml('0.4', '1', '31.02.2026'),
		xml().replace('TRY', 'EUR'),
		`<!DOCTYPE x>${xml()}`,
		'<ValCurs>',
	])('rejects unsafe or invalid bulletins: %s', (input) => {
		expect(() => parseCbarTryRate(input)).toThrow();
	});
	it('hides missing and stale automatic rates but keeps a manual override', () => {
		expect(getEffectiveShopTryRate({}, now)).toBeNull();
		expect(getEffectiveShopTryRate({try_to_azn_rate_micro: 40_000, try_rate_date: '2026-09-25'}, now)).toBeNull();
		expect(getEffectiveShopTryRate({try_to_azn_rate_micro: 40_000, try_rate_date: '2026-09-26'}, now)).toBe(40_000);
		expect(getEffectiveShopTryRate({try_to_azn_rate_override_micro: 50_000, try_rate_date: '2020-01-01'}, now)).toBe(
			50_000,
		);
	});
	it('rechecks monotonic date and the 25% guard on each LWT retry and patches only feed fields', () => {
		const bulletin = {rateMicro: 40_000, date: '2026-10-02'};
		expect(planShopTryRateUpdate({try_rate_date: '2026-10-03'}, bulletin, now)).toEqual({});
		expect(planShopTryRateUpdate({try_to_azn_rate_micro: 60_000}, bulletin, now)).toMatchObject({
			try_to_azn_rate_micro: null,
		});
		expect(planShopTryRateUpdate({try_to_azn_rate_micro: 32_000}, bulletin, now)).toEqual({
			try_to_azn_rate_micro: 40_000,
			try_rate_date: '2026-10-02',
			try_rate_fetched_at: now.toISOString(),
		});
		expect(() => planShopTryRateUpdate({}, {rateMicro: 40_000, date: '2026-10-07'}, now)).toThrow();
	});
	it.each([20_000, 60_000])(
		'clears a %s jump and accepts the next safe bulletin without touching the override',
		(rateMicro) => {
			const current = {try_to_azn_rate_micro: 40_000, try_to_azn_rate_override_micro: 45_000};
			const patch = planShopTryRateUpdate(current, {rateMicro, date: '2026-10-02'}, now);
			expect(patch).toEqual({
				try_to_azn_rate_micro: null,
				try_rate_date: '2026-10-02',
				try_rate_fetched_at: now.toISOString(),
			});
			expect(getEffectiveShopTryRate(patch, now)).toBeNull();
			expect(getEffectiveShopTryRate({...current, ...patch}, now)).toBe(45_000);
			expect(planShopTryRateUpdate(patch, {rateMicro, date: '2026-10-03'}, now).try_to_azn_rate_micro).toBe(rateMicro);
		},
	);
	it.each([null, 40_000])('enforces absolute bounds even after clearing (previous=%s)', (previous) => {
		for (const rateMicro of [0, 999, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				planShopTryRateUpdate({try_to_azn_rate_micro: previous}, {rateMicro, date: '2026-10-02'}, now),
			).toThrow('bounds');
		}
		for (const rateMicro of [1_000, 1_000_000]) {
			expect(
				planShopTryRateUpdate({try_to_azn_rate_micro: null}, {rateMicro, date: '2026-10-02'}, now)
					.try_to_azn_rate_micro,
			).toBe(rateMicro);
		}
	});
	it('validates the decimal override and keeps null for automatic mode', () => {
		for (const value of ['0.001', '1', '0.040123', null])
			expect(UpdateShopSettingsRequest.parse({try_to_azn_rate_override: value})).toEqual({
				try_to_azn_rate_override: value,
			});
		for (const value of ['0', '1.01', '0.0009', 'NaN', '1e-2', '0.1234567'])
			expect(UpdateShopSettingsRequest.safeParse({try_to_azn_rate_override: value}).success).toBe(false);
	});
});
