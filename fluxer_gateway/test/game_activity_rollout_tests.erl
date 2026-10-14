%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_rollout_tests).
-include_lib("eunit/include/eunit.hrl").

old_config_default_off_test() ->
    persistent_term:erase(gateway_rollout_config),
    Config = gateway_rollout_config:get(),
    ?assertEqual(false, maps:get(<<"game_activity_enabled">>, Config, missing)),
    ?assertEqual(0, maps:get(<<"game_activity_epoch">>, Config, missing)).

schema_rejects_bad_game_fields_test() ->
    persistent_term:erase(gateway_rollout_config),
    Defaults = gateway_rollout_config:get(),
    ?assertMatch(
        {error, _},
        gateway_rollout_config_validate:validate(
            #{<<"game_activity_enabled">> => <<"true">>}, Defaults
        )
    ),
    ?assertMatch(
        {error, _},
        gateway_rollout_config_validate:validate(
            #{<<"game_activity_epoch">> => -1}, Defaults
        )
    ).

old_epoch_rejected_test() ->
    persistent_term:erase(gateway_rollout_config),
    set_config(true, 5),
    set_config(false, 4),
    Config = gateway_rollout_config:get(),
    ?assertEqual(5, maps:get(<<"game_activity_epoch">>, Config, missing)),
    ?assertEqual(true, maps:get(<<"game_activity_enabled">>, Config, missing)).

nats_never_extends_authoritative_freshness_test() ->
    reset(),
    set_config(true, 1),
    ?assertNot(gateway_rollout_config:game_activity_allowed()),
    apply_api(true, 1),
    ?assert(gateway_rollout_config:game_activity_allowed()),
    Gate = persistent_term:get({gateway_rollout_config, game_activity_gate}),
    set_config(true, 1),
    ?assertEqual(Gate, persistent_term:get({gateway_rollout_config, game_activity_gate})).

stale_authoritative_config_denies_test() ->
    reset(),
    apply_api(true, 1),
    set_age(44000),
    ?assert(gateway_rollout_config:game_activity_allowed()),
    set_age(45000),
    ?assertNot(gateway_rollout_config:game_activity_allowed()),
    Generation = gateway_rollout_config:game_activity_generation(),
    apply_api(true, 1),
    ?assert(gateway_rollout_config:game_activity_allowed()),
    ?assertNotEqual(Generation, gateway_rollout_config:game_activity_generation()).

off_on_does_not_resurrect_test() ->
    reset(),
    apply_api(true, 1),
    FirstGeneration = gateway_rollout_config:game_activity_generation(),
    set_config(false, 2),
    ?assertNot(gateway_rollout_config:game_activity_allowed()),
    set_config(true, 3),
    ?assertNot(gateway_rollout_config:game_activity_allowed()),
    ?assertNotEqual(FirstGeneration, gateway_rollout_config:game_activity_generation()),
    apply_api(true, 3),
    ?assert(gateway_rollout_config:game_activity_allowed()),
    ?assertNotEqual(FirstGeneration, gateway_rollout_config:game_activity_generation()).

missed_nats_fetch_reconciles_test() ->
    reset(),
    apply_api(true, 1),
    FirstGeneration = gateway_rollout_config:game_activity_generation(),
    apply_api(true, 3),
    ?assertEqual(3, maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0)),
    ?assertNotEqual(FirstGeneration, gateway_rollout_config:game_activity_generation()).

failed_or_stale_fetch_does_not_refresh_test() ->
    reset(),
    apply_api(true, 5),
    Gate = persistent_term:get({gateway_rollout_config, game_activity_gate}),
    apply_api(true, 4),
    ?assertEqual(Gate, persistent_term:get({gateway_rollout_config, game_activity_gate})),
    apply_api_result({error, unavailable}),
    ?assertEqual(Gate, persistent_term:get({gateway_rollout_config, game_activity_gate})).

stale_timer_notifies_without_blocking_fetch_test() ->
    reset(),
    apply_api(true, 1),
    Stamp = set_age(45000),
    State = state(),
    {noreply, _} = gateway_rollout_config:handle_info(
        {game_activity_stale, Stamp},
        State#{subscribers => [{self(), make_ref()}]}
    ),
    ?assertNot(gateway_rollout_config:game_activity_allowed()),
    receive
        rollout_config_changed -> ok
    after 100 -> ?assert(false)
    end.

bounded_subscriber_notification_test() ->
    reset(),
    Subs = lists:duplicate(205, {self(), make_ref()}),
    Payload = iolist_to_binary(
        json:encode(#{
            <<"game_activity_enabled">> => true,
            <<"game_activity_epoch">> => 1
        })
    ),
    {noreply, _} = gateway_rollout_config:handle_info(
        {nats_msg, <<"config.gateway.rollout">>, Payload, undefined}, (state())#{
            subscribers => Subs
        }
    ),
    ?assertEqual(100, drain_notifications(0)),
    receive
        {notify_rollout_subscribers, Rest} ->
            ?assertEqual(105, length(Rest)),
            gateway_rollout_config:handle_info({notify_rollout_subscribers, Rest}, state())
    after 100 -> ?assert(false)
    end,
    ?assertEqual(100, drain_notifications(0)),
    receive
        {notify_rollout_subscribers, Last} ->
            ?assertEqual(5, length(Last)),
            gateway_rollout_config:handle_info({notify_rollout_subscribers, Last}, state())
    after 100 -> ?assert(false)
    end,
    ?assertEqual(5, drain_notifications(0)).

