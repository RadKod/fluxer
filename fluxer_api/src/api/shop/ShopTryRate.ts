// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {z} from 'zod';

const DAY_MS = 86_400_000;
const bakuDateFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Baku',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});
const CbarDocument = z.object({
	ValCurs: z.object({
		'@_Date': z.string(),
		ValType: z.array(
			z.object({Valute: z.array(z.object({'@_Code': z.string(), Nominal: z.string(), Value: z.string()}))}),
		),
	}),
});

export interface ShopTryRateBulletin {
	rateMicro: number;
	date: string;
}

export function getBakuDate(now: Date): string {
	return bakuDateFormat.format(now);
}

export function parseCbarTryRate(xml: string): ShopTryRateBulletin {
	if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid CBAR XML');
	const parsed = new XMLParser({
		ignoreAttributes: false,
		processEntities: false,
		parseTagValue: false,
		isArray: (name) => name === 'ValType' || name === 'Valute',
	}).parse(xml);
	const document = CbarDocument.parse(parsed).ValCurs;
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(document['@_Date']);
	if (!match) throw new Error('Invalid CBAR bulletin date');
	const date = `${match[3]}-${match[2]}-${match[1]}`;
	const timestamp = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date)
		throw new Error('Invalid CBAR bulletin date');
	const rates = document.ValType.flatMap((type) => type.Valute).filter((rate) => rate['@_Code'] === 'TRY');
	if (rates.length !== 1) throw new Error('CBAR bulletin must contain one TRY rate');
	const {Nominal, Value} = rates[0]!;
	if (![Nominal, Value].every((value) => /^\d+(?:\.\d+)?$/.test(value)))
		throw new Error('Invalid CBAR TRY value or nominal');
	const nominal = Number(Nominal);
	const rate = Number(Value) / nominal;
	if (!Number.isFinite(nominal) || nominal <= 0 || !Number.isFinite(rate) || rate < 0.001 || rate > 1)
		throw new Error('CBAR TRY rate outside safe bounds');
	return {rateMicro: Math.round(rate * 1_000_000), date};
}

// This callback runs again with the latest config after a lost LWT; neither a newer bulletin nor an admin patch is lost.
export function planShopTryRateUpdate(
	current: Partial<ShopConfig>,
	bulletin: ShopTryRateBulletin,
	now: Date,
): Partial<ShopConfig> {
	if (!Number.isSafeInteger(bulletin.rateMicro) || bulletin.rateMicro < 1_000 || bulletin.rateMicro > 1_000_000)
		throw new Error('CBAR TRY rate outside safe bounds');
	if (current.try_rate_date && bulletin.date < current.try_rate_date) return {};
	if (bulletin.date > getBakuDate(now)) throw new Error('Future CBAR bulletin date');
	const previous = current.try_to_azn_rate_micro;
	const rejectedJump = previous != null && Math.abs(bulletin.rateMicro - previous) * 4 > previous;
	if (rejectedJump)
		Logger.error(
			{previous, ...bulletin},
			'CBAR TRY rate changed by more than 25%; disabling the automatic display rate',
		);
	return {
		try_to_azn_rate_micro: rejectedJump ? null : bulletin.rateMicro,
		try_rate_date: bulletin.date,
		try_rate_fetched_at: now.toISOString(),
	};
}

// Display only, including the store quote frozen at checkout; never changes the payable AZN amount.
export function getEffectiveShopTryRate(config: Partial<ShopConfig>, now: Date): number | null {
	if (config.try_to_azn_rate_override_micro != null) return config.try_to_azn_rate_override_micro;
	if (config.try_to_azn_rate_micro == null || !config.try_rate_date) return null;
	const age = Date.parse(getBakuDate(now)) - Date.parse(config.try_rate_date);
	return Number.isFinite(age) && age >= 0 && age <= 10 * DAY_MS ? config.try_to_azn_rate_micro : null;
}

// Asia/Baku is UTC+04:00. A bulletin is usable through calendar day 10 and expires at the next local midnight.
export function getShopTryRateExpiresAt(config: Partial<ShopConfig>, now: Date): string | null {
	if (config.try_to_azn_rate_override_micro != null || getEffectiveShopTryRate(config, now) === null) return null;
	return new Date(Date.parse(config.try_rate_date!) + 11 * DAY_MS - 4 * 3_600_000).toISOString();
}
