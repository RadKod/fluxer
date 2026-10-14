// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {MICUPBOT_SLOT_COUNT} from '@app/api/database/types/MicupBotTypes';
import {isMicupBotLive} from '@app/api/guild/micupbot/MicupBotBot';
import {MICUPBOT_VOICE} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {getMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {Logger} from '@app/api/Logger';
import {getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {VOICE_STATE_KV_KEY_PREFIX} from '@app/api/rpc/RpcService';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';

export interface MicupBotVoicePayload {
	turn: number;
	slot_start: number;
}
export interface MicupBotVoiceCounts {
	guilds: number;
	awarded: number;
	capped: number;
	failed: number;
}
export function createMicupBotVoiceRunner(deps: WorkerDependencies) {
	return {
		async queueSlots(nowMs: number): Promise<number> {
			if (!isMicupBotLive(deps.limitConfigService)) return 0;
			const turn = Math.floor(nowMs / MICUPBOT_VOICE.turnMs);
			let queued = 0;
			for (let slot_start = 0; slot_start < MICUPBOT_SLOT_COUNT; slot_start += MICUPBOT_VOICE.slotsPerJob) {
				await deps.workerService.addJob(
					'runMicupBotVoiceSlots',
					{turn, slot_start},
					{jobKey: `v:${turn}:${slot_start}`, skipLedger: true},
				);
				queued++;
			}
			return queued;
		},
		async runSlots({turn, slot_start}: MicupBotVoicePayload): Promise<MicupBotVoiceCounts> {
			const counts: MicupBotVoiceCounts = {guilds: 0, awarded: 0, capped: 0, failed: 0};
			if (!isMicupBotLive(deps.limitConfigService)) return counts;
			const repository = getMicupBotRepository();
			const levels = createMicupBotLevels(deps);
			const kv = deps.kvClient;
			// The hash is a current snapshot, so even a delayed turn consumes today's UTC allowance.
			const day = new Date(Date.now()).toISOString().slice(0, 10);
			try {
				// TEMPORARY: at voice walk lag p95 >60s, move the micupbot lane to a separate process / one slot per job.
				for (let slot = slot_start; slot < slot_start + MICUPBOT_VOICE.slotsPerJob; slot++) {
					let after: GuildID | null = null;
					for (;;) {
						const guilds = await repository.listVoiceSlot(slot, after, MICUPBOT_VOICE.slotPage);
						await mapWithConcurrency(guilds, MICUPBOT_VOICE.guildConcurrency, async (guildId) => {
							counts.guilds++;
							try {
								const guild = await deps.guildRepository.findUnique(guildId);
								if (!guild) {
									await repository.setVoiceGuild(guildId, false);
									return;
								}
								if (!guild.features.has(GuildFeatures.MICUPBOT_LEVELS)) return;
								const config = await getMicupBotGuildConfig(guildId);
								if (!config?.settings.voice_xp_enabled) return;
								if (!(await kv.setnx(`micupbot:vturn:${guildId}:${turn}`, '1', 600))) return;
								// TEMPORARY: HGETALL holds one guild's voice hash in memory; above 10k entries, switch to HSCAN.
								const states = await kv.hgetall(VOICE_STATE_KV_KEY_PREFIX + String(guildId));
								const listeners = new Map<string, Set<UserID>>();
								for (const json of Object.values(states)) {
									let parsed: unknown;
									try {
										parsed = JSON.parse(json);
									} catch {
										continue;
									}
									if (typeof parsed !== 'object' || parsed === null) continue;
									const state = parsed as Record<string, unknown>;
									if (
										typeof state.user_id !== 'string' ||
										!/^[1-9]\d{0,19}$/.test(state.user_id) ||
										typeof state.channel_id !== 'string' ||
										!/^[1-9]\d{0,19}$/.test(state.channel_id) ||
										state.deaf !== false ||
										state.self_deaf !== false ||
										state.channel_id === String(guild.afkChannelId) ||
										config.settings.no_xp_channel_ids?.has(createChannelID(BigInt(state.channel_id)))
									)
										continue;
									let users = listeners.get(state.channel_id);
									if (!users) {
										users = new Set();
										listeners.set(state.channel_id, users);
									}
									users.add(createUserID(BigInt(state.user_id)));
								}
								// TEMPORARY: unremoved gateway connections can be stale; >=2 distinct listeners only partly limits this.
								// If stale entries are observed, add expiry/reconciliation in the gateway persistence path.
								const eligibleMembers = new Map<UserID, boolean>();
								const eligible = new Set<UserID>();
								for (const users of listeners.values()) {
									if (users.size < MICUPBOT_VOICE.minListeners) continue;
									// TEMPORARY: 16 member checks per guild; above 10k listeners or walk lag p95 >60s, split into
									// channel/member jobs with shared eligible-listener counts before awards.
									const checked = await mapWithConcurrency(
										[...users],
										MICUPBOT_VOICE.guildConcurrency,
										async (userId) => {
											if (!eligibleMembers.has(userId)) {
												const member = await deps.guildRepository.getMember(guildId, userId);
												const canEarnXp =
													member &&
													!member.isTemporary &&
													![...member.roleIds].some((roleId) => config.settings.no_xp_role_ids?.has(roleId));
												const user = canEarnXp ? await deps.userRepository.findUnique(userId) : null;
												eligibleMembers.set(userId, !!user && !user.isBot);
											}
											return eligibleMembers.get(userId) ? userId : null;
										},
									);
									const channelListeners = checked.filter((userId) => userId !== null);
									if (channelListeners.length >= MICUPBOT_VOICE.minListeners) {
										for (const userId of channelListeners) eligible.add(userId);
									}
								}
								for (const userId of eligible) {
									const key = `micupbot:vday:${guildId}:${userId}:${day}`;
									const turns = await kv.incr(key);
									if (turns === 1) await kv.expire(key, 172800);
									if (turns > MICUPBOT_VOICE.dailyTurns) {
										counts.capped++;
										continue;
									}
									const awarded = await levels.award({
										guildId,
										userId,
										xp: MICUPBOT_VOICE.xpPerTurn,
										source: 'voice',
										channelId: null,
									});
									if (awarded !== null) counts.awarded++;
								}
							} catch {
								counts.failed++;
							}
						});
						if (guilds.length < MICUPBOT_VOICE.slotPage) break;
						after = guilds[guilds.length - 1]!;
					}
				}
				return counts;
			} finally {
				const lag_ms = Math.max(0, Date.now() - turn * MICUPBOT_VOICE.turnMs);
				const summary = {turn, slot_start, ...counts, lag_ms};
				if (lag_ms > 60_000) Logger.warn(summary, 'MicupBOT voice walk done');
				else Logger.info(summary, 'MicupBOT voice walk done');
			}
		},
	};
}
