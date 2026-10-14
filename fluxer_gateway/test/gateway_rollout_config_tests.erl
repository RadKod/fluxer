%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_rollout_config_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

-define(PERSISTENT_TERM_KEY, gateway_rollout_config).

default_config() ->
    #{
        <<"session_rollout_percentage">> => 100,
        <<"session_rollout_mode">> => <<"modulo">>,
        <<"guild_rollout_percentage">> => 100,
        <<"rpc_request_timeout_ms">> => 10000,
        <<"max_concurrent_session_starts">> => 512,
        <<"max_concurrent_guild_starts">> => 256,
        <<"gateway_dispatch_relay_shards">> => 32,
        <<"gateway_dispatch_relay_max_queue">> => 50000,
        <<"voice_e2ee_scope">> => <<"guild_feature_only">>,
        <<"max_connections">> => 0,
        <<"game_activity_enabled">> => false,
        <<"game_activity_epoch">> => 0
    }.

default_config_has_expected_keys_test() ->
    persistent_term:erase(?PERSISTENT_TERM_KEY),
    Config = gateway_rollout_config:get(),
    ?assertEqual(100, maps:get(<<"session_rollout_percentage">>, Config)),
    ?assertEqual(<<"modulo">>, maps:get(<<"session_rollout_mode">>, Config)),
    ?assertEqual(100, maps:get(<<"guild_rollout_percentage">>, Config)),
    ?assertEqual(10000, maps:get(<<"rpc_request_timeout_ms">>, Config)),
    ?assertEqual(512, maps:get(<<"max_concurrent_session_starts">>, Config)),
    ?assertEqual(256, maps:get(<<"max_concurrent_guild_starts">>, Config)),
    ?assertEqual(0, maps:get(<<"max_connections">>, Config)),
    ?assertEqual(0, gateway_rollout_config:max_connections()).

max_connections_rollout_validation_test() ->
    Defaults = default_config(),
    lists:foreach(
        fun(Value) ->
            ?assertMatch(
                {ok, #{<<"max_connections">> := Value}},
                gateway_rollout_config_validate:validate(
                    #{<<"max_connections">> => Value}, Defaults
                )
            )
        end,
        [0, 1, 200000]
    ),
    lists:foreach(
        fun(Value) ->
            ?assertMatch(
                {error, {invalid_field, <<"max_connections">>, Value}},
                gateway_rollout_config_validate:validate(
                    #{<<"max_connections">> => Value}, Defaults
                )
            )
        end,
        [-1, 200001, 1.5, <<"18">>, null]
    ).

validate_config_rejects_bad_rollout_values_test() ->
    ?assertMatch(
        {error, {invalid_field, <<"session_rollout_percentage">>, 101}},
        gateway_rollout_config_validate:validate(
            #{
                <<"session_rollout_percentage">> => 101
            },
            default_config()
        )
    ),
    ?assertMatch(
        {error, {invalid_field, <<"session_rollout_mode">>, <<"open">>}},
        gateway_rollout_config_validate:validate(
            #{
                <<"session_rollout_mode">> => <<"open">>
            },
            default_config()
        )
    ),
    ?assertMatch(
        {error, {invalid_field, <<"max_concurrent_session_starts">>, 0}},
        gateway_rollout_config_validate:validate(
            #{
                <<"max_concurrent_session_starts">> => 0
            },
            default_config()
        )
    ).

validate_config_ignores_unknown_keys_and_merges_defaults_test() ->
    {ok, Config} = gateway_rollout_config_validate:validate(
        #{
            <<"session_rollout_percentage">> => 25,
            <<"unknown">> => unsafe
        },
        default_config()
    ),
    ?assertEqual(25, maps:get(<<"session_rollout_percentage">>, Config)),
    ?assertEqual(false, maps:is_key(<<"unknown">>, Config)),
    ?assertEqual(256, maps:get(<<"max_concurrent_guild_starts">>, Config)).

