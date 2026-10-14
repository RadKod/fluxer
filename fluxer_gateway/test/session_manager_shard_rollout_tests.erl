%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_manager_shard_rollout_tests).
-include_lib("eunit/include/eunit.hrl").

local_config_change_notifies_registered_session_test() ->
    with_config(fun(Config) ->
        update_config(Config, true, 1),
        with_session_shard(fun(Shard, _Receiver) ->
            Shard ! rollout_config_changed,
            ?assertEqual(payload(true, 1), next_rollout()),
            update_config(Config, false, 2),
            ?assertEqual(payload(false, 2), next_rollout())
        end)
    end).

same_epoch_freshness_close_and_reopen_notify_test() ->
    with_config(fun(Config) ->
        update_config(Config, true, 3),
        with_session_shard(fun(Shard, _Receiver) ->
            Shard ! rollout_config_changed,
            ?assertEqual(payload(true, 3), next_rollout()),
            Gate = persistent_term:get({gateway_rollout_config, game_activity_gate}),
            Config ! {game_activity_stale, maps:get(validated_at, Gate)},
            ?assertEqual(payload(false, 3), next_rollout()),
            update_config(Config, true, 3),
            ?assertEqual(payload(true, 3), next_rollout())
        end)
    end).

unrelated_disabled_config_does_not_fanout_test() ->
    with_config(fun(Config) ->
        update_config(Config, false, 4),
        assert_shards_no_disabled_fanout(Config)
    end).

assert_shards_no_disabled_fanout(Config) ->
    with_session_shard(fun(Shard, _Receiver) ->
        with_presence_shard(fun(PresenceShard) ->
            assert_disabled_config_no_fanout(Config, Shard, PresenceShard)
        end)
    end).

