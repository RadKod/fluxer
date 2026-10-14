// SPDX-License-Identifier: AGPL-3.0-or-later

import {RACK_CELLS, trimRack} from '@app/features/table_game/components/okey/OkeyRackModel';
import {TABLE_GAME_ENDED_TTL_S} from '@app/features/table_game/state/TableGameTiming';
import type {TableGameSummary, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {makeAutoObservable} from 'mobx';

// A rack slot is a tile token or a gap the player left between groups.
export type RackSlot = string | null;
export type TableWatchMode = 'live' | 'polling';
export interface TablePanelRequest {
	readonly channelId: string;
	readonly slot: string;
	readonly id: number;
}

function tableKey(channelId: string, slot: string): string {
	return `${channelId}:${slot}`;
}

// A table slot's version only grows. Once an ended table's key expired a new table starts over from version 0, so
// below an ended table a lobby is a new table; once the end was seen longer ago than the key lives, any lower state
// is. Inside that window a lower running or ended state is a late reply about the old table.
function isNewTable(next: TableGameSummary, current: TableGameSummary, currentSeenAt: number): boolean {
	if (current.status !== 'ended' || next.version >= current.version) return false;
	return next.status === 'lobby' || Date.now() - currentSeenAt > TABLE_GAME_ENDED_TTL_S * 1000;
}

function isNewer(
	next: TableGameSummary,
	current: TableGameSummary,
	currentSeenAt: number,
	allowSameVersion: boolean,
): boolean {
	if (isNewTable(next, current, currentSeenAt)) return true;
	return allowSameVersion ? next.version >= current.version : next.version > current.version;
}

function rackOf(view: TableGameView): ReadonlyArray<string> | null {
	const gameView = view.game_view;
	return gameView && (gameView.game === 'okey' || gameView.game === 'okey101') ? gameView.rack : null;
}

// Keeps the player's own arrangement: a gone tile leaves its cell empty so nothing after it moves; a new tile goes
// right after the last tile or, when the rack's last cell is taken, into the first gap (as OkeyBoard places a side tile).
function reconcileRack(order: ReadonlyArray<RackSlot>, rack: ReadonlyArray<string>): Array<RackSlot> {
	const inRack = new Set(rack);
	const cells = order.map((tile) => (tile !== null && inRack.has(tile) ? tile : null));
	const placed = new Set(cells);
	let end = trimRack(cells).length;
	for (const tile of rack) {
		if (placed.has(tile)) continue;
		if (end < RACK_CELLS) cells[end++] = tile;
		else cells[cells.indexOf(null)] = tile;
	}
	return trimRack(cells);
}

// Panel request ids never repeat (reset() does not rewind them): a table label opens each id once.
let panelRequestCount = 0;

class TableGames {
	lists: Record<string, ReadonlyArray<TableGameSummary>> = {};
	views: Record<string, TableGameView> = {};
	// When each stored view's version first arrived (a same-version REST reply keeps it): an end's age.
	viewSeenAt: Record<string, number> = {};
	racks: Record<string, ReadonlyArray<RackSlot>> = {};
	watchModes: Record<string, TableWatchMode> = {};
	panelRequest: TablePanelRequest | null = null;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	getSummaries(channelId: string): ReadonlyArray<TableGameSummary> {
		return (this.lists[channelId] ?? []).map((summary) => this.getSummary(channelId, summary.slot) ?? summary);
	}

	getSummary(channelId: string, slot: string): TableGameSummary | null {
		const listed = this.lists[channelId]?.find((summary) => summary.slot === slot) ?? null;
		const key = tableKey(channelId, slot);
		const viewed = this.views[key]?.summary ?? null;
		if (!listed || !viewed) return listed ?? viewed;
		return isNewer(listed, viewed, this.viewSeenAt[key] ?? 0, false) ? listed : viewed;
	}

	getView(channelId: string, slot: string): TableGameView | null {
		return this.views[tableKey(channelId, slot)] ?? null;
	}

	getRack(channelId: string, slot: string): ReadonlyArray<RackSlot> {
		return this.racks[tableKey(channelId, slot)] ?? [];
	}

	getWatchMode(channelId: string, slot: string): TableWatchMode | null {
		return this.watchModes[tableKey(channelId, slot)] ?? null;
	}

	// Slots where the user sits at a table that has not ended, from live views and the last list.
	getMyActiveSlots(channelId: string, userId: string): Array<string> {
		const slots = new Set<string>();
		const consider = (summary: TableGameSummary | null) => {
			if (!summary || summary.status === 'ended') return;
			if (summary.players.some((player) => player.user_id === userId)) slots.add(summary.slot);
		};
		for (const summary of this.lists[channelId] ?? []) consider(this.getSummary(channelId, summary.slot));
		for (const [key, view] of Object.entries(this.views)) {
			if (key.startsWith(`${channelId}:`)) consider(this.getSummary(channelId, view.summary.slot));
		}
		return [...slots].sort();
	}

	handleList(channelId: string, tables: ReadonlyArray<TableGameSummary>): void {
		this.lists = {...this.lists, [channelId]: tables};
		// A listed new table means the old one is gone for good: its stored end must not hide the new game's later states.
		const gone = new Set<string>();
		for (const summary of tables) {
			const key = tableKey(channelId, summary.slot);
			const view = this.views[key];
			if (view && isNewTable(summary, view.summary, this.viewSeenAt[key] ?? 0)) gone.add(key);
		}
		if (gone.size === 0) return;
		const keep = ([key]: [string, unknown]) => !gone.has(key);
		this.views = Object.fromEntries(Object.entries(this.views).filter(keep));
		this.racks = Object.fromEntries(Object.entries(this.racks).filter(keep));
		this.viewSeenAt = Object.fromEntries(Object.entries(this.viewSeenAt).filter(keep));
	}

	// Gateway events only move forward; a REST reply of the same version is my own (newer) perspective.
	handleView(channelId: string, view: TableGameView, source: 'event' | 'rest'): boolean {
		const key = tableKey(channelId, view.summary.slot);
		const current = this.views[key];
		if (current && !isNewer(view.summary, current.summary, this.viewSeenAt[key] ?? 0, source === 'rest')) return false;
		this.views = {...this.views, [key]: view};
		if (current?.summary.version !== view.summary.version) this.viewSeenAt = {...this.viewSeenAt, [key]: Date.now()};
		const rack = rackOf(view);
		if (rack) {
			this.racks = {...this.racks, [key]: reconcileRack(this.racks[key] ?? [], rack)};
		} else if (key in this.racks) {
			const {[key]: _, ...rest} = this.racks;
			this.racks = rest;
		}
		return true;
	}

	setRackOrder(channelId: string, slot: string, order: ReadonlyArray<RackSlot>): void {
		const key = tableKey(channelId, slot);
		const view = this.views[key];
		const rack = view ? rackOf(view) : null;
		if (!rack) return;
		const tiles = order.filter((tile): tile is string => tile !== null);
		const inRack = new Set(rack);
		if (tiles.length !== rack.length || new Set(tiles).size !== tiles.length) return;
		if (!tiles.every((tile) => inRack.has(tile))) return;
		this.racks = {...this.racks, [key]: [...order]};
	}

	setWatchMode(channelId: string, slot: string, mode: TableWatchMode | null): void {
		const key = tableKey(channelId, slot);
		if (mode) {
			this.watchModes = {...this.watchModes, [key]: mode};
			return;
		}
		const {[key]: _, ...rest} = this.watchModes;
		this.watchModes = rest;
	}

	// The 3D room asks for a table's panel (a click on a table seat); the table's scene entry opens it.
	requestPanel(channelId: string, slot: string): void {
		this.panelRequest = {channelId, slot, id: ++panelRequestCount};
	}

	reset(): void {
		this.panelRequest = null;
		this.lists = {};
		this.views = {};
		this.viewSeenAt = {};
		this.racks = {};
		this.watchModes = {};
	}
}

export default new TableGames();
