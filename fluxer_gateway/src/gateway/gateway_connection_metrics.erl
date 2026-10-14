%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_connection_metrics).
-typing([eqwalizer]).

%% WebSockets this node accepted, those it closed because of a connection limit
%% (gateway_ip_connections, gateway_handler), and the sessions its session manager shards hold
%% (session_manager_shard). Rendered by metrics_handler.

-export([
    init/0,
    init_sessions/1,
    record_accepted/0,
    record_rejection/1,
    reasons/0,
    snapshot/0,
    note_shard_sessions/2,
    session_count/0,
    reset_for_tests/0
]).

-define(COUNTERS_KEY, gateway_connection_metrics_counters).
-define(SESSIONS_KEY, gateway_connection_metrics_sessions).
-define(COUNTER_COUNT, 9).

-type family() :: ipv4 | ipv6.
-type reason() ::
    {too_many_connections, family()}
    | too_many_connections_ipv6_48
    | at_capacity
    | unidentified_at_capacity
    | identify_at_capacity
    | identify_timeout
    | identify_dropped.
-type counter() :: accepted | reason().

-export_type([family/0, reason/0]).

%% Called by fluxer_gateway_app at startup, before the listener takes WebSockets, so no two first
%% users race to create the counters. Kept when they already exist.
-spec init() -> ok.
init() ->
    _ = counters_ref(),
    ok.

%% Called by session_manager:init/1 before its shards start: one fresh slot per shard, since the
%% shards of an earlier start are gone.
-spec init_sessions(pos_integer()) -> ok.
init_sessions(ShardCount) ->
    persistent_term:put(?SESSIONS_KEY, counters:new(ShardCount, [])),
    ok.

-spec record_accepted() -> ok.
record_accepted() ->
    counters:add(counters_ref(), index(accepted), 1).

-spec record_rejection(reason()) -> ok.
record_rejection(Reason) ->
    counters:add(counters_ref(), index(Reason), 1).

-spec reasons() -> [reason()].
reasons() ->
    [
        {too_many_connections, ipv4},
        {too_many_connections, ipv6},
        too_many_connections_ipv6_48,
        at_capacity,
        unidentified_at_capacity,
        identify_at_capacity,
        identify_timeout,
        identify_dropped
    ].

-spec snapshot() -> #{counter() => non_neg_integer()}.
snapshot() ->
    Counters = counters_ref(),
    maps:from_list([{C, counters:get(Counters, index(C))} || C <- [accepted | reasons()]]).

%% A shard writes its whole session count after every callback, so a crashed shard leaves no
%% drift behind: its replacement writes 0 when it starts. Never fails (the shard must not crash).
-spec note_shard_sessions(non_neg_integer(), non_neg_integer()) -> ok.
note_shard_sessions(ShardIndex, Count) ->
    case session_slots() of
        undefined -> ok;
        Slots -> put_slot(Slots, ShardIndex + 1, Count)
    end.

%% Sessions held by this node's session manager shards, including those kept for Resume after
%% their socket closed. 0 on a node that runs no session manager.
-spec session_count() -> non_neg_integer().
session_count() ->
    case session_slots() of
        undefined -> 0;
        Slots -> max(0, sum_slots(Slots, maps:get(size, counters:info(Slots)), 0))
    end.

-spec session_slots() -> counters:counters_ref() | undefined.
session_slots() ->
    case persistent_term:get(?SESSIONS_KEY, undefined) of
        undefined -> undefined;
        Slots -> eqwalizer:dynamic_cast(Slots)
    end.

-spec put_slot(counters:counters_ref(), integer(), non_neg_integer()) -> ok.
put_slot(Slots, Index, Count) ->
    try
        counters:put(Slots, Index, Count)
    catch
        error:badarg -> ok
    end.

-spec sum_slots(counters:counters_ref(), integer(), integer()) -> integer().
sum_slots(Slots, Index, Sum) when Index > 0 ->
    sum_slots(Slots, Index - 1, Sum + counters:get(Slots, Index));
sum_slots(_Slots, _Index, Sum) ->
    Sum.

-spec index(counter()) -> 1..?COUNTER_COUNT.
index(accepted) -> 1;
index({too_many_connections, ipv4}) -> 2;
index({too_many_connections, ipv6}) -> 3;
index(too_many_connections_ipv6_48) -> 4;
index(at_capacity) -> 5;
index(identify_at_capacity) -> 6;
index(identify_timeout) -> 7;
index(unidentified_at_capacity) -> 8;
index(identify_dropped) -> 9.

