// SPDX-License-Identifier: AGPL-3.0-or-later

type GuildAfkChannelMoveState = Readonly<{
	channelId: string;
	afkChannelId: string | null | undefined;
	afkTimeoutSeconds: number | null | undefined;
	inactiveDurationMs: number;
}>;

function shouldMoveToGuildAfkChannel(state: GuildAfkChannelMoveState): boolean {
	if (!state.afkChannelId || state.channelId === state.afkChannelId) return false;
	if (state.afkTimeoutSeconds == null || state.afkTimeoutSeconds <= 0) return false;
	return state.inactiveDurationMs >= state.afkTimeoutSeconds * 1000;
}

type AfkTickState = Readonly<{
	hasRecentVoiceActivity: boolean;
	// An activity in my channel holds the keyboard inside its panel, so the window never sees those keys; playing
	// it is not being away.
	inActivitySession: boolean;
	channelId: string;
	afkChannelId: string | null | undefined;
	afkTimeoutSeconds: number | null | undefined;
	inactiveDurationMs: number;
}>;

export function shouldMoveToAfkOnTick(state: AfkTickState): boolean {
	if (state.hasRecentVoiceActivity || state.inActivitySession) return false;
	return shouldMoveToGuildAfkChannel({
		channelId: state.channelId,
		afkChannelId: state.afkChannelId,
		afkTimeoutSeconds: state.afkTimeoutSeconds,
		inactiveDurationMs: state.inactiveDurationMs,
	});
}