nats_payload_updates_config_and_notifies_subscribers_test() ->
    persistent_term:put(?PERSISTENT_TERM_KEY, default_config()),
    Config = (default_config())#{
        <<"session_rollout_percentage">> => 42,
        <<"max_connections">> => 18
    },
    Payload = iolist_to_binary(
        json:encode(#{
            <<"type">> => <<"gateway_rollout_config">>,
            <<"config">> => Config
        })
    ),
    State = #{
        subscribers => [{self(), make_ref()}],
        nats_subscription => undefined,
        nats_monitor => undefined
    },
    ?assertMatch(
        {noreply, State},
        gateway_rollout_config:handle_info(
            {nats_msg, <<"config.gateway.rollout">>, Payload, undefined},
            State
        )
    ),
    ?assertEqual(42, gateway_rollout_config:session_rollout_percentage()),
    receive
        rollout_config_changed -> ok
    after 100 ->
        ?assert(false)
    end,
    ?assertEqual(18, gateway_rollout_config:max_connections()),
    persistent_term:put(?PERSISTENT_TERM_KEY, default_config()).

nats_duplicate_payload_does_not_notify_subscribers_test() ->
    persistent_term:put(?PERSISTENT_TERM_KEY, default_config()),
    Payload = iolist_to_binary(
        json:encode(#{
            <<"type">> => <<"gateway_rollout_config">>,
            <<"config">> => default_config()
        })
    ),
    State = #{
        subscribers => [{self(), make_ref()}],
        nats_subscription => undefined,
        nats_monitor => undefined
    },
    ?assertMatch(
        {noreply, State},
        gateway_rollout_config:handle_info(
            {nats_msg, <<"config.gateway.rollout">>, Payload, undefined},
            State
        )
    ),
    receive
        rollout_config_changed -> ?assert(false)
    after 100 ->
        ok
    end.

validate_config_rejects_relay_max_queue_zero_test() ->
    ?assertMatch(
        {error, {invalid_field, <<"gateway_dispatch_relay_max_queue">>, 0}},
        gateway_rollout_config_validate:validate(
            #{<<"gateway_dispatch_relay_max_queue">> => 0},
            default_config()
        )
    ).

validate_config_rejects_relay_max_queue_above_kill_threshold_test() ->
    Above = process_health_watchdog:kill_threshold() + 1,
    ?assertMatch(
        {error, {invalid_field, <<"gateway_dispatch_relay_max_queue">>, Above}},
        gateway_rollout_config_validate:validate(
            #{<<"gateway_dispatch_relay_max_queue">> => Above},
            default_config()
        )
    ).