-spec counters_ref() -> counters:counters_ref().
counters_ref() ->
    case persistent_term:get(?COUNTERS_KEY, undefined) of
        undefined ->
            new_counters();
        Counters ->
            valid_counters_or_new(Counters)
    end.

-spec valid_counters_or_new(term()) -> counters:counters_ref().
valid_counters_or_new(Counters) ->
    case validate_counters(Counters) of
        {ok, Ref} -> Ref;
        error -> new_counters()
    end.

-spec validate_counters(term()) -> {ok, counters:counters_ref()} | error.
validate_counters(Counters) ->
    try
        Ref = eqwalizer:dynamic_cast(Counters),
        _ = counters:get(Ref, ?COUNTER_COUNT),
        {ok, Ref}
    catch
        _:_ -> error
    end.

-spec new_counters() -> counters:counters_ref().
new_counters() ->
    Counters = counters:new(?COUNTER_COUNT, [write_concurrency]),
    persistent_term:put(?COUNTERS_KEY, Counters),
    Counters.

-spec reset_for_tests() -> ok.
reset_for_tests() ->
    persistent_term:erase(?COUNTERS_KEY),
    persistent_term:erase(?SESSIONS_KEY),
    ok.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

snapshot_defaults_to_zero_test() ->
    reset_for_tests(),
    ?assertEqual(
        #{
            accepted => 0,
            {too_many_connections, ipv4} => 0,
            {too_many_connections, ipv6} => 0,
            too_many_connections_ipv6_48 => 0,
            at_capacity => 0,
            unidentified_at_capacity => 0,
            identify_at_capacity => 0,
            identify_timeout => 0,
            identify_dropped => 0
        },
        snapshot()
    ).

records_each_counter_test() ->
    reset_for_tests(),
    Reasons = [
        {too_many_connections, ipv4},
        {too_many_connections, ipv6},
        {too_many_connections, ipv6},
        too_many_connections_ipv6_48,
        at_capacity,
        at_capacity,
        unidentified_at_capacity,
        identify_at_capacity,
        identify_timeout,
        identify_dropped,
        identify_dropped
    ],
    lists:foreach(fun(R) -> ok = record_rejection(R) end, Reasons),
    ok = record_accepted(),
    ?assertEqual(
        #{
            accepted => 1,
            {too_many_connections, ipv4} => 1,
            {too_many_connections, ipv6} => 2,
            too_many_connections_ipv6_48 => 1,
            at_capacity => 2,
            unidentified_at_capacity => 1,
            identify_at_capacity => 1,
            identify_timeout => 1,
            identify_dropped => 2
        },
        snapshot()
    ).

init_creates_counters_once_test() ->
    reset_for_tests(),
    ok = init(),
    Counters = persistent_term:get(?COUNTERS_KEY),
    Parent = self(),
    Pids = [
        spawn(fun() -> Parent ! {recorded, self(), record_accepted()} end)
     || _ <- lists:seq(1, 50)
    ],
    [
        receive
            {recorded, Pid, ok} -> ok
        after 1000 -> error(record_timeout)
        end
     || Pid <- Pids
    ],
    ?assertEqual(Counters, persistent_term:get(?COUNTERS_KEY)),
    ?assertEqual(50, maps:get(accepted, snapshot())),
    reset_for_tests().

init_keeps_counts_and_starts_fresh_session_slots_test() ->
    reset_for_tests(),
    ok = record_accepted(),
    ok = init(),
    ok = init_sessions(3),
    ?assertEqual(1, maps:get(accepted, snapshot())),
    ?assertEqual(0, session_count()),
    ok = note_shard_sessions(0, 4),
    ok = note_shard_sessions(2, 5),
    ?assertEqual(9, session_count()),
    ok = note_shard_sessions(0, 1),
    ?assertEqual(6, session_count()),
    ok = init(),
    ok = init_sessions(3),
    ?assertEqual(0, session_count()),
    ?assertEqual(1, maps:get(accepted, snapshot())),
    reset_for_tests().

session_slots_ignore_unknown_shards_test() ->
    reset_for_tests(),
    ?assertEqual(ok, note_shard_sessions(0, 3)),
    ?assertEqual(0, session_count()),
    ok = init_sessions(1),
    ?assertEqual(ok, note_shard_sessions(1, 3)),
    ?assertEqual(0, session_count()),
    reset_for_tests().

-endif.