authoritative_fetch_is_async_and_bounded_test() ->
    reset(),
    Parent = self(),
    meck:new(rpc_client, [non_strict]),
    meck:expect(rpc_client, call, fun(#{<<"type">> := <<"get_gateway_rollout_config">>}) ->
        Parent ! {fetch_started, self()},
        receive
            release ->
                {ok, #{
                    <<"config">> => #{
                        <<"game_activity_enabled">> => true,
                        <<"game_activity_epoch">> => 1
                    }
                }}
        after 2000 -> {error, timeout}
        end
    end),
    try
        {noreply, Fetching} = gateway_rollout_config:handle_info(fetch_initial_config, state()),
        #{fetch_worker := {Worker, _, _, Timer}} = Fetching,
        ?assert(erlang:read_timer(Timer) =< 4500),
        receive
            {fetch_started, Worker} -> ok
        after 1000 -> ?assert(false)
        end,
        ?assertEqual(
            {noreply, Fetching}, gateway_rollout_config:handle_info(reconcile_config, Fetching)
        ),
        Worker ! release,
        receive
            Result = {rollout_fetch_result, _, _} ->
                {noreply, Finished} = gateway_rollout_config:handle_info(Result, Fetching),
                ?assertNot(maps:is_key(fetch_worker, Finished))
        after 1000 -> ?assert(false)
        end,
        ?assert(gateway_rollout_config:game_activity_allowed()),
        ?assertEqual(1, meck:num_calls(rpc_client, call, '_'))
    after
        meck:unload(rpc_client)
    end.

fetch_timeout_cannot_extend_permission_test() ->
    reset(),
    apply_api(true, 1),
    Stamp = set_age(45000),
    Parent = self(),
    meck:new(rpc_client, [non_strict]),
    meck:expect(rpc_client, call, fun(_) ->
        Parent ! {fetch_started, self()},
        receive
            never -> {error, timeout}
        after 2000 -> {error, timeout}
        end
    end),
    try
        {noreply, Fetching} = gateway_rollout_config:handle_info(reconcile_config, state()),
        #{fetch_worker := {Worker, _, Token, Timer}} = Fetching,
        receive
            {fetch_started, Worker} -> ok
        after 1000 -> ?assert(false)
        end,
        {noreply, _} = gateway_rollout_config:handle_info(
            {game_activity_stale, Stamp}, Fetching
        ),
        ?assertNot(gateway_rollout_config:game_activity_allowed()),
        {noreply, Finished} = gateway_rollout_config:handle_info(
            {rollout_fetch_timeout, Token}, Fetching
        ),
        erlang:cancel_timer(Timer),
        ?assertNot(maps:is_key(fetch_worker, Finished)),
        ?assertNot(gateway_rollout_config:game_activity_allowed())
    after
        meck:unload(rpc_client)
    end.

out_of_order_game_epoch_preserves_other_rollouts_test() ->
    reset(),
    apply_api(true, 3),
    Payload = iolist_to_binary(
        json:encode(#{
            <<"game_activity_enabled">> => false,
            <<"game_activity_epoch">> => 2,
            <<"session_rollout_percentage">> => 42
        })
    ),
    gateway_rollout_config:handle_info(
        {nats_msg, <<"config.gateway.rollout">>, Payload, undefined}, state()
    ),
    ?assert(gateway_rollout_config:game_activity_allowed()),
    ?assertEqual(3, maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0)),
    ?assertEqual(42, gateway_rollout_config:session_rollout_percentage()).

reset() ->
    persistent_term:erase(gateway_rollout_config),
    persistent_term:erase({gateway_rollout_config, game_activity_gate}).

state() -> #{subscribers => [], nats_subscription => undefined, nats_monitor => undefined}.

apply_api(Enabled, Epoch) ->
    apply_api_result(
        {ok, #{
            <<"config">> => #{
                <<"game_activity_enabled">> => Enabled,
                <<"game_activity_epoch">> => Epoch
            }
        }}
    ).

apply_api_result(Result) ->
    Token = make_ref(),
    Timer = erlang:send_after(10000, self(), unused),
    State = (state())#{fetch_worker => {self(), make_ref(), Token, Timer}},
    gateway_rollout_config:handle_info({rollout_fetch_result, Token, Result}, State).

set_age(Age) ->
    Key = {gateway_rollout_config, game_activity_gate},
    Stamp = erlang:monotonic_time(millisecond) - Age,
    persistent_term:put(Key, (persistent_term:get(Key))#{validated_at => Stamp}),
    Stamp.

drain_notifications(Count) ->
    receive
        rollout_config_changed -> drain_notifications(Count + 1)
    after 0 -> Count
    end.

set_config(Enabled, Epoch) ->
    Payload = iolist_to_binary(
        json:encode(#{
            <<"game_activity_enabled">> => Enabled,
            <<"game_activity_epoch">> => Epoch
        })
    ),
    gateway_rollout_config:handle_info(
        {nats_msg, <<"config.gateway.rollout">>, Payload, undefined},
        #{subscribers => [], nats_subscription => undefined, nats_monitor => undefined}
    ).
