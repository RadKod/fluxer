// SPDX-License-Identifier: AGPL-3.0-or-later

// A player's client nudges the server once a turn deadline has passed: 1 s after it, plus 0–1500 ms of jitter so
// the four players of a table do not all hit the server in the same instant. The server's cron is the backstop.
export const TABLE_GAME_TICK_DELAY_MS = 1000;
export const TABLE_GAME_TICK_JITTER_MS = 1500;

// Room members who are neither players nor spectators read the table list on room open, 2 s after a table seat
// changes (plus a spread of 5 ms per person in the room, 5 s at most), and at most once every 10 s. An overflow
// spectator (past the live limit) polls the table every 5 s.
export const TABLE_GAME_LIST_DEBOUNCE_MS = 2000;
export const TABLE_GAME_LIST_SPREAD_MS_PER_PERSON = 5;
export const TABLE_GAME_LIST_SPREAD_MAX_MS = 5000;
export const TABLE_GAME_LIST_MIN_INTERVAL_MS = 10_000;
export const TABLE_GAME_OVERFLOW_POLL_MS = 5000;

// An ended table's KV key lives this long (the API's TABLE_GAME_TTL_S.ended); after it the slot can hold a new table.
export const TABLE_GAME_ENDED_TTL_S = 300;
