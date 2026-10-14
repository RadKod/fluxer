// SPDX-License-Identifier: AGPL-3.0-or-later

// Table game timings the API owns; the shared ones live in @fluxer/constants TableGameConstants.
export const TABLE_GAME_LOBBY_TIMEOUT_MS = 600_000;
export const TABLE_GAME_WATCH_TICKET_TTL_S = 60;
export const TABLE_GAME_PRESENCE_LOCK_S = 60;
export const TABLE_GAME_TIMER_LEASE_S = 30;
export const TABLE_GAME_TIMER_TICK_BUDGET_MS = 800;

// KV lifetimes of a table. A lobby lives 60 s past its 10 minute deadline so the timer, not the TTL, ends
// it: the end path frees the locks and the table seats, an expired key frees nothing.
export const TABLE_GAME_TTL_S = {lobby: 660, playing: 7200, ended: 300} as const;
export const TABLE_GAME_USER_LOCK_TTL_S = 21_600;
// A player lock younger than this is never stale: its table write (create or join CAS) may still be on the way.
export const TABLE_GAME_LOCK_SETTLE_S = 10;

export const TABLE_GAME_CAS_ATTEMPTS = 3;
export const TABLE_GAME_DISPATCH_CONCURRENCY = 16;
export const TABLE_GAME_TIMER_SHARD_CONCURRENCY = 4;
export const TABLE_GAME_TIMER_BATCH = 200;
export const TABLE_GAME_TIMER_WARN_MS = 500;

// V5: a channel's table list is built at most once a second however many in the room read it (KV {tg_list:<channel>}).
export const TABLE_GAME_LIST_CACHE_S = 1;
// A reader that misses the list while another one builds it looks again this often, this many times, then builds it.
export const TABLE_GAME_LIST_WAIT_MS = 20;
export const TABLE_GAME_LIST_WAIT_ATTEMPTS = 5;
