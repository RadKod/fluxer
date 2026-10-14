// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {makeAutoObservable} from 'mobx';

export interface SeatViewSeat {
	readonly channelId: string;
	readonly slot: string;
	readonly seat: string;
}

// The table I sit at (player or watch seat) in the room on screen, and whether I turned to the room ("Back to
// room") while keeping the seat. The room writes the seat; leaving the seat view by any path turns away; the table
// label's "Back to table" turns back.
class VoiceSceneSeatView {
	seat: SeatViewSeat | null = null;
	dismissed = false;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		ResettableStates.register(this, this.reset);
	}

	reset(): void {
		this.seat = null;
		this.dismissed = false;
	}

	get viewing(): boolean {
		return this.seat !== null && !this.dismissed;
	}

	isAt(channelId: string, slot: string): boolean {
		return this.seat?.channelId === channelId && this.seat.slot === slot;
	}

	// A new seat (or none) starts in the seat view again.
	setSeat(seat: SeatViewSeat | null): void {
		if (seat?.channelId === this.seat?.channelId && seat?.seat === this.seat?.seat) return;
		this.seat = seat;
		this.dismissed = false;
	}

	dismiss(): void {
		this.dismissed = true;
	}

	returnToTable(): void {
		this.dismissed = false;
	}
}

export default new VoiceSceneSeatView();
