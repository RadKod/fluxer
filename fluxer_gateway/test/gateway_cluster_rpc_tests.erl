%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_cluster_rpc_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

cluster_rpc_gate_test_() ->
    {foreach, fun setup/0, fun cleanup/1, [
        fun cluster_disabled_preserves_subscription/0,
        fun unreconciled_does_not_subscribe/0,
        fun unreconciled_pool_does_not_subscribe/0,
        fun periodic_reconcile_is_not_discovery/0,
        fun self_included_default_opens_after_discovery/0,
        fun threshold_loss_and_recovery/0,
        fun reconnect_and_enable_stay_gated/0,
        fun late_messages_are_not_dispatched/0,
        fun membership_restart_fails_closed/0,
        fun failed_unsubscribe_closes_connection/0,
        fun monitored_owner_loss_and_restart/0,
        fun timeout_remains_fail_closed/0,
        fun duplicate_readiness_is_idempotent/0,
        fun membership_then_nats_ready_is_idempotent/0,
        fun nats_ready_then_membership_is_idempotent/0,
        fun partial_subscription_retries_only_missing_subjects/0,
        fun failed_subscription_recovers_without_watch_spin/0,
        fun recorded_sid_loss_clears_readiness/0,
        fun replacement_connection_reinstalls_subjects/0,
        fun retry_backoff_is_bounded_and_stale_tokens_are_ignored/0,
        fun health_requires_live_consumers/0,
        fun health_requires_complete_role_subscriptions/0,
        fun health_rechecks_membership_after_consumers/0,
        fun terminate_cancels_subscription_retries/0,
        fun pending_transports_wait_for_ready_before_subscribe_and_retry/0,
        fun pending_pool_slot_does_not_delay_healthy_subscription_or_unsubscribe/0,
        fun early_transport_ready_is_forwarded_after_connection_result/0,
        fun disabled_consumer_retains_ready_transport_for_enable/0,
        fun control_subscription_delivery_stays_active/0,
        fun failed_disconnect_kills_connection/0,
        fun failed_subscriptions_do_not_repeat_on_every_watch/0,
        fun cluster_disabled_failed_unsubscribe_preserves_behavior/0,
        fun unready_transport_is_replaced_when_the_connect_deadline_expires/0,
        fun ready_transport_clears_the_connect_deadline/0,
        fun cluster_disabled_unready_transport_is_replaced_when_the_connect_deadline_expires/0,
        fun cluster_disabled_ready_transport_clears_the_connect_deadline/0,
        fun nats_rpc_disabled_never_subscribes_with_cluster_enabled/0,
        fun pool_slot_that_fails_before_its_connect_result_is_replaced/0,
        fun unready_transport_subscription_returns_and_the_deadline_still_fires/0,
        fun cluster_disabled_unready_transport_subscription_returns_and_the_deadline_still_fires/0,
        fun cluster_disabled_enable_waits_for_a_ready_transport/0
    ]}.

setup() ->
    Keys = [
        {fluxer_gateway, runtime_config},
        {gateway_cluster_membership, rpc_ready},
        {gateway_cluster_membership, members},
        {gateway_cluster_membership, members_by_role},
        {gateway_cluster_membership, node_pod_names},
        {gateway_nats_pool, connections},
        {gateway_nats_pool, reply_publish_failures},
        {{gateway_nats_pool, failure_counts}, 0},
        gateway_cluster_metrics_counters
    ],
    Saved = [{Key, persistent_term:get(Key, undefined)} || Key <- Keys],
    persistent_term:put({fluxer_gateway, runtime_config}, #{
        cluster_enabled => true,
        cluster_min_peers_for_rpc => 2,
        cluster_rpc_stability_ms => 0,
        gateway_role => all
    }),
    meck:new(nats, [no_link]),
    meck:expect(nats, sub, fun(_, _, _) -> {ok, {'$sid', 1}} end),
    meck:expect(nats, unsub, fun(_, _) -> ok end),
    meck:expect(nats, disconnect, fun(_) -> ok end),
    meck:expect(nats, is_ready, fun(_) -> true end),
    Saved.

cleanup(Saved) ->
    case whereis(gateway_cluster_membership) of
        undefined -> ok;
        Pid -> gen_server:stop(Pid)
    end,
    meck:unload(nats),
    lists:foreach(
        fun
            ({Key, undefined}) -> persistent_term:erase(Key);
            ({Key, Value}) -> persistent_term:put(Key, Value)
        end,
        Saved
    ),
    flush_notifications().

cluster_disabled_preserves_subscription() ->
    persistent_term:put({fluxer_gateway, runtime_config}, #{cluster_enabled => false}),
    ?assert(gateway_cluster_membership:rpc_ready()),
    ?assertNotEqual(
        undefined, maps:get(sub, gateway_nats_rpc_handler:do_subscribe(rpc_state()))
    ),
    ?assert(
        maps:is_key(
            0, maps:get(subs, gateway_nats_pool_conn:subscribe_slot(0, self(), pool_state()))
        )
    ).

unreconciled_does_not_subscribe() ->
    start_membership(),
    ?assertEqual(undefined, maps:get(sub, gateway_nats_rpc_handler:do_subscribe(rpc_state()))),
    ?assertEqual(
        #{}, maps:get(subs, gateway_nats_pool_conn:subscribe_slot(0, self(), pool_state()))
    ),
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    ?assertNot(meck:called(nats, sub, '_')).

periodic_reconcile_is_not_discovery() ->
    start_membership(),
    whereis(gateway_cluster_membership) ! reconcile_nodes,
    _ = sys:get_state(gateway_cluster_membership),
    ?assertNot(gateway_cluster_membership:rpc_ready()).

unreconciled_pool_does_not_subscribe() ->
    start_membership(),
    ?assertEqual(
        #{}, maps:get(subs, gateway_nats_pool_conn:subscribe_slot(0, self(), pool_state()))
    ),
    ?assertNot(meck:called(nats, sub, '_')).

self_included_default_opens_after_discovery() ->
    persistent_term:put({fluxer_gateway, runtime_config}, #{
        cluster_enabled => true,
        cluster_min_peers_for_rpc => 1,
        cluster_rpc_stability_ms => 0
    }),
    start_membership(),
    discover([]),
    ?assert(gateway_cluster_membership:rpc_ready()).

