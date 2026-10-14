// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {HttpStatus} from '@fluxer/constants/src/HttpConstants';
import {i18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const logger = new Logger('VoiceSeatCommands');

const SEAT_CHANGES_BUSY_DESCRIPTOR = msg({
	message: 'Lots of people are changing seats right now. Try again in a moment.',
	comment:
		'3D voice room: short notice when a seat could not be taken because too many seat changes happen in this channel at once (rate limit). Retrying a second later works.',
});

// Asks the server for a lounge or watch seat (null = any free lounge seat). The client never writes the seat itself
// : the server answers through the participant's `micup.seat` LiveKit attribute, which the room reads. The
// channel allows a limited number of seat changes a second (429); that one is told for a seat the user picked,
// never for the room's own any-seat request (useSeatFallback), which nobody asked for. The rest are only logged.
export async function takeVoiceSeat(channelId: string, seat: string | null): Promise<void> {
	const connectionId = MediaEngine.channelId === channelId ? MediaEngine.connectionId : null;
	if (!connectionId) return;
	try {
		await http.put(Endpoints.CHANNEL_VOICE_SEAT(channelId), {body: {connection_id: connectionId, seat}});
	} catch (error) {
		logger.warn('Voice seat request failed', error);
		if (seat !== null && error instanceof HttpError && error.status === HttpStatus.TOO_MANY_REQUESTS)
			ToastCommands.createToast({type: 'info', children: i18n._(SEAT_CHANGES_BUSY_DESCRIPTOR)});
	}
}
