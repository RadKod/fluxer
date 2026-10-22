// SPDX-License-Identifier: AGPL-3.0-or-later

// Routes the other players' jam messages to the player, each connection on the instrument its user holds in the room
// state. A message from someone without an instrument is dropped, and a connection whose user put theirs down or left
// is let go.

import type {BandJamInstrument, BandJamSeat} from '@app/features/activities/band/BandProtocol';
import {isJamMessage} from '@app/features/activities/band/jam/JamMessages';
import type {JamInstrument} from '@app/features/activities/band/jam/JamScales';
import type {ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';

// Both guitars are one instrument to the engine; each note says whether it is a power chord or the clean tone.
export function jamEngineInstrument(instrument: BandJamInstrument): JamInstrument {
	return instrument === 'rhythm' ? 'guitar' : instrument;
}

export interface JamRemotePlayer {
	setRemoteInstrument(participantId: string, instrument: JamInstrument): void;
	removeRemote(participantId: string): void;
	receive(participantId: string, payload: unknown): void;
}

export class JamRemotes {
	private instruments = new Map<string, BandJamInstrument>();
	// Connection identity -> user id, for the connections the player knows.
	private readonly connections = new Map<string, string>();

	constructor(private readonly player: JamRemotePlayer) {}

	updateSeats(seats: ReadonlyArray<BandJamSeat>): void {
		this.instruments = new Map(seats.map((seat) => [seat.userId, seat.instrument]));
		for (const [identity, userId] of this.connections) {
			const instrument = this.instruments.get(userId);
			if (instrument) {
				this.player.setRemoteInstrument(identity, jamEngineInstrument(instrument));
			} else {
				this.player.removeRemote(identity);
				this.connections.delete(identity);
			}
		}
	}

	// The user id the message plays for, or null when it is not a jam message or its sender holds no instrument.
	receive(from: ActivityParticipant, payload: unknown): string | null {
		if (from.isLocal || !isJamMessage(payload)) return null;
		const instrument = this.instruments.get(from.userId);
		if (!instrument) return null;
		if (!this.connections.has(from.identity)) {
			this.connections.set(from.identity, from.userId);
			this.player.setRemoteInstrument(from.identity, jamEngineInstrument(instrument));
		}
		this.player.receive(from.identity, payload);
		return from.userId;
	}

	userOf(identity: string): string | null {
		return this.connections.get(identity) ?? null;
	}
}