threshold_loss_and_recovery() ->
    start_membership(),
    discover([]),
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    discover(['peer@host']),
    ?assert(gateway_cluster_membership:rpc_ready()),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    ?assertNotEqual(undefined, maps:get(sub, Rpc1)),
    ?assertEqual(1, map_size(maps:get(subs, Pool1))),
    whereis(gateway_cluster_membership) ! {nodedown, 'peer@host'},
    _ = sys:get_state(gateway_cluster_membership),
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc1),
    {noreply, Pool2} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool1),
    ?assertEqual(undefined, maps:get(sub, Rpc2)),
    ?assertEqual(#{}, maps:get(subs, Pool2)),
    ?assert(meck:called(nats, unsub, '_')),
    ?assert(maps:get(rpc_enabled, Rpc2)),
    discover(['peer@host']),
    {noreply, Rpc3} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc2),
    ?assertNotEqual(undefined, maps:get(sub, Rpc3)),
    {noreply, Pool3} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool2),
    ?assertEqual(1, map_size(maps:get(subs, Pool3))),
    {noreply, RpcDisabled} = gateway_nats_rpc:handle_info(
        cluster_rpc_readiness_changed,
        Rpc2#{rpc_enabled => false}
    ),
    {noreply, PoolDisabled} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed,
        Pool2#{rpc_enabled => false}
    ),
    ?assertEqual(undefined, maps:get(sub, RpcDisabled)),
    ?assertEqual(#{}, maps:get(subs, PoolDisabled)).

reconnect_and_enable_stay_gated() ->
    start_membership(),
    {noreply, Rpc} = gateway_nats_rpc:handle_info({self(), ready}, rpc_state()),
    {noreply, Pool} = gateway_nats_pool:handle_info({self(), ready}, pool_state()),
    ?assertEqual(undefined, maps:get(sub, Rpc)),
    ?assertEqual(#{}, maps:get(subs, Pool)),
    {reply, ok, EnabledRpc} = gateway_nats_rpc:handle_call(
        enable_rpc_subscription,
        {self(), make_ref()},
        Rpc#{rpc_enabled => false}
    ),
    {reply, ok, EnabledPool} = gateway_nats_pool:handle_call(
        enable_rpc_subscription,
        {self(), make_ref()},
        Pool#{rpc_enabled => false}
    ),
    ?assertEqual(undefined, maps:get(sub, EnabledRpc)),
    ?assertEqual(#{}, maps:get(subs, EnabledPool)).

late_messages_are_not_dispatched() ->
    start_membership(),
    Msg = {
        self(),
        {'$sid', 1},
        {msg, <<"rpc.gateway.guild.test">>, <<"{}">>, #{reply_to => <<"reply">>}}
    },
    {noreply, Rpc} = gateway_nats_rpc:handle_info(Msg, rpc_state()),
    {noreply, Pool} = gateway_nats_pool:handle_info(Msg, pool_state()),
    ?assertEqual(0, maps:get(handler_count, Rpc)),
    ?assertEqual(0, maps:get(handler_count, Pool)).

membership_restart_fails_closed() ->
    Pid = start_membership(),
    discover(['peer@host']),
    ?assert(gateway_cluster_membership:rpc_ready()),
    Ref = monitor(process, Pid),
    exit(Pid, kill),
    receive
        {'DOWN', Ref, process, Pid, _} -> ok
    after 1000 -> ?assert(false)
    end,
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    start_membership(),
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    discover(['peer@host']),
    ?assert(gateway_cluster_membership:rpc_ready()).

failed_unsubscribe_closes_connection() ->
    start_membership(),
    meck:expect(nats, unsub, fun(_, _) -> {error, disconnected} end),
    {noreply, _} = gateway_nats_rpc:handle_info(
        cluster_rpc_readiness_changed,
        (rpc_state())#{sub => [{'$sid', 1}]}
    ),
    {noreply, _} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed,
        (pool_state())#{subs => #{0 => [{'$sid', 1}]}}
    ),
    ?assert(meck:num_calls(nats, disconnect, '_') >= 2).

monitored_owner_loss_and_restart() ->
    Pid = start_membership(),
    discover(['peer@host']),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(check_cluster_rpc, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(check_cluster_rpc, pool_state()),
    {Pid, RpcRef} = maps:get(rpc_membership_monitor, Rpc1),
    {Pid, PoolRef} = maps:get(rpc_membership_monitor, Pool1),
    exit(Pid, kill),
    RpcDown =
        receive
            {'DOWN', RpcRef, process, Pid, _} = R -> R
        after 1000 -> error(timeout)
        end,
    PoolDown =
        receive
            {'DOWN', PoolRef, process, Pid, _} = P -> P
        after 1000 -> error(timeout)
        end,
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(RpcDown, Rpc1),
    {noreply, Pool2} = gateway_nats_pool:handle_info(PoolDown, Pool1),
    ?assertEqual(undefined, maps:get(sub, Rpc2)),
    ?assertEqual(#{}, maps:get(subs, Pool2)),
    NewPid = start_membership(),
    {noreply, Rpc3} = gateway_nats_rpc:handle_info(check_cluster_rpc, Rpc2),
    {noreply, Pool3} = gateway_nats_pool:handle_info(check_cluster_rpc, Pool2),
    ?assertMatch({NewPid, _}, maps:get(rpc_membership_monitor, Rpc3)),
    ?assertMatch({NewPid, _}, maps:get(rpc_membership_monitor, Pool3)),
    ?assertEqual(undefined, maps:get(sub, Rpc3)),
    discover(['peer@host']),
    {noreply, Rpc4} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc3),
    {noreply, Pool4} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool3),
    ?assertNotEqual(undefined, maps:get(sub, Rpc4)),
    ?assertEqual(1, map_size(maps:get(subs, Pool4))),
    gateway_cluster_membership:stop_rpc_watch(Rpc4),
    gateway_cluster_membership:stop_rpc_watch(Pool4).

timeout_remains_fail_closed() ->
    start_membership(),
    whereis(gateway_cluster_membership) ! rpc_ready_timeout,
    State = sys:get_state(gateway_cluster_membership),
    ?assertNot(gateway_cluster_membership:rpc_ready()),
    ?assertEqual(undefined, maps:get(rpc_ready_timer, State)),
    ?assertNot(meck:called(nats, sub, '_')).

duplicate_readiness_is_idempotent() ->
    start_membership(),
    discover(['peer@host']),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    Count = meck:num_calls(nats, sub, '_'),
    ?assertEqual(
        {noreply, Rpc1}, gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc1)
    ),
    ?assertEqual(
        {noreply, Pool1}, gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool1)
    ),
    ?assertEqual(Count, meck:num_calls(nats, sub, '_')).

control_subscription_delivery_stays_active() ->
    start_membership(),
    register(gateway_rollout_config, self()),
    try
        Msg = {self(), {'$sid', 2}, {msg, <<"config.gateway.rollout">>, <<"{}">>, #{}}},
        ?assertEqual({noreply, rpc_state()}, gateway_nats_rpc:handle_info(Msg, rpc_state())),
        receive
            {nats_msg, <<"config.gateway.rollout">>, <<"{}">>, undefined} -> ok
        after 1000 -> ?assert(false)
        end
    after
        unregister(gateway_rollout_config)
    end.

failed_disconnect_kills_connection() ->
    start_membership(),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    Ref = monitor(process, Conn),
    meck:expect(nats, unsub, fun(_, _) -> {error, timeout} end),
    meck:expect(nats, disconnect, fun(_) -> {error, timeout} end),
    gateway_nats_pool_conn:unsubscribe_slot_sids(Conn, [{'$sid', 1}]),
    receive
        {'DOWN', Ref, process, Conn, killed} -> ok
    after 1000 -> ?assert(false)
    end.

failed_subscriptions_do_not_repeat_on_every_watch() ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, sub, fun(_, _, _) -> {error, not_ready} end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    Count = meck:num_calls(nats, sub, '_'),
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc1),
    {noreply, Pool2} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool1),
    ?assertEqual(Count, meck:num_calls(nats, sub, '_')),
    gateway_cluster_membership:stop_rpc_watch(Rpc2),
    gateway_cluster_membership:stop_rpc_watch(Pool2).

cluster_disabled_failed_unsubscribe_preserves_behavior() ->
    persistent_term:put({fluxer_gateway, runtime_config}, #{cluster_enabled => false}),
    meck:expect(nats, unsub, fun(_, _) -> {error, not_ready} end),
    ?assertEqual(ok, gateway_nats_pool_conn:unsubscribe_slot_sids(self(), [{'$sid', 1}])),
    ?assertNot(meck:called(nats, disconnect, '_')).

membership_then_nats_ready_is_idempotent() ->
    notification_order_is_idempotent(cluster_rpc_readiness_changed, {self(), ready}).

nats_ready_then_membership_is_idempotent() ->
    notification_order_is_idempotent({self(), ready}, cluster_rpc_readiness_changed).

notification_order_is_idempotent(First, Second) ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, sub, fun(_, _, _) -> {ok, {'$sid', erlang:unique_integer([positive])}} end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(First, (rpc_state())#{nats_ready => false}),
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(Second, Rpc1),
    {noreply, Pool1} = gateway_nats_pool:handle_info(First, (pool_state())#{ready_slots => #{}}),
    {noreply, Pool2} = gateway_nats_pool:handle_info(Second, Pool1),
    ?assertEqual(2, meck:num_calls(nats, sub, '_')),
    whereis(gateway_cluster_membership) ! {nodedown, 'peer@host'},
    _ = sys:get_state(gateway_cluster_membership),
    {noreply, Rpc3} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc2),
    {noreply, Pool3} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool2),
    ?assertEqual(2, meck:num_calls(nats, unsub, '_')),
    gateway_cluster_membership:stop_rpc_watch(Rpc3),
    gateway_cluster_membership:stop_rpc_watch(Pool3).

partial_subscription_retries_only_missing_subjects() ->
    set_config(#{gateway_role => guilds}),
    start_membership(),
    discover(['peer@host']),
    Missing = <<"rpc.gateway.voice.>">>,
    meck:expect(nats, sub, fun(_, Subject, _) ->
        case Subject of
            Missing -> {error, not_ready};
            _ -> {ok, {'$sid', erlang:unique_integer([positive])}}
        end
    end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    ?assertNot(maps:get(cluster_rpc_ready, Rpc1, false)),
    ?assertNot(maps:get(cluster_rpc_ready, Pool1, false)),
    meck:expect(nats, sub, fun(_, _, _) -> {ok, {'$sid', erlang:unique_integer([positive])}} end),
    Rpc2 = retry_rpc(gateway_nats_rpc, Rpc1),
    Pool2 = retry_rpc(gateway_nats_pool, Pool1),
    ?assertEqual(8, meck:num_calls(nats, sub, '_')),
    ?assert(maps:get(cluster_rpc_ready, Rpc2)),
    ?assert(maps:get(cluster_rpc_ready, Pool2)),
    ?assertEqual(3, length(maps:get(sub, Rpc2))),
    ?assertEqual(3, length(maps:get(0, maps:get(subs, Pool2)))),
    gateway_cluster_membership:stop_rpc_watch(Rpc2),
    gateway_cluster_membership:stop_rpc_watch(Pool2).

failed_subscription_recovers_without_watch_spin() ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, sub, fun(_, _, _) -> {error, not_ready} end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    ?assertNot(maps:get(cluster_rpc_ready, Rpc1, false)),
    ?assertNot(maps:get(cluster_rpc_ready, Pool1, false)),
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc1),
    {noreply, Pool2} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool1),
    ?assertEqual(2, meck:num_calls(nats, sub, '_')),
    meck:expect(nats, sub, fun(_, _, _) -> {ok, {'$sid', 2}} end),
    Rpc3 = retry_rpc(gateway_nats_rpc, Rpc2),
    Pool3 = retry_rpc(gateway_nats_pool, Pool2),
    ?assert(maps:get(cluster_rpc_ready, Rpc3)),
    ?assert(maps:get(cluster_rpc_ready, Pool3)),
    ?assertEqual(4, meck:num_calls(nats, sub, '_')),
    gateway_cluster_membership:stop_rpc_watch(Rpc3),
    gateway_cluster_membership:stop_rpc_watch(Pool3).

retry_rpc(Module, State) ->
    {Timer, Token} = maps:get(rpc_subscription_retry, State),
    _ = erlang:cancel_timer(Timer),
    {noreply, Retried} = Module:handle_info({retry_rpc_subscription, Token}, State),
    Retried.

health_requires_live_consumers() ->
    start_membership(),
    discover(['peer@host']),
    with_health_reply(fun() ->
        ?assertEqual(503, health_status()),
        set_config(#{gateway_role => sessions}),
        ?assertEqual(200, health_status()),
        set_config(#{gateway_role => websocket}),
        ?assertEqual(200, health_status()),
        set_config(#{cluster_enabled => false, gateway_role => all}),
        ?assertEqual(200, health_status())
    end).

recorded_sid_loss_clears_readiness() ->
    start_membership(),
    discover(['peer@host']),
    {noreply, Rpc} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    ?assertMatch(
        {reply, false, _},
        gateway_nats_rpc:handle_call(
            rpc_ready, {self(), make_ref()}, Rpc#{sub => undefined}
        )
    ),
    ?assertMatch(
        {reply, false, _},
        gateway_nats_pool:handle_call(
            rpc_ready, {self(), make_ref()}, Pool#{subs => #{}}
        )
    ),
    gateway_cluster_membership:stop_rpc_watch(Rpc),
    gateway_cluster_membership:stop_rpc_watch(Pool).

replacement_connection_reinstalls_subjects() ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, monitor, fun(Pid) -> monitor(process, Pid) end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        {noreply, Rpc2} = gateway_nats_rpc:handle_info(
            {nats_connect_result, self(), {ok, Conn}}, Rpc1#{connecting_pid => self()}
        ),
        {noreply, Pool2} = gateway_nats_pool:handle_info(
            {nats_pool_connect_result, 0, self(), {ok, Conn}},
            Pool1#{connecting => #{0 => #{pid => self()}}}
        ),
        ?assertMatch(
            {reply, false, _},
            gateway_nats_rpc:handle_call(
                rpc_ready, {self(), make_ref()}, Rpc2
            )
        ),
        ?assertMatch(
            {reply, false, _},
            gateway_nats_pool:handle_call(
                rpc_ready, {self(), make_ref()}, Pool2
            )
        ),
        {noreply, Rpc3} = gateway_nats_rpc:handle_info({Conn, ready}, Rpc2),
        {noreply, Pool3} = gateway_nats_pool:handle_info({Conn, ready}, Pool2),
        ?assertEqual(4, meck:num_calls(nats, sub, '_')),
        gateway_cluster_membership:stop_rpc_watch(Rpc3),
        gateway_cluster_membership:stop_rpc_watch(Pool3)
    after
        exit(Conn, kill)
    end.

retry_backoff_is_bounded_and_stale_tokens_are_ignored() ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, sub, fun(_, _, _) -> {error, not_ready} end),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, rpc_state()),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        cluster_rpc_readiness_changed, pool_state()
    ),
    lists:foreach(
        fun({Module, State}) ->
            {Timer, _Token} = maps:get(rpc_subscription_retry, State),
            ?assert(erlang:read_timer(Timer) =< 250),
            lists:foreach(
                fun(Event) ->
                    ?assertEqual({noreply, State}, Module:handle_info(Event, State))
                end,
                [
                    cluster_rpc_readiness_changed,
                    {self(), ready},
                    {retry_rpc_subscription, make_ref()}
                ]
            ),
            Last = lists:foldl(
                fun(_, Previous) -> retry_rpc(Module, Previous) end,
                State,
                lists:seq(1, 7)
            ),
            {LastTimer, LastToken} = maps:get(rpc_subscription_retry, Last),
            ?assert(erlang:read_timer(LastTimer) =< 5000),
            ?assert(erlang:read_timer(LastTimer) >= 4900),
            whereis(gateway_cluster_membership) ! {nodedown, 'peer@host'},
            _ = sys:get_state(gateway_cluster_membership),
            {noreply, Closed} = Module:handle_info(cluster_rpc_readiness_changed, Last),
            ?assertEqual(undefined, maps:get(rpc_subscription_retry, Closed)),
            ?assertEqual(false, erlang:read_timer(LastTimer)),
            ?assertEqual(
                {noreply, Closed},
                Module:handle_info({retry_rpc_subscription, LastToken}, Closed)
            ),
            gateway_cluster_membership:stop_rpc_watch(Closed),
            discover(['peer@host'])
        end,
        [{gateway_nats_rpc, Rpc1}, {gateway_nats_pool, Pool1}]
    ).

health_requires_complete_role_subscriptions() ->
    set_config(#{gateway_role => guilds, nats_core_url => undefined, nats_pool_size => 1}),
    start_membership(),
    discover(['peer@host']),
    {ok, RpcPid} = gateway_nats_rpc:start_link(),
    {ok, PoolPid} = gateway_nats_pool:start_link(),
    unlink(RpcPid),
    unlink(PoolPid),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        with_health_reply(fun() ->
            Partial = #{<<"rpc.gateway.guild.>">> => {'$sid', 1}},
            install_health_states(RpcPid, PoolPid, Conn, Partial),
            ?assertEqual(503, health_status()),
            Complete = maps:from_list([
                {S, {'$sid', N}}
             || {S, N} <-
                    lists:zip(gateway_nats_rpc:rpc_subjects_for_role(guilds), lists:seq(1, 3))
            ]),
            install_health_states(RpcPid, PoolPid, Conn, Complete),
            ?assertEqual(200, health_status()),
            sys:replace_state(RpcPid, fun(S) ->
                S#{
                    rpc_enabled => false,
                    sub => undefined,
                    rpc_subscriptions => #{}
                }
            end),
            ?assertEqual(200, health_status()),
            sys:replace_state(PoolPid, fun(S) -> S#{pool_size => 2} end),
            ?assertEqual(503, health_status()),
            sys:replace_state(PoolPid, fun(S) -> S#{pool_size => 1} end),
            Ref = monitor(process, Conn),
            exit(Conn, kill),
            receive
                {'DOWN', Ref, process, Conn, killed} -> ok
            end,
            ?assertEqual(503, health_status()),
            gen_server:stop(RpcPid),
            ?assertEqual(503, health_status())
        end)
    after
        case is_process_alive(RpcPid) of
            true -> gen_server:stop(RpcPid);
            false -> ok
        end,
        gen_server:stop(PoolPid),
        exit(Conn, kill)
    end.

install_health_states(RpcPid, PoolPid, Conn, Subs) ->
    sys:replace_state(RpcPid, fun(S) ->
        S#{
            conn => Conn,
            nats_ready => true,
            sub => maps:values(Subs),
            rpc_subscriptions => Subs,
            rpc_enabled => true,
            cluster_rpc_ready => true
        }
    end),
    sys:replace_state(PoolPid, fun(S) ->
        S#{
            slots => #{0 => Conn},
            ready_slots => #{0 => Conn},
            subs => #{0 => maps:values(Subs)},
            rpc_subscriptions => #{0 => Subs},
            cluster_rpc_ready => true
        }
    end).

health_rechecks_membership_after_consumers() ->
    start_membership(),
    discover(['peer@host']),
    meck:new(gateway_nats_rpc, [passthrough, no_link]),
    meck:new(gateway_nats_pool, [passthrough, no_link]),
    meck:expect(gateway_nats_rpc, rpc_ready, fun() -> true end),
    meck:expect(gateway_nats_pool, rpc_ready, fun() ->
        whereis(gateway_cluster_membership) ! {nodedown, 'peer@host'},
        _ = sys:get_state(gateway_cluster_membership),
        true
    end),
    try
        with_health_reply(fun() -> ?assertEqual(503, health_status()) end)
    after
        meck:unload(gateway_nats_rpc),
        meck:unload(gateway_nats_pool)
    end.

terminate_cancels_subscription_retries() ->
    start_membership(),
    discover(['peer@host']),
    meck:expect(nats, sub, fun(_, _, _) -> {error, not_ready} end),
    lists:foreach(
        fun({Module, State}) ->
            {noreply, Failed} = Module:handle_info(cluster_rpc_readiness_changed, State),
            {Timer, _Token} = maps:get(rpc_subscription_retry, Failed),
            ?assertEqual(ok, Module:terminate(normal, Failed)),
            ?assertEqual(false, erlang:read_timer(Timer))
        end,
        [{gateway_nats_rpc, rpc_state()}, {gateway_nats_pool, pool_state()}]
    ).

pending_transports_wait_for_ready_before_subscribe_and_retry() ->
    start_membership(),
    discover(['peer@host']),
    lists:foreach(
        fun({Module, State}) ->
            Before = meck:num_calls(nats, sub, '_'),
            {noreply, Pending} = Module:handle_info(cluster_rpc_readiness_changed, State),
            ?assertEqual(Before, meck:num_calls(nats, sub, '_')),
            ?assertEqual(undefined, maps:get(rpc_subscription_retry, Pending, undefined)),
            ?assertMatch(
                {reply, false, _}, Module:handle_call(rpc_ready, {self(), make_ref()}, Pending)
            ),
            meck:expect(nats, sub, fun(_, _, _) -> {error, temporary_failure} end),
            {noreply, Failed} = Module:handle_info({self(), ready}, Pending),
            ?assertEqual(Before + 1, meck:num_calls(nats, sub, '_')),
            meck:expect(nats, sub, fun(_, _, _) -> {ok, {'$sid', 1}} end),
            Ready = retry_rpc(Module, Failed),
            ?assert(maps:get(cluster_rpc_ready, Ready)),
            ?assertEqual(Before + 2, meck:num_calls(nats, sub, '_')),
            gateway_cluster_membership:stop_rpc_watch(Ready)
        end,
        [
            {gateway_nats_rpc, (rpc_state())#{nats_ready => false}},
            {gateway_nats_pool, (pool_state())#{ready_slots => #{}}}
        ]
    ).

pending_pool_slot_does_not_delay_healthy_subscription_or_unsubscribe() ->
    start_membership(),
    discover(['peer@host']),
    PendingConn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        State = (pool_state())#{pool_size => 2, slots => #{0 => self(), 1 => PendingConn}},
        {noreply, PartlyReady} = gateway_nats_pool:handle_info(
            cluster_rpc_readiness_changed, State
        ),
        ?assertEqual(1, meck:num_calls(nats, sub, '_')),
        ?assertNot(meck:called(nats, sub, [PendingConn, '_', '_'])),
        ?assertEqual(undefined, maps:get(rpc_subscription_retry, PartlyReady, undefined)),
        ?assertNot(maps:get(cluster_rpc_ready, PartlyReady)),
        whereis(gateway_cluster_membership) ! {nodedown, 'peer@host'},
        _ = sys:get_state(gateway_cluster_membership),
        {noreply, Closed} = gateway_nats_pool:handle_info(
            cluster_rpc_readiness_changed, PartlyReady
        ),
        ?assertEqual(1, meck:num_calls(nats, unsub, '_')),
        ?assertEqual(#{}, maps:get(subs, Closed)),
        discover(['peer@host']),
        {noreply, Ready} = gateway_nats_pool:handle_info({PendingConn, ready}, Closed),
        ?assertEqual(3, meck:num_calls(nats, sub, '_')),
        ?assert(maps:get(cluster_rpc_ready, Ready)),
        gateway_cluster_membership:stop_rpc_watch(Ready)
    after
        exit(PendingConn, kill)
    end.

early_transport_ready_is_forwarded_after_connection_result() ->
    set_config(#{nats_core_url => <<"nats://localhost:4222">>}),
    start_membership(),
    discover(['peer@host']),
    lists:foreach(
        fun(Module) ->
            Conn = spawn(fun() ->
                receive
                    stop -> ok
                end
            end),
            try
                meck:expect(nats, connect, fun(_, _) -> {ok, Conn} end),
                meck:expect(nats, controlling_process, fun(_, Parent) ->
                    Parent ! {Conn, ready},
                    ok
                end),
                meck:expect(nats, is_ready, fun(_) -> true end),
                meck:expect(nats, monitor, fun(Pid) -> monitor(process, Pid) end),
                Connecting =
                    case Module of
                        gateway_nats_rpc ->
                            gateway_nats_rpc_handler:do_connect(
                                (rpc_state())#{conn => undefined, nats_ready => false}
                            );
                        gateway_nats_pool ->
                            gateway_nats_pool_conn:connect_slot(
                                0,
                                (pool_state())#{slots => #{}, ready_slots => #{}}
                            )
                    end,
                Early =
                    receive
                        {Conn, ready} = EarlyReady -> EarlyReady
                    after 1000 -> error(timeout)
                    end,
                {noreply, Waiting} = Module:handle_info(Early, Connecting),
                Result =
                    receive
                        {nats_connect_result, _, {ok, Conn}} = RpcResult -> RpcResult;
                        {nats_pool_connect_result, 0, _, {ok, Conn}} = PoolResult -> PoolResult
                    after 1000 -> error(timeout)
                    end,
                {noreply, Accepted} = Module:handle_info(Result, Waiting),
                Forwarded =
                    receive
                        {Conn, ready} = ForwardedReady -> ForwardedReady
                    after 1000 -> false
                    end,
                ?assertNotEqual(false, Forwarded),
                Before = meck:num_calls(nats, sub, '_'),
                {noreply, Ready} = Module:handle_info(Forwarded, Accepted),
                {noreply, Ready} = Module:handle_info({Conn, ready}, Ready),
                ?assertEqual(Before + 1, meck:num_calls(nats, sub, '_')),
                ?assert(maps:get(cluster_rpc_ready, Ready)),
                gateway_cluster_membership:stop_rpc_watch(Ready)
            after
                exit(Conn, kill)
            end
        end,
        [gateway_nats_rpc, gateway_nats_pool]
    ).

disabled_consumer_retains_ready_transport_for_enable() ->
    start_membership(),
    discover(['peer@host']),
    lists:foreach(
        fun({Module, State}) ->
            Before = meck:num_calls(nats, sub, '_'),
            {noreply, Disabled} = Module:handle_info({self(), ready}, State#{
                rpc_enabled => false
            }),
            ?assertEqual(Before, meck:num_calls(nats, sub, '_')),
            {reply, ok, Enabled} = Module:handle_call(
                enable_rpc_subscription, {self(), make_ref()}, Disabled
            ),
            ?assertEqual(Before + 1, meck:num_calls(nats, sub, '_')),
            ?assertMatch(
                {reply, true, _}, Module:handle_call(rpc_ready, {self(), make_ref()}, Enabled)
            ),
            gateway_cluster_membership:stop_rpc_watch(Enabled)
        end,
        [
            {gateway_nats_rpc, (rpc_state())#{nats_ready => false}},
            {gateway_nats_pool, (pool_state())#{ready_slots => #{}}}
        ]
    ).

unready_transport_is_replaced_when_the_connect_deadline_expires() ->
    start_membership(),
    discover(['peer@host']),
    assert_unready_transport_is_replaced().

cluster_disabled_unready_transport_is_replaced_when_the_connect_deadline_expires() ->
    set_config(#{cluster_enabled => false}),
    assert_unready_transport_is_replaced().

assert_unready_transport_is_replaced() ->
    Stuck = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        expect_transport(Stuck, fun(Parent) ->
            Parent ! {Stuck, {error, econnrefused}},
            Parent ! {Stuck, closed}
        end),
        Connecting = connect_rpc(),
        Early1 = handle_next(gateway_nats_rpc, {Stuck, {error, econnrefused}}, Connecting),
        Early2 = handle_next(gateway_nats_rpc, {Stuck, closed}, Early1),
        Accepted = handle_next(gateway_nats_rpc, connect_result, Early2),
        ?assertEqual(Stuck, maps:get(conn, Accepted)),
        ?assertMatch(
            {reply, false, _},
            gateway_nats_rpc:handle_call(rpc_ready, {self(), make_ref()}, Accepted)
        ),
        Deadline = maps:get(connecting_timer, Accepted),
        ?assert(is_reference(Deadline)),
        ?assert(erlang:read_timer(Deadline) =< 10000),
        _ = erlang:cancel_timer(Deadline),
        {noreply, Retrying} = gateway_nats_rpc:handle_info(
            {connect_timeout, maps:get(connecting_token, Accepted)}, Accepted
        ),
        ?assertEqual(undefined, maps:get(conn, Retrying)),
        ?assertEqual(undefined, maps:get(connecting_token, Retrying)),
        ?assert(meck:called(nats, disconnect, [Stuck])),
        receive
            connect -> ok
        after 5000 -> ?assert(false)
        end
    after
        exit(Stuck, kill)
    end.

ready_transport_clears_the_connect_deadline() ->
    start_membership(),
    discover(['peer@host']),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        expect_transport(Conn, fun(_Parent) -> ok end),
        Accepted = handle_next(gateway_nats_rpc, connect_result, connect_rpc()),
        Token = maps:get(connecting_token, Accepted),
        Deadline = maps:get(connecting_timer, Accepted),
        {noreply, Ready} = gateway_nats_rpc:handle_info({Conn, ready}, Accepted),
        ?assertEqual(false, erlang:read_timer(Deadline)),
        ?assertEqual(undefined, maps:get(connecting_token, Ready)),
        ?assertMatch(
            {reply, true, _},
            gateway_nats_rpc:handle_call(rpc_ready, {self(), make_ref()}, Ready)
        ),
        ?assertEqual(
            {noreply, Ready}, gateway_nats_rpc:handle_info({connect_timeout, Token}, Ready)
        ),
        ?assertNot(meck:called(nats, disconnect, [Conn])),
        gateway_cluster_membership:stop_rpc_watch(Ready)
    after
        exit(Conn, kill)
    end.

cluster_disabled_ready_transport_clears_the_connect_deadline() ->
    set_config(#{cluster_enabled => false}),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        expect_transport(Conn, fun(_Parent) -> ok end),
        Accepted = handle_next(gateway_nats_rpc, connect_result, connect_rpc()),
        Token = maps:get(connecting_token, Accepted),
        Deadline = maps:get(connecting_timer, Accepted),
        ?assert(is_reference(Deadline)),
        {noreply, Ready} = gateway_nats_rpc:handle_info({Conn, ready}, Accepted),
        ?assertEqual(false, erlang:read_timer(Deadline)),
        ?assertEqual(undefined, maps:get(connecting_token, Ready)),
        ?assertNotEqual(undefined, maps:get(sub, Ready)),
        ?assertEqual(
            {noreply, Ready}, gateway_nats_rpc:handle_info({connect_timeout, Token}, Ready)
        ),
        ?assertNot(meck:called(nats, disconnect, [Conn]))
    after
        exit(Conn, kill)
    end.

nats_rpc_disabled_never_subscribes_with_cluster_enabled() ->
    set_config(#{nats_rpc_enabled => false, nats_core_url => undefined, nats_pool_size => 1}),
    start_membership(),
    discover(['peer@host']),
    ?assert(gateway_cluster_membership:rpc_ready()),
    {ok, Rpc0} = gateway_nats_rpc:init([]),
    {ok, Pool0} = gateway_nats_pool:init([]),
    ?assertNot(maps:get(rpc_enabled, Rpc0)),
    ?assertNot(maps:get(rpc_enabled, Pool0)),
    {noreply, Rpc1} = gateway_nats_rpc:handle_info({self(), ready}, Rpc0#{conn => self()}),
    {noreply, Pool1} = gateway_nats_pool:handle_info(
        {self(), ready}, Pool0#{slots => #{0 => self()}}
    ),
    {noreply, Rpc2} = gateway_nats_rpc:handle_info(cluster_rpc_readiness_changed, Rpc1),
    {noreply, Pool2} = gateway_nats_pool:handle_info(cluster_rpc_readiness_changed, Pool1),
    ?assertNot(meck:called(nats, sub, '_')),
    ?assertEqual(undefined, maps:get(sub, Rpc2)),
    ?assertEqual(#{}, maps:get(subs, Pool2)),
    gateway_cluster_membership:stop_rpc_watch(Rpc2),
    gateway_cluster_membership:stop_rpc_watch(Pool2),
    flush_connect_requests().

pool_slot_that_fails_before_its_connect_result_is_replaced() ->
    start_membership(),
    discover(['peer@host']),
    Stuck = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        expect_transport(Stuck, fun(Parent) -> Parent ! {Stuck, closed} end),
        meck:expect(nats, disconnect, fun(Conn) ->
            exit(Conn, kill),
            ok
        end),
        Connecting = gateway_nats_pool_conn:connect_slot(
            0, (pool_state())#{slots => #{}, ready_slots => #{}}
        ),
        Early = handle_next(gateway_nats_pool, {Stuck, closed}, Connecting),
        Accepted =
            receive
                {nats_pool_connect_result, 0, _, {ok, Stuck}} = Result ->
                    {noreply, Next} = gateway_nats_pool:handle_info(Result, Early),
                    Next
            after 1000 -> error(timeout)
            end,
        Down =
            receive
                {'DOWN', _, process, Stuck, _} = DownMsg -> DownMsg
            after 1000 -> error(timeout)
            end,
        {noreply, Replaced} = gateway_nats_pool:handle_info(Down, Accepted),
        ?assertEqual(undefined, maps:get(0, maps:get(slots, Replaced))),
        receive
            {reconnect_slot, 0} -> ok
        after 5000 -> ?assert(false)
        end
    after
        exit(Stuck, kill)
    end.

unready_transport_subscription_returns_and_the_deadline_still_fires() ->
    assert_unready_subscription_does_not_block().

cluster_disabled_unready_transport_subscription_returns_and_the_deadline_still_fires() ->
    set_config(#{cluster_enabled => false}),
    assert_unready_subscription_does_not_block().

%% enats postpones every call on a connection that is not ready, so a subscription on one that
%% never gets ready would hold the RPC process and its connect deadline forever.
assert_unready_subscription_does_not_block() ->
    Stuck = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    expect_transport(Stuck, fun(_Parent) -> ok end),
    meck:expect(nats, sub, fun(_, _, _) ->
        receive
            never -> {error, not_ready}
        end
    end),
    {ok, Rpc} = gen_server:start({local, gateway_nats_rpc}, gateway_nats_rpc, [], []),
    try
        Accepted = wait_for_transport(Rpc, Stuck, 50),
        ?assertEqual(
            {error, not_ready},
            catch gen_server:call(
                gateway_nats_rpc, {subscribe_subject, <<"config.gateway.rollout">>, <<>>}, 1000
            )
        ),
        Rpc ! {connect_timeout, maps:get(connecting_token, Accepted)},
        ?assertEqual(undefined, maps:get(conn, sys:get_state(Rpc, 1000))),
        ?assert(meck:called(nats, disconnect, [Stuck])),
        ?assertNot(meck:called(nats, sub, '_'))
    after
        Ref = monitor(process, Rpc),
        exit(Rpc, kill),
        exit(Stuck, kill),
        receive
            {'DOWN', Ref, process, Rpc, _} -> ok
        end
    end.

cluster_disabled_enable_waits_for_a_ready_transport() ->
    set_config(#{cluster_enabled => false}),
    Conn = spawn(fun() ->
        receive
            stop -> ok
        end
    end),
    try
        expect_transport(Conn, fun(_Parent) -> ok end),
        Accepted = handle_next(gateway_nats_rpc, connect_result, connect_rpc()),
        {reply, ok, Enabled} = gateway_nats_rpc:handle_call(
            enable_rpc_subscription, {self(), make_ref()}, Accepted#{rpc_enabled => false}
        ),
        ?assertNot(meck:called(nats, sub, '_')),
        {noreply, Ready} = gateway_nats_rpc:handle_info({Conn, ready}, Enabled),
        ?assert(meck:called(nats, sub, '_')),
        ?assertNotEqual(undefined, maps:get(sub, Ready))
    after
        exit(Conn, kill)
    end.

wait_for_transport(_Rpc, Conn, 0) ->
    error({transport_not_accepted, Conn});
wait_for_transport(Rpc, Conn, Attempts) ->
    case sys:get_state(Rpc, 1000) of
        #{conn := Conn} = State ->
            State;
        _ ->
            timer:sleep(20),
            wait_for_transport(Rpc, Conn, Attempts - 1)
    end.

expect_transport(Conn, BeforeResult) ->
    set_config(#{nats_core_url => <<"nats://localhost:4222">>}),
    meck:expect(nats, connect, fun(_, _) -> {ok, Conn} end),
    meck:expect(nats, controlling_process, fun(_, Parent) ->
        BeforeResult(Parent),
        ok
    end),
    meck:expect(nats, is_ready, fun(_) -> false end),
    meck:expect(nats, monitor, fun(Pid) -> monitor(process, Pid) end).

connect_rpc() ->
    gateway_nats_rpc_handler:do_connect(
        (rpc_state())#{conn => undefined, nats_ready => false}
    ).

handle_next(Module, connect_result, State) ->
    receive
        {nats_connect_result, _, {ok, _}} = Result ->
            {noreply, Next} = Module:handle_info(Result, State),
            Next
    after 1000 -> error(timeout)
    end;
handle_next(Module, Expected, State) ->
    receive
        Expected ->
            {noreply, Next} = Module:handle_info(Expected, State),
            Next
    after 1000 -> error(timeout)
    end.

flush_connect_requests() ->
    receive
        connect -> flush_connect_requests();
        connect_all -> flush_connect_requests()
    after 0 -> ok
    end.

with_health_reply(Fun) ->
    meck:new(cowboy_req, [passthrough, no_link]),
    meck:expect(cowboy_req, reply, fun(Status, _, _, Req) -> Req#{test_status => Status} end),
    try
        Fun()
    after
        meck:unload(cowboy_req)
    end.

health_status() ->
    {ok, Req, readiness} = health_handler:init(#{peer => {{127, 0, 0, 1}, 1}}, readiness),
    maps:get(test_status, Req).

set_config(Values) ->
    Key = {fluxer_gateway, runtime_config},
    persistent_term:put(Key, maps:merge(persistent_term:get(Key), Values)).

start_membership() ->
    {ok, Pid} = gateway_cluster_membership:start_link(#{
        auto_subscribe => false,
        connect_fun => fun(_) -> true end,
        connected_nodes_fun => fun() -> [] end,
        role_fun => fun(_) -> all end
    }),
    unlink(Pid),
    Pid.

discover(Peers) ->
    whereis(gateway_cluster_membership) ! {cluster_peers_changed, Peers},
    _ = sys:get_state(gateway_cluster_membership),
    ok.

rpc_state() ->
    #{
        conn => self(),
        nats_ready => true,
        sub => undefined,
        rpc_enabled => true,
        extra_subscriptions => #{},
        handler_count => 0,
        handler_refs => #{},
        max_handlers => 10
    }.

pool_state() ->
    #{
        slots => #{0 => self()},
        ready_slots => #{0 => self()},
        subs => #{},
        rpc_enabled => true,
        pool_size => 1,
        monitors => #{},
        connecting => #{},
        handler_count => 0,
        handler_refs => #{},
        max_handlers => 10
    }.

flush_notifications() ->
    receive
        cluster_rpc_readiness_changed -> flush_notifications()
    after 0 -> ok
    end.
