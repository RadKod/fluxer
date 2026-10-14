// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';
import type {MicupBotAutomodRuleRow, MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {MICUPBOT_SETTINGS_CACHE} from '@app/api/guild/micupbot/MicupBotConstants';
import {getCacheService, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';

export type MicupBotGuildConfig = {settings: MicupBotGuildSettingsRow; rules: Array<MicupBotAutomodRuleRow>};

const MAX_BYTES = 64 * 1024 * 1024;
const entries = new Map<GuildID, {value: MicupBotGuildConfig | null; expiresAt: number; bytes: number}>();
const inflight = new Map<GuildID, {promise: Promise<MicupBotGuildConfig | null>; invalidated: boolean}>();
const invalidations = new Map<GuildID, Promise<void>>();
let totalBytes = 0;

function remove(guildId: GuildID): void {
	const entry = entries.get(guildId);
	if (entry) totalBytes -= entry.bytes;
	entries.delete(guildId);
}

function serialize(value: MicupBotGuildConfig | null): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item === 'bigint') return {type: 'bigint', value: item.toString()};
		if (item instanceof Set) return {type: 'set', value: [...item]};
		return item;
	});
}

function deserialize(json: string): MicupBotGuildConfig | null {
	return JSON.parse(json, (key, item) => {
		if (item?.type === 'bigint') return BigInt(item.value);
		if (item?.type === 'set') return new Set(item.value);
		if (key === 'updated_at' && typeof item === 'string') return new Date(item);
		return item;
	});
}

export async function getMicupBotGuildConfig(guildId: GuildID): Promise<MicupBotGuildConfig | null> {
	const invalidation = invalidations.get(guildId);
	if (invalidation) await invalidation;
	const entry = entries.get(guildId);
	if (entry && Date.now() < entry.expiresAt) return entry.value;
	remove(guildId);
	const pending = inflight.get(guildId);
	if (pending) return pending.promise;
	const load = async (): Promise<MicupBotGuildConfig | null> => {
		const json = await getCacheService().getOrSet(
			`micupbot:settings:${guildId}`,
			async () => {
				const repository = getMicupBotRepository();
				const settings = await repository.getSettings(guildId);
				return serialize(settings ? {settings, rules: await repository.listRules(guildId)} : null);
			},
			// Bound stale repopulation by another process to the accepted 30-second shared TTL.
			MICUPBOT_SETTINGS_CACHE.ttlMs / 1000,
		);
		const value = deserialize(json);
		// Conservative UTF-16 JSON estimate plus entry overhead; the count cap also bounds tiny/negative entries.
		const bytes = json.length * 2 + 128;
		if (!flight.invalidated && bytes <= MAX_BYTES) {
			while (entries.size >= MICUPBOT_SETTINGS_CACHE.maxEntries || totalBytes + bytes > MAX_BYTES) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				remove(oldest);
			}
			entries.set(guildId, {value, expiresAt: Date.now() + MICUPBOT_SETTINGS_CACHE.ttlMs, bytes});
			totalBytes += bytes;
		}
		return value;
	};
	const flight = {
		invalidated: false,
		promise: load().finally(() => {
			inflight.delete(guildId);
		}),
	};
	inflight.set(guildId, flight);
	return flight.promise;
}

export async function invalidateMicupBotGuildConfig(guildId: GuildID): Promise<void> {
	const existing = invalidations.get(guildId);
	if (existing) return existing;
	remove(guildId);
	const pending = inflight.get(guildId);
	if (pending) pending.invalidated = true;
	const invalidate = async () => {
		// Finish the old write before deleting the shared copy; rejected reads still need invalidation.
		if (pending) await Promise.allSettled([pending.promise]);
		await getCacheService().delete(`micupbot:settings:${guildId}`);
	};
	const promise = invalidate().finally(() => {
		invalidations.delete(guildId);
	});
	invalidations.set(guildId, promise);
	return promise;
}
