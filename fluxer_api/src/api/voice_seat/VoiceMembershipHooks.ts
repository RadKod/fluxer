// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID} from '@app/api/BrandedTypes';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {
	getChannelRepository,
	getInstanceConfigRepository,
	getTableGameService,
	getVoiceActivityService,
	getVoiceSeatService,
} from '@app/api/middleware/ServiceSingletons';
import type {TableGameService} from '@app/api/table_game/TableGameService';
import type {VoiceActivityService} from '@app/api/voice_activity/VoiceActivityService';
import {VOICE_MEMBERSHIP_HOOK_CONCURRENCY, VOICE_MEMBERSHIP_HOOK_TIMEOUT_MS} from '@app/api/voice_seat/VoiceSeatLimits';
import type {VoiceParticipantContext, VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {resolveVoiceRoomAssignment} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';

export interface VoiceMembershipHookServices {
	voiceSeatService(): Pick<
		VoiceSeatService,
		'onParticipantJoined' | 'onParticipantLeft' | 'onVoiceStateRemoved' | 'onRoomFinished'
	>;
	tableGameService(): Pick<TableGameService, 'onVoiceJoined' | 'onVoiceLeft' | 'tableSeatFor'>;
	voiceActivityService(): Pick<VoiceActivityService, 'onRoomFinished'>;
	channelRepository(): {findUnique(channelId: ChannelID): Promise<{roomTheme: string | null; type: number} | null>};
	instanceConfigRepository(): Pick<InstanceConfigRepository, 'getVoiceRoomConfig'>;
}

type HookName = 'joined' | 'left' | 'room_finished';

// The LiveKit webhook and the gateway voice_state_remove RPC call these. Every call returns at once: the work runs
// detached, at most `concurrency` at a time and aborted after `timeoutMs`, so a slow seat write never holds a webhook.
// A full pool drops the call with a warning; the client seat fallback, the ghost-seat checks (fallback repair,
// explicit pick, full-room reconcile), room_finished and the table presence check cover it.
export function createVoiceMembershipHooks(
	services: VoiceMembershipHookServices,
	limits = {concurrency: VOICE_MEMBERSHIP_HOOK_CONCURRENCY, timeoutMs: VOICE_MEMBERSHIP_HOOK_TIMEOUT_MS},
) {
	let active = 0;
	let hung = 0;

	// A call keeps its slot until its work settles, even past the timeout, so the limit bounds the work really in
	// flight (a hanging LiveKit keeps at most `concurrency` calls per process). The timeout only logs and aborts; the
	// work checks the signal before each further KV or LiveKit write. The drop warning carries the hung count.
	function runDetached(hook: HookName, work: (signal: AbortSignal) => Promise<unknown>): void {
		if (active >= limits.concurrency) {
			Logger.warn({hook, hung}, 'voice membership hook dropped');
			return;
		}
		active++;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			hung++;
			controller.abort();
			Logger.warn({hook}, 'voice membership hook timed out');
		}, limits.timeoutMs);
		void work(controller.signal)
			.catch((error: unknown) => {
				if (error !== controller.signal.reason) Logger.warn({hook, error}, 'voice membership hook failed');
			})
			.finally(() => {
				clearTimeout(timer);
				if (controller.signal.aborted) hung--;
				active--;
			});
	}

	async function gamesEnabled(): Promise<boolean> {
		return resolveVoiceRoomAssignment(await services.instanceConfigRepository().getVoiceRoomConfig()).games;
	}

	// The seat and the table are independent: one failing never skips the other.
	async function both(seat: () => Promise<void>, table: () => Promise<void>): Promise<void> {
		const results = await Promise.allSettled([seat(), gamesEnabled().then((on) => (on ? table() : undefined))]);
		for (const result of results) {
			if (result.status === 'rejected') throw result.reason;
		}
	}

	return {
		async onJoined(ctx: VoiceParticipantContext): Promise<void> {
			const member = {userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId};
			runDetached('joined', (signal) =>
				both(
					() =>
						services.voiceSeatService().onParticipantJoined(
							ctx,
							{
								roomTheme: async () => {
									const channel = await services.channelRepository().findUnique(ctx.channelId);
									return channel?.type === ChannelTypes.GUILD_VOICE ? channel.roomTheme : undefined;
								},
								tableSeat: () =>
									services.tableGameService().tableSeatFor({userId: ctx.userId, channelId: ctx.channelId}),
							},
							signal,
						),
					() => services.tableGameService().onVoiceJoined(member),
				),
			);
		},

		// 'rpc' (gateway voice_state_remove) drops the j: mark before the pool, so a dropped hook never leaves it behind,
		// and backs up the table presence; seats follow the webhook alone.
		async onLeft(ctx: VoiceParticipantContext, source: 'webhook' | 'rpc'): Promise<void> {
			if (source === 'rpc') {
				await services
					.voiceSeatService()
					.onVoiceStateRemoved(ctx)
					.catch((error: unknown) => Logger.warn({hook: 'left', error}, 'voice membership mark not dropped'));
			}
			const member = {userId: ctx.userId, guildId: ctx.guildId, channelId: ctx.channelId};
			runDetached('left', (signal) =>
				both(
					async () => {
						if (source === 'webhook') await services.voiceSeatService().onParticipantLeft(ctx, signal);
					},
					() => services.tableGameService().onVoiceLeft(member),
				),
			);
		},

		// The seat state and the activity key are independent: one failing never skips the other.
		async onRoomFinished(channelId: ChannelID): Promise<void> {
			runDetached('room_finished', async () => {
				const results = await Promise.allSettled([
					services.voiceSeatService().onRoomFinished(channelId),
					services.voiceActivityService().onRoomFinished(channelId),
				]);
				for (const result of results) {
					if (result.status === 'rejected') throw result.reason;
				}
			});
		},
	};
}

// Resolved per call, never at module load: ServiceSingletons may still be evaluating when this module loads.
export const VoiceMembershipHooks = createVoiceMembershipHooks({
	voiceSeatService: () => getVoiceSeatService(),
	tableGameService: () => getTableGameService(),
	voiceActivityService: () => getVoiceActivityService(),
	channelRepository: () => getChannelRepository().channelData,
	instanceConfigRepository: () => getInstanceConfigRepository(),
});