validate_config_accepts_relay_max_queue_range_bounds_test() ->
    Ceiling = process_health_watchdog:kill_threshold(),
    ?assertMatch(
        {ok, #{<<"gateway_dispatch_relay_max_queue">> := 1}},
        gateway_rollout_config_validate:validate(
            #{<<"gateway_dispatch_relay_max_queue">> => 1},
            default_config()
        )
    ),
    ?assertMatch(
        {ok, #{<<"gateway_dispatch_relay_max_queue">> := Ceiling}},
        gateway_rollout_config_validate:validate(
            #{<<"gateway_dispatch_relay_max_queue">> => Ceiling},
            default_config()
        )
    ).

nats_resubscribed_recovers_missed_rollout_test() ->
    with_rollout_api(fun(State, Config) ->
        ?assertEqual(200000, gateway_ip_connections:node_connection_limit()),
        _ = fetch_and_finish({nats_resubscribed, <<"config.gateway.rollout">>}, State),
        ?assertEqual(1, gateway_ip_connections:node_connection_limit()),
        ?assertEqual(Config, gateway_rollout_config:get()),
        ?assertEqual(1, meck:num_calls(rpc_client, call, '_')),
        receive
            rollout_config_changed -> ok
        after 100 ->
            ?assert(false)
        end
    end).

failed_rollout_fetch_retries_test_() ->
    [
        {Name, fun() ->
            with_rollout_api(fun(State, Config) ->
                meck:expect(rpc_client, call, fun(_) -> {error, timeout} end),
                Failed = fetch_and_finish(Message, State),
                ?assertEqual(200000, gateway_ip_connections:node_connection_limit()),
                ?assertEqual(1, meck:num_calls(rpc_client, call, '_')),
                receive
                    rollout_config_changed -> ?assert(false)
                after 0 ->
                    ok
                end,
                meck:expect(rpc_client, call, fun(_) -> {ok, #{<<"config">> => Config}} end),
                Started = erlang:monotonic_time(millisecond),
                Retry =
                    receive
                        {timeout, _, fetch_initial_config} = Timeout -> Timeout
                    after 2000 ->
                        ?assert(false)
                    end,
                ?assert(erlang:monotonic_time(millisecond) - Started >= 500),
                Recovered = fetch_and_finish(Retry, Failed),
                ?assertEqual(Config, gateway_rollout_config:get()),
                ?assertEqual(1, gateway_ip_connections:node_connection_limit()),
                ?assertEqual(2, meck:num_calls(rpc_client, call, '_')),
                ?assertEqual(false, maps:is_key(fetch_retry_timer, Recovered)),
                ?assertEqual(false, maps:is_key(fetch_retry_attempt, Recovered)),
                receive
                    rollout_config_changed -> ok
                after 100 ->
                    ?assert(false)
                end
            end)
        end}
     || {Name, Message} <- [
            {"startup fetch retries after failure", fetch_initial_config},
            {"resubscription fetch retries after failure",
                {nats_resubscribed, <<"config.gateway.rollout">>}}
        ]
    ].

rollout_fetch_backoff_is_capped_and_single_test() ->
    with_rollout_api(fun(State, Config) ->
        meck:expect(rpc_client, call, fun(_) -> {error, no_responders} end),
        Failed = lists:foldl(
            fun(Attempt, Previous) ->
                OldTimer = maps:get(fetch_retry_timer, Previous, undefined),
                Next = fetch_and_finish(
                    {nats_resubscribed, <<"config.gateway.rollout">>}, Previous
                ),
                Timer = maps:get(fetch_retry_timer, Next),
                Remaining = erlang:read_timer(Timer),
                ?assert(is_integer(Remaining)),
                ?assert(Remaining > 0 andalso Remaining =< 30000),
                case Attempt >= 6 of
                    true -> ?assert(Remaining >= 22000);
                    false -> ok
                end,
                case OldTimer of
                    undefined ->
                        ok;
                    _ ->
                        ?assertEqual(false, erlang:read_timer(OldTimer)),
                        ?assertEqual(
                            {noreply, Next},
                            gateway_rollout_config:handle_info(
                                {timeout, OldTimer, fetch_initial_config}, Next
                            )
                        )
                end,
                Next
            end,
            State,
            lists:seq(0, 8)
        ),
        LastTimer = maps:get(fetch_retry_timer, Failed),
        meck:expect(rpc_client, call, fun(_) -> {ok, #{<<"config">> => Config}} end),
        Recovered = fetch_and_finish(fetch_initial_config, Failed),
        ?assertEqual(false, erlang:read_timer(LastTimer)),
        ?assertEqual(Config, gateway_rollout_config:get()),
        ?assertEqual(false, maps:is_key(fetch_retry_attempt, Recovered)),
        {noreply, Recovered} = gateway_rollout_config:handle_info(
            {timeout, LastTimer, fetch_initial_config}, Recovered
        ),
        ?assertEqual(10, meck:num_calls(rpc_client, call, '_'))
    end).

fetch_and_finish(Message, State) ->
    {noreply, Fetching} = gateway_rollout_config:handle_info(Message, State),
    case maps:get(fetch_worker, Fetching, undefined) of
        {_, _, Token, _} ->
            receive
                {rollout_fetch_result, Token, _} = Result ->
                    {noreply, Finished} = gateway_rollout_config:handle_info(Result, Fetching),
                    Finished
            after 1000 -> error(fetch_result_missing)
            end;
        undefined ->
            Fetching
    end.

periodic_fetch_uses_one_timer_and_one_worker_test() ->
    with_rollout_api(fun(State, _Config) ->
        Parent = self(),
        meck:expect(rpc_client, call, fun(_) ->
            Parent ! {fetch_started, self()},
            receive
                release -> {error, unavailable}
            end
        end),
        {noreply, Fetching} = gateway_rollout_config:handle_info(fetch_initial_config, State),
        #{fetch_worker := {Worker, _, _, _}} = Fetching,
        try
            receive
                {fetch_started, Worker} -> ok
            after 1000 -> ?assert(false)
            end,
            Timer = maps:get(fetch_periodic_timer, Fetching),
            ?assert(erlang:read_timer(Timer) > 0),
            ?assertEqual(
                {noreply, Fetching},
                gateway_rollout_config:handle_info(fetch_initial_config, Fetching)
            ),
            _ = erlang:cancel_timer(Timer),
            {noreply, Refetched} = gateway_rollout_config:handle_info(
                {timeout, Timer, fetch_periodic_config}, Fetching
            ),
            NextTimer = maps:get(fetch_periodic_timer, Refetched),
            ?assertNotEqual(Timer, NextTimer),
            ?assertEqual(
                {noreply, Refetched},
                gateway_rollout_config:handle_info(
                    {timeout, Timer, fetch_periodic_config}, Refetched
                )
            ),
            ?assertEqual(maps:get(fetch_worker, Fetching), maps:get(fetch_worker, Refetched)),
            receive
                {fetch_started, _} -> ?assert(false)
            after 0 -> ok
            end,
            Worker ! release,
            #{fetch_worker := {_, _, Token, _}} = Refetched,
            Result =
                receive
                    {rollout_fetch_result, Token, _} = Reply -> Reply
                after 1000 -> error(fetch_result_missing)
                end,
            {noreply, Finished} = gateway_rollout_config:handle_info(Result, Refetched),
            ?assertEqual(1, meck:num_calls(rpc_client, call, '_')),
            gateway_rollout_config:terminate(normal, Finished),
            ?assertEqual(false, erlang:read_timer(NextTimer))
        after
            gateway_rollout_config:terminate(normal, Fetching)
        end
    end).

resubscription_during_fetch_reconciles_after_old_result_test() ->
    with_rollout_api(fun(State, Config) ->
        Parent = self(),
        OldConfig = (default_config())#{<<"max_connections">> => 18},
        meck:expect(rpc_client, call, fun(_) ->
            Parent ! {fetch_started, self()},
            receive
                {release, Response} -> {ok, #{<<"config">> => Response}}
            end
        end),
        {noreply, Fetching} = gateway_rollout_config:handle_info(reconcile_config, State),
        #{fetch_worker := {Worker, _, Token, _}} = Fetching,
        receive
            {fetch_started, Worker} -> ok
        after 1000 -> ?assert(false)
        end,
        {noreply, Pending} = gateway_rollout_config:handle_info(
            {nats_resubscribed, <<"config.gateway.rollout">>}, Fetching
        ),
        ?assertEqual(
            {noreply, Pending},
            gateway_rollout_config:handle_info(
                {nats_resubscribed, <<"config.gateway.rollout">>}, Pending
            )
        ),
        Worker ! {release, OldConfig},
        Result =
            receive
                {rollout_fetch_result, Token, _} = Reply -> Reply
            after 1000 -> error(fetch_result_missing)
            end,
        {noreply, Reconciling} = gateway_rollout_config:handle_info(Result, Pending),
        try
            #{fetch_worker := {NextWorker, _, NextToken, _}} = Reconciling,
            receive
                {fetch_started, NextWorker} -> ok
            after 1000 -> ?assert(false)
            end,
            NextWorker ! {release, Config},
            NextResult =
                receive
                    {rollout_fetch_result, NextToken, _} = NextReply -> NextReply
                after 1000 -> error(fetch_result_missing)
                end,
            {noreply, Finished} = gateway_rollout_config:handle_info(NextResult, Reconciling),
            ?assertEqual(1, gateway_ip_connections:node_connection_limit()),
            ?assert(gateway_rollout_config:game_activity_allowed()),
            ?assertEqual(Config, gateway_rollout_config:get()),
            ?assertNot(maps:is_key(fetch_worker, Finished)),
            ?assertEqual(2, meck:num_calls(rpc_client, call, '_'))
        after
            gateway_rollout_config:terminate(normal, Reconciling)
        end
    end).

nats_update_fences_older_fetch_snapshot_test() ->
    with_rollout_api(fun(State, Config) ->
        Parent = self(),
        meck:expect(rpc_client, call, fun(_) ->
            Parent ! {fetch_started, self()},
            receive
                {release, Response} -> {ok, #{<<"config">> => Response}}
            end
        end),
        {noreply, Fetching} = gateway_rollout_config:handle_info(reconcile_config, State),
        #{fetch_worker := {Worker, _, Token, _}} = Fetching,
        receive
            {fetch_started, Worker} -> ok
        after 1000 -> ?assert(false)
        end,
        Payload = iolist_to_binary(json:encode(#{<<"config">> => Config})),
        {noreply, Updated} = gateway_rollout_config:handle_info(
            {nats_msg, <<"config.gateway.rollout">>, Payload, undefined}, Fetching
        ),
        ?assertEqual(1, gateway_ip_connections:node_connection_limit()),
        ?assertNot(gateway_rollout_config:game_activity_allowed()),
        Worker ! {release, Config#{<<"max_connections">> => 200000}},
        Result =
            receive
                {rollout_fetch_result, Token, _} = Reply -> Reply
            after 1000 -> error(fetch_result_missing)
            end,
        {noreply, Reconciling} = gateway_rollout_config:handle_info(Result, Updated),
        try
            ?assertEqual(1, gateway_ip_connections:node_connection_limit()),
            ?assertNot(gateway_rollout_config:game_activity_allowed()),
            #{fetch_worker := {NextWorker, _, NextToken, _}} = Reconciling,
            receive
                {fetch_started, NextWorker} -> ok
            after 1000 -> ?assert(false)
            end,
            NextWorker ! {release, Config},
            NextResult =
                receive
                    {rollout_fetch_result, NextToken, _} = NextReply -> NextReply
                after 1000 -> error(fetch_result_missing)
                end,
            {noreply, Finished} = gateway_rollout_config:handle_info(NextResult, Reconciling),
            ?assertEqual(Config, gateway_rollout_config:get()),
            ?assert(gateway_rollout_config:game_activity_allowed()),
            ?assertNot(maps:is_key(fetch_worker, Finished)),
            ?assertEqual(2, meck:num_calls(rpc_client, call, '_'))
        after
            gateway_rollout_config:terminate(normal, Reconciling)
        end
    end).

invalid_nats_does_not_supersede_authoritative_fetch_test() ->
    with_rollout_api(fun(State, Config) ->
        Token = make_ref(),
        Timer = erlang:send_after(10000, self(), unused),
        Fetching = State#{fetch_worker => {self(), make_ref(), Token, Timer}},
        Payload = iolist_to_binary(json:encode(#{<<"max_connections">> => 200001})),
        ?assertEqual(
            {noreply, Fetching},
            gateway_rollout_config:handle_info(
                {nats_msg, <<"config.gateway.rollout">>, Payload, undefined}, Fetching
            )
        ),
        {noreply, Finished} = gateway_rollout_config:handle_info(
            {rollout_fetch_result, Token, {ok, #{<<"config">> => Config}}}, Fetching
        ),
        ?assertEqual(Config, gateway_rollout_config:get()),
        ?assert(gateway_rollout_config:game_activity_allowed()),
        ?assertNot(maps:is_key(fetch_worker, Finished))
    end).

with_rollout_api(Test) ->
    Previous = gateway_rollout_config:get(),
    Config = (default_config())#{
        <<"max_connections">> => 1,
        <<"session_rollout_percentage">> => 42,
        <<"session_rollout_mode">> => <<"random">>,
        <<"guild_rollout_percentage">> => 35,
        <<"rpc_request_timeout_ms">> => 5000,
        <<"max_concurrent_session_starts">> => 128,
        <<"max_concurrent_guild_starts">> => 64,
        <<"gateway_dispatch_relay_shards">> => 16,
        <<"gateway_dispatch_relay_max_queue">> => 25000,
        <<"voice_e2ee_scope">> => <<"platform_wide">>,
        <<"game_activity_enabled">> => true,
        <<"game_activity_epoch">> => 1
    },
    State = #{
        subscribers => [{self(), make_ref()}],
        nats_subscription => make_ref(),
        nats_monitor => undefined
    },
    meck:new(rpc_client, [passthrough]),
    meck:expect(rpc_client, call, fun(_) -> {ok, #{<<"config">> => Config}} end),
    persistent_term:put(?PERSISTENT_TERM_KEY, (default_config())#{
        <<"max_connections">> => 200000
    }),
    try
        Test(State, Config)
    after
        meck:unload(rpc_client),
        persistent_term:put(?PERSISTENT_TERM_KEY, Previous),
        drain_rollout_notifications()
    end.

drain_rollout_notifications() ->
    receive
        rollout_config_changed -> drain_rollout_notifications()
    after 0 -> ok
    end.
