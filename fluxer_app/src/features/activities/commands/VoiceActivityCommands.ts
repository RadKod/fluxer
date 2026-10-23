// SPDX-License-Identifier: AGPL-3.0-or-later

import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {parseVoiceActivitySession} from '@app/features/activities/utils/VoiceActivityMetadata';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import * as NavigationCommands from '@app/features/navigation/commands/NavigationCommands';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ME} from '@fluxer/constants/src/AppConstants';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';
import {i18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const logger = new Logger('VoiceActivityCommands');

const ALREADY_RUNNING_DESCRIPTOR = msg({
	message: 'An activity is already running in this channel.',
	comment: 'Voice activities: toast when someone else started an activity a moment before mine. One runs at a time.',
});
const START_FAILED_DESCRIPTOR = msg({
	message: "Couldn't start the activity. Try again in a moment.",
	comment: 'Voice activities: toast when the server refused or failed to start the picked activity.',
});
const END_FAILED_DESCRIPTOR = msg({
	message: "Couldn't end the activity. Try again in a moment.",
	comment: 'Voice activities: toast when ending the running activity failed.',
});

export type VoiceActivityError = 'conflict' | 'not_in_voice' | 'disabled' | 'failed';
export type VoiceActivityOutcome = {ok: true} | {ok: false; error: VoiceActivityError};

const OK: VoiceActivityOutcome = {ok: true};

// The server checks membership by this connection, as for table games.
function myConnectionId(channelId: string): string | null {
	return MediaEngine.channelId === channelId ? MediaEngine.connectionId : null;
}

function failure(error: unknown): VoiceActivityOutcome {
	const code = failureCode(error);
	if (code === APIErrorCodes.VOICE_ACTIVITY_CONFLICT) return {ok: false, error: 'conflict'};
	if (code === APIErrorCodes.USER_NOT_IN_VOICE) return {ok: false, error: 'not_in_voice'};
	if (code === APIErrorCodes.FEATURE_TEMPORARILY_DISABLED) return {ok: false, error: 'disabled'};
	return {ok: false, error: 'failed'};
}

export async function fetchVoiceActivity(channelId: string): Promise<void> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return;
	try {
		const {body} = await http.get<unknown>(Endpoints.CHANNEL_ACTIVITY(channelId), {
			query: {connection_id: connectionId},
		});
		if (myConnectionId(channelId)) VoiceActivities.handleSession(channelId, parseVoiceActivitySession(body));
	} catch (error) {
		logger.warn('Failed to read the channel activity', error);
	}
}

// startMode comes from a picker entry (ActivityEntry): the activity opens its room in it on my client.
export async function startVoiceActivity(
	channelId: string,
	activityId: VoiceActivityId,
	startMode: string | null = null,
): Promise<VoiceActivityOutcome> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return {ok: false, error: 'not_in_voice'};
	VoiceActivities.setRequest('start');
	try {
		const {body} = await http.post<unknown>(Endpoints.CHANNEL_ACTIVITY(channelId), {
			body: {activity_id: activityId, connection_id: connectionId},
		});
		// The room metadata brings the same session to everyone; the reply only gets here first. Starting joins: the
		// starter plays, but the activity stays a tile until they expand it.
		const session = parseVoiceActivitySession(body);
		if (session && myConnectionId(channelId)) {
			VoiceActivities.join(session.session_id);
			if (startMode) VoiceActivities.setStartMode(session.session_id, startMode);
			VoiceActivities.handleSession(channelId, session);
		}
		return OK;
	} catch (error) {
		logger.warn('Starting the activity failed', error);
		const outcome = failure(error);
		if (!outcome.ok && outcome.error === 'conflict') {
			ToastCommands.createToast({type: 'info', children: i18n._(ALREADY_RUNNING_DESCRIPTOR)});
			void fetchVoiceActivity(channelId);
		} else {
			ToastCommands.createToast({type: 'error', children: i18n._(START_FAILED_DESCRIPTOR)});
		}
		return outcome;
	} finally {
		VoiceActivities.setRequest(null);
	}
}

// Ends the channel's activity. The session id keeps a late reply from clearing a newer session.
export async function endVoiceActivity(channelId: string, sessionId: string): Promise<boolean> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return false;
	VoiceActivities.setRequest('end');
	try {
		await http.delete(Endpoints.CHANNEL_ACTIVITY(channelId), {query: {connection_id: connectionId}});
		if (VoiceActivities.getSession(channelId)?.session_id === sessionId) VoiceActivities.handleSession(channelId, null);
		return true;
	} catch (error) {
		logger.warn('Ending the activity failed', error);
		ToastCommands.createToast({type: 'error', children: i18n._(END_FAILED_DESCRIPTOR)});
		return false;
	} finally {
		VoiceActivities.setRequest(null);
	}
}

export function joinVoiceActivity(channelId: string): void {
	const session = VoiceActivities.getSession(channelId);
	if (session && myConnectionId(channelId)) VoiceActivities.join(session.session_id);
}

// Leaving the voice channel leaves the activity as well; this is leaving the activity and staying in the call.
export function leaveVoiceActivity(channelId: string): void {
	if (VoiceActivities.isJoined(channelId)) VoiceActivities.leave();
}

// Back to the voice channel with the activity filling the call's stage: the mini window's expand button and the
// activities button of a channel I am not looking at.
export function showVoiceActivity(guildId: string | null, channelId: string): void {
	if (!VoiceActivities.getSession(channelId)) return;
	VoiceActivities.expand();
	VoiceActivities.reopenMiniWindow();
	NavigationCommands.selectChannel(guildId ?? ME, channelId);
}
