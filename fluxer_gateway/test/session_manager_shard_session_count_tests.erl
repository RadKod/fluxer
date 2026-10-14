%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_manager_shard_session_count_tests).

-include_lib("eunit/include/eunit.hrl").

%% Each session manager shard writes its whole session count into its own slot after every
%% callback, so the node count (gateway_connection_metrics:session_count/0) never drifts.

shard_state(Index, Count) ->
    #{
        sessions => maps:from_list([
            {integer_to_binary(N), {self(), make_ref()}}
         || N <- lists:seq(1, Count)
        ]),
        session_refs => #{},
        identify_attempts => [],
        pending_identifies => #{},
        identify_workers => #{},
        shard_index => Index
    }.

with_slots(ShardCount, Fun) ->
    gateway_connection_metrics:reset_for_tests(),
    ok = gateway_connection_metrics:init_sessions(ShardCount),
    try
        Fun()
    after
        gateway_connection_metrics:reset_for_tests()
    end.

in_process(Fun) ->
    Parent = self(),
    Pid = spawn(fun() -> Parent ! {in_process, self(), Fun()} end),
    receive
        {in_process, Pid, Result} -> Result
    after 1000 -> error(in_process_timeout)
    end.

shard_callbacks_publish_session_count_test() ->
    with_slots(2, fun() ->
        ?assertMatch(
            {noreply, _}, session_manager_shard:handle_info(unrelated, shard_state(1, 3))
        ),
        ?assertEqual(3, gateway_connection_metrics:session_count()),
        ?assertMatch(
            {reply, {ok, 2}, _},
            session_manager_shard:handle_call(
                get_local_count, {self(), make_ref()}, shard_state(0, 2)
            )
        ),
        ?assertEqual(5, gateway_connection_metrics:session_count()),
        ?assertMatch(
            {noreply, _}, session_manager_shard:handle_info(unrelated, shard_state(1, 0))
        ),
        ?assertEqual(2, gateway_connection_metrics:session_count())
    end).

started_shard_clears_its_slot_test() ->
    with_slots(1, fun() ->
        ok = gateway_connection_metrics:note_shard_sessions(0, 4),
        ?assertMatch(
            {ok, _, hibernate},
            in_process(fun() -> session_manager_shard:init(#{shard_index => 0}) end)
        ),
        ?assertEqual(0, gateway_connection_metrics:session_count())
    end).

terminated_shard_clears_its_slot_test() ->
    with_slots(1, fun() ->
        ok = gateway_connection_metrics:note_shard_sessions(0, 4),
        ok = session_manager_shard:terminate(shutdown, shard_state(0, 4)),
        ?assertEqual(0, gateway_connection_metrics:session_count())
    end).

session_manager_start_creates_one_slot_per_shard_test() ->
    gateway_connection_metrics:reset_for_tests(),
    {ok, Pid} = gen_server:start(session_manager, [], []),
    try
        ?assertEqual(0, gateway_connection_metrics:session_count()),
        ok = gateway_connection_metrics:note_shard_sessions(0, 1),
        ?assertEqual(1, gateway_connection_metrics:session_count())
    after
        gen_server:stop(Pid),
        gateway_connection_metrics:reset_for_tests()
    end.
