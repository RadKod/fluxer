%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_disabled_session_tests).
-include_lib("eunit/include/eunit.hrl").

disabled_friend_subscription_keeps_state_test() ->
    with_authority(fun() ->
        set_authority(false),
        State = state(),
        ?assertEqual(State, session_game_activity:subscribe(State))
    end).

disabled_friend_sync_keeps_state_test() ->
    with_authority(fun() ->
        set_authority(false),
        State = state(),
        ?assertEqual(State, session_game_activity:sync_friends(State))
    end).

disabled_friend_presence_keeps_game_state_test() ->
    with_authority(fun() ->
        set_authority(false),
        lists:foreach(
            fun(Status) ->
                State = state(),
                Data = presence(Status),
                ?assertEqual(
                    {true, State}, session_game_activity:prepare(presence_update, Data, State)
                ),
                ?assertEqual(
                    {true, State},
                    session_game_activity:prepare(<<"PRESENCE_UPDATE">>, Data, State)
                )
            end,
            [<<"online">>, <<"idle">>, <<"offline">>]
        )
    end).

normal_friend_presence_dispatch_survives_enable_and_disable_test() ->
    with_authority(fun() ->
        lists:foreach(
            fun(Enabled) ->
                set_authority(Enabled),
                State = (state())#{game_activity_subscription_pid => self()},
                {noreply, Next} = session_dispatch:handle_dispatch(
                    presence_update, presence(<<"idle">>), State
                ),
                assert_normal_presence(),
                ?assertEqual(1, maps:get(seq, Next)),
                assert_availability(Enabled, Next)
            end,
            [false, true, false]
        )
    end).

assert_normal_presence() ->
    receive
        {dispatch, presence_update, Data, _} ->
            ?assertEqual(presence(<<"idle">>), Data)
    after 300 -> ?assert(false)
    end.

assert_availability(true, State) ->
    ?assertEqual(#{2 => true}, maps:get(game_activity_available, State));
assert_availability(false, State) ->
    ?assertNot(maps:is_key(game_activity_available, State)).

reopen_rebuilds_authoritative_friends_test() ->
    with_authority(fun() ->
        set_authority(false),
        Original = state(),
        ?assertEqual(Original, session_game_activity:subscribe(Original)),
        set_authority(true),
        Open = session_game_activity:subscribe(Original#{
            game_activity_subscription_pid => self()
        }),
        ?assertEqual(
            #{2 => true, 3 => true}, maps:get(game_activity_subscription_friends, Open)
        ),
        set_authority(false),
        Closed = session_game_activity:rollout(
            maps:remove(game_activity_subscription_pid, Open)
        ),
        Changed = Closed#{relationships := #{3 => 1, 5 => 1}},
        ?assertEqual(Changed, session_game_activity:sync_friends(Changed)),
        set_authority(true),
        Reopened = session_game_activity:subscribe(Changed#{
            game_activity_subscription_pid => self()
        }),
        ?assertEqual(
            #{3 => true, 5 => true}, maps:get(game_activity_subscription_friends, Reopened)
        ),
        ?assertEqual(
            #{3 => true, 5 => true}, maps:get(game_activity_subscription_targets, Reopened)
        )
    end).

reopen_online_friend_refreshes_after_disabled_offline_test() ->
    with_authority(fun() ->
        set_authority(true),
        {true, Online} = session_game_activity:prepare(
            presence_update,
            presence(<<"online">>),
            (state())#{game_activity_subscription_pid => self()}
        ),
        set_authority(false),
        Closed = session_game_activity:rollout(
            maps:remove(game_activity_subscription_pid, Online)
        ),
        {true, Offline} = session_game_activity:prepare(
            presence_update, presence(<<"offline">>), Closed
        ),
        ?assertEqual(Closed, Offline),
        ?assertEqual(undefined, whereis(presence_manager)),
        set_authority(true),
        Reopened = finish_subscribe(session_game_activity:subscribe(Offline)),
        {true, Visible} = session_game_activity:prepare(
            presence_update, presence(<<"online">>), Reopened
        ),
        ?assert(is_pid(maps:get(game_activity_subscription_pid, Visible, undefined))),
        _ = finish_subscribe(Visible)
    end).

finish_subscribe(State) ->
    Pid = maps:get(game_activity_subscription_pid, State),
    receive
        {game_activity_subscribed, Pid} -> session_game_activity:subscribed(Pid, State)
    after 300 ->
        exit(Pid, kill),
        error(subscription_completion_timeout)
    end.

with_authority(Fun) ->
    Keys = [gateway_rollout_config, {gateway_rollout_config, game_activity_gate}],
    Saved = [{Key, persistent_term:get(Key, missing)} || Key <- Keys],
    try
        Fun()
    after
        lists:foreach(
            fun
                ({Key, missing}) -> persistent_term:erase(Key);
                ({Key, Value}) -> persistent_term:put(Key, Value)
            end,
            Saved
        ),
        drain_dispatches()
    end.

drain_dispatches() ->
    receive
        {dispatch, _, _, _} -> drain_dispatches()
    after 0 -> ok
    end.

presence(Status) ->
    #{<<"user">> => #{<<"id">> => <<"2">>}, <<"status">> => Status}.

state() ->
    #{
        user_id => 7,
        bot => false,
        seq => 0,
        buffer => [],
        buffer_bytes => 0,
        socket_pid => self(),
        relationships => #{2 => 1, 3 => 1, 4 => 2},
        suppress_presence_updates => false,
        pending_presences => []
    }.

set_authority(Enabled) ->
    persistent_term:put(
        gateway_rollout_config,
        #{<<"game_activity_enabled">> => Enabled, <<"game_activity_epoch">> => 9}
    ),
    persistent_term:put(
        {gateway_rollout_config, game_activity_gate},
        #{epoch => 9, generation => 9, validated_at => erlang:monotonic_time(millisecond)}
    ).