assert_disabled_config_no_fanout(Config, Shard, PresenceShard) ->
    Shard ! rollout_config_changed,
    PresenceShard ! rollout_config_changed,
    ?assertEqual(payload(false, 4), next_rollout()),
    ?assertMatch({game_activity_rollout, _}, next_presence_rollout()),
    ?assertEqual(100, gateway_rollout_config:session_rollout_percentage()),
    update_config(Config, false, 4),
    Config !
        {nats_msg, <<"config.gateway.rollout">>,
            iolist_to_binary(json:encode(#{<<"session_rollout_percentage">> => 50})),
            undefined},
    _ = gen_server:call(Config, barrier),
    ?assertEqual(50, gateway_rollout_config:session_rollout_percentage()),
    _ = gen_server:call(Shard, get_local_count),
    _ = gen_server:call(PresenceShard, get_local_count),
    assert_no_rollout(),
    assert_no_presence_rollout().

presence_same_epoch_close_and_reopen_notify_test() ->
    with_config(fun(Config) ->
        update_config(Config, true, 4),
        with_presence_shard(fun(Shard) ->
            Shard ! rollout_config_changed,
            ?assertMatch({game_activity_rollout, _}, next_presence_rollout()),
            Gate = persistent_term:get({gateway_rollout_config, game_activity_gate}),
            Config ! {game_activity_stale, maps:get(validated_at, Gate)},
            ?assertMatch({game_activity_rollout, _}, next_presence_rollout()),
            update_config(Config, true, 4),
            ?assertMatch({game_activity_rollout, _}, next_presence_rollout()),
            update_config(Config, false, 5),
            ?assertMatch({game_activity_rollout, _}, next_presence_rollout())
        end)
    end).

rollout_batch_is_bounded_to_one_hundred_sessions_test() ->
    set_authority(true, 5, 0),
    Sessions = maps:from_list([
        {integer_to_binary(N), {self(), make_ref()}}
     || N <- lists:seq(1, 201)
    ]),
    State = shard_state(Sessions),
    {noreply, _} = session_manager_shard:handle_info(
        {session_game_activity_rollout_batch, maps:iterator(Sessions)}, State
    ),
    ?assertEqual(100, count_rollout_casts(0)),
    Batch = next_batch(),
    {noreply, _} = session_manager_shard:handle_info(Batch, State),
    ?assertEqual(100, count_rollout_casts(0)),
    {noreply, _} = session_manager_shard:handle_info(next_batch(), State),
    ?assertEqual(1, count_rollout_casts(0)),
    assert_no_batch().

stale_batch_reads_current_authority_at_session_test() ->
    set_authority(true, 6, 0),
    Sessions = #{<<"s">> => {self(), make_ref()}},
    Batch = {session_game_activity_rollout_batch, maps:iterator(Sessions)},
    set_authority(false, 7, 0),
    {noreply, _} = session_manager_shard:handle_info(Batch, shard_state(Sessions)),
    receive
        {'$gen_cast', game_activity_rollout_changed} ->
            {noreply, _} = session:handle_cast(
                game_activity_rollout_changed, receiver_state(self())
            ),
            ?assertEqual(payload(false, 7), next_rollout())
    after 300 -> ?assert(false)
    end.

config_restart_resubscribes_and_reconciles_test() ->
    with_config(fun(Config) ->
        update_config(Config, true, 8),
        with_session_shard(fun(Shard, _Receiver) ->
            Shard ! rollout_config_changed,
            ?assertEqual(payload(true, 8), next_rollout()),
            ?assertEqual(1, subscriber_count(Config, Shard)),
            gen_server:stop(Config),
            ?assertEqual(payload(false, 8), next_rollout()),
            reconcile_restarted(Shard)
        end)
    end).

reconcile_restarted(Shard) ->
    {ok, Restarted} = gen_server:start(
        {local, gateway_rollout_config}, gateway_rollout_config, [], []
    ),
    try
        Shard ! retry_rollout_config,
        _ = gen_server:call(Shard, get_local_count),
        ?assertEqual(1, subscriber_count(Restarted, Shard)),
        assert_no_rollout(),
        update_config(Restarted, true, 9),
        ?assertEqual(payload(true, 9), next_rollout()),
        ?assertEqual(1, subscriber_count(Restarted, Shard)),
        Shard ! retry_rollout_config,
        _ = gen_server:call(Shard, get_local_count),
        ?assertEqual(1, subscriber_count(Restarted, Shard))
    after
        gen_server:stop(Restarted)
    end.

absent_config_retry_observes_freshness_expiry_test() ->
    ?assertEqual(undefined, whereis(gateway_rollout_config)),
    set_authority(true, 10, 0),
    with_session_shard(fun(Shard, _Receiver) ->
        Shard ! retry_rollout_config,
        ?assertEqual(payload(true, 10), next_rollout()),
        State = sys:get_state(Shard),
        Timer = maps:get(rollout_config_retry, State),
        Shard ! retry_rollout_config,
        _ = gen_server:call(Shard, get_local_count),
        ?assertEqual(false, erlang:read_timer(Timer)),
        ?assertNotEqual(Timer, maps:get(rollout_config_retry, sys:get_state(Shard))),
        set_authority(true, 10, 45000),
        Shard ! retry_rollout_config,
        ?assertEqual(payload(false, 10), next_rollout())
    end).

missing_config_starts_closed_test() ->
    ?assertEqual(undefined, whereis(gateway_rollout_config)),
    persistent_term:erase(gateway_rollout_config),
    persistent_term:erase({gateway_rollout_config, game_activity_gate}),
    with_session_shard(fun(Shard, _Receiver) ->
        Shard ! retry_rollout_config,
        ?assertEqual(payload(false, 0), next_rollout())
    end).

with_config(Fun) ->
    Keys = [gateway_rollout_config, {gateway_rollout_config, game_activity_gate}],
    Saved = [{Key, persistent_term:get(Key, missing)} || Key <- Keys],
    lists:foreach(fun persistent_term:erase/1, Keys),
    {ok, Config} = gen_server:start(
        {local, gateway_rollout_config}, gateway_rollout_config, [], []
    ),
    try
        Fun(Config)
    after
        case is_process_alive(Config) of
            true -> gen_server:stop(Config);
            false -> ok
        end,
        drain_messages(),
        lists:foreach(fun restore_authority/1, Saved)
    end.

restore_authority({Key, missing}) ->
    persistent_term:erase(Key);
restore_authority({Key, Value}) ->
    persistent_term:put(Key, Value).

with_session_shard(Fun) ->
    Parent = self(),
    Receiver = spawn(fun() -> receiver_loop(receiver_state(Parent)) end),
    {ok, Shard} = gen_server:start(session_manager_shard, #{shard_index => 0}, []),
    _ = sys:replace_state(Shard, fun(State) ->
        maps:remove(game_activity_gate, State#{sessions := #{<<"s">> => {Receiver, make_ref()}}})
    end),
    try
        Fun(Shard, Receiver)
    after
        gen_server:stop(Shard),
        ReceiverMonitor = monitor(process, Receiver),
        Receiver ! stop,
        receive
            {'DOWN', ReceiverMonitor, process, Receiver, normal} -> ok
        after 300 -> error(receiver_shutdown_timeout)
        end,
        drain_messages()
    end.

with_presence_shard(Fun) ->
    Parent = self(),
    Receiver = spawn(fun() -> presence_receiver_loop(Parent) end),
    {ok, Shard} = gen_server:start(presence_manager_shard, #{shard_index => 0}, []),
    _ = sys:replace_state(Shard, fun(State) ->
        maps:remove(game_activity_gate, State#{presences := #{7 => {Receiver, make_ref()}}})
    end),
    try
        Fun(Shard)
    after
        gen_server:stop(Shard),
        exit(Receiver, kill)
    end.

presence_receiver_loop(Parent) ->
    receive
        {'$gen_cast', Request} ->
            Parent ! {presence_rollout, Request},
            presence_receiver_loop(Parent)
    after 5000 -> error(receiver_inactive_timeout)
    end.

next_presence_rollout() ->
    receive
        {presence_rollout, Request} -> Request
    after 300 -> missing_presence_rollout
    end.

assert_no_presence_rollout() ->
    receive
        {presence_rollout, Request} -> ?assertEqual(no_rollout, Request)
    after 30 -> ok
    end.

update_config(Config, Enabled, Epoch) ->
    Token = make_ref(),
    Timer = erlang:send_after(60000, self(), unused_fetch_timeout),
    _ = sys:replace_state(Config, fun(State) ->
        State#{fetch_worker => {self(), make_ref(), Token, Timer}}
    end),
    Config ! {rollout_fetch_result, Token, {ok, #{<<"config">> => payload(Enabled, Epoch)}}},
    _ = gen_server:call(Config, barrier),
    ok.

subscriber_count(Config, Shard) ->
    length([Pid || {Pid, _} <- maps:get(subscribers, sys:get_state(Config)), Pid =:= Shard]).

receiver_loop(State) ->
    receive
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            receiver_loop(Next);
        stop ->
            ok
    after 5000 -> error(receiver_inactive_timeout)
    end.

receiver_state(Socket) ->
    #{
        user_id => 7,
        bot => false,
        seq => 0,
        buffer => [],
        buffer_bytes => 0,
        socket_pid => Socket,
        relationships => #{},
        suppress_presence_updates => false,
        pending_presences => []
    }.

shard_state(Sessions) ->
    #{
        sessions => Sessions,
        session_refs => #{},
        identify_attempts => [],
        pending_identifies => #{},
        identify_workers => #{},
        shard_index => 0
    }.

set_authority(Enabled, Epoch, Age) ->
    persistent_term:put(gateway_rollout_config, payload(Enabled, Epoch)),
    persistent_term:put({gateway_rollout_config, game_activity_gate}, #{
        epoch => Epoch,
        generation => Epoch,
        validated_at => erlang:monotonic_time(millisecond) - Age
    }).

payload(Enabled, Epoch) ->
    #{<<"game_activity_enabled">> => Enabled, <<"game_activity_epoch">> => Epoch}.

next_rollout() ->
    receive
        {dispatch, gateway_rollout_update, Data, _} -> Data
    after 300 -> missing_rollout
    end.

assert_no_rollout() ->
    receive
        {dispatch, gateway_rollout_update, Data, _} -> ?assertEqual(no_rollout, Data)
    after 30 -> ok
    end.

count_rollout_casts(N) ->
    receive
        {'$gen_cast', game_activity_rollout_changed} -> count_rollout_casts(N + 1)
    after 0 -> N
    end.

next_batch() ->
    receive
        {session_game_activity_rollout_batch, _} = Batch -> Batch
    after 300 -> missing_batch
    end.

assert_no_batch() ->
    receive
        {session_game_activity_rollout_batch, _} -> ?assert(false)
    after 0 -> ok
    end.

drain_messages() ->
    receive
        {dispatch, _, _, _} -> drain_messages();
        {presence_rollout, _} -> drain_messages()
    after 0 -> ok
    end.
