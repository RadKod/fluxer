%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_recovery_tests).
-include_lib("eunit/include/eunit.hrl").

channel_events_do_not_resolve_game_grants_test() ->
    with_rollout(fun channel_events_do_not_resolve_game_grants/0).

channel_events_do_not_resolve_game_grants() ->
    Friends = maps:from_list([{Id, 1} || Id <- lists:seq(1, 100)]),
    State = #{
        user_id => 101,
        presence_pid => self(),
        relationships => Friends,
        channels => #{},
        game_activity_grants => Friends,
        game_activity_subscription_pid => self()
    },
    erlang:trace_pattern({session_game_activity, sync_friends, 1}, true, [local, call_count]),
    lists:foreach(
        fun(Event) ->
            Next = session_dispatch_presence:maybe_sync_presence_targets(Event, [], State),
            ?assertEqual(#{}, maps:get(game_activity_subscription_targets, Next, #{}))
        end,
        [
            channel_create,
            channel_update,
            channel_delete,
            channel_recipient_add,
            channel_recipient_remove,
            guild_delete
        ]
    ),
    ?assertEqual(
        {call_count, 0},
        erlang:trace_info({session_game_activity, sync_friends, 1}, call_count)
    ),
    erlang:trace_pattern({session_game_activity, sync_friends, 1}, false, [
        local, call_count
    ]),
    Refreshed = session_game_activity:refresh(1, State),
    ?assertEqual(#{1 => true}, maps:get(game_activity_subscription_targets, Refreshed)).

invisible_then_online_accepts_fresh_input_test() ->
    with_rollout(fun() ->
        Started = presence_game_activity:update(input(), owner()),
        Hidden = presence_game_activity:update(
            #{session_id => <<"s">>},
            Started#{sessions => #{<<"s">> => #{status => invisible}}}
        ),
        ?assertEqual(#{}, maps:get(candidates, maps:get(game_activity_state, Hidden))),
        Online = Hidden#{sessions => #{<<"s">> => #{status => online}}},
        ?assertEqual(#{}, maps:get(candidates, maps:get(game_activity_state, Online))),
        Fresh = presence_game_activity:update(input(), Online),
        ?assertEqual(1, map_size(maps:get(candidates, maps:get(game_activity_state, Fresh))))
    end).

rollout_reenable_accepts_only_fresh_input_test() ->
    with_rollout(fun() ->
        Started = presence_game_activity:update(input(), owner()),
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> false end),
        Closed = presence_game_activity:rollout(Started),
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
        meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 1 end),
        Reopened = presence_game_activity:rollout(Closed),
        ?assertEqual(#{}, maps:get(candidates, maps:get(game_activity_state, Reopened))),
        Fresh = presence_game_activity:update(input(), Reopened),
        ?assertEqual(1, map_size(maps:get(candidates, maps:get(game_activity_state, Fresh))))
    end).

visible_return_regrants_and_delivers_to_existing_receiver_test() ->
    with_rollout(fun visible_return_regrants_and_delivers_to_existing_receiver/0).

visible_return_regrants_and_delivers_to_existing_receiver() ->
    Parent = self(),
    Owner = spawn(fun() -> activity_owner_loop(owner()) end),
    meck:new(presence_manager, [non_strict, no_link]),
    meck:new(rpc_client, [non_strict, no_link]),
    meck:expect(presence_manager, lookup, fun(1) -> {ok, Owner} end),
    meck:expect(rpc_client, call, fun(Request) ->
        {ok, #{
            <<"request_nonce">> => maps:get(<<"request_nonce">>, Request),
            <<"grants">> => [
                #{
                    <<"owner_id">> => <<"1">>,
                    <<"policy_revision">> => <<"0">>,
                    <<"allowed">> => true,
                    <<"friend">> => true,
                    <<"blocked">> => false,
                    <<"eligible_16_plus">> => true,
                    <<"profile_view">> => <<"full">>
                }
            ]
        }}
    end),
    Receiver = spawn(fun() ->
        activity_receiver_loop(
            session_game_activity:subscribe(#{
                id => <<"viewer">>,
                user_id => 2,
                bot => false,
                socket_pid => Parent,
                presence_pid => undefined,
                relationships => #{1 => 1},
                channels => #{},
                seq => 0,
                ack_seq => 0,
                buffer => [],
                buffer_bytes => 0,
                suppress_presence_updates => false,
                pending_presences => []
            })
        )
    end),
    try
        ok = gen_server:call(Owner, {input, online, input()}),
        await_activity(playing),
        ok = gen_server:call(Owner, {input, invisible, #{session_id => <<"s">>}}),
        await_activity(null),
        ok = gen_server:call(Owner, {input, online, input()}),
        await_activity(playing),
        ?assert(meck:num_calls(rpc_client, call, '_') >= 2)
    after
        Owner ! stop,
        Receiver ! stop,
        meck:unload([presence_manager, rpc_client])
    end.

await_activity(Expected) ->
    receive
        {dispatch, presence_update, #{<<"game_activity">> := Activity}, _} when
            Expected =:= playing, is_map(Activity)
        ->
            ok;
        {dispatch, presence_update, #{<<"game_activity">> := null}, _} when
            Expected =:= null
        ->
            ok;
        {dispatch, _, _, _} ->
            await_activity(Expected)
    after 1500 -> error({missing_activity, Expected})
    end.

activity_owner_loop(State) ->
    receive
        {'$gen_call', From, {input, Status, Input}} ->
            Next = presence_game_activity:update(Input, State#{
                sessions => #{<<"s">> => #{status => Status}}
            }),
            gen_server:reply(From, ok),
            activity_owner_loop(Next);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = presence:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            activity_owner_loop(Next);
        {game_activity_delivery, Revision, Iterator} ->
            activity_owner_loop(
                presence_game_activity:delivery_batch(Revision, Iterator, State)
            );
        stop ->
            ok;
        _ ->
            activity_owner_loop(State)
    after 5000 -> error(activity_owner_timeout)
    end.

activity_receiver_loop(State) ->
    receive
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = session:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            activity_receiver_loop(Next);
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            activity_receiver_loop(Next);
        stop ->
            ok;
        Info ->
            {noreply, Next} = session:handle_info(Info, State),
            activity_receiver_loop(Next)
    after 5000 -> error(activity_receiver_timeout)
    end.

singleton_relay_does_not_scan_worker_buckets_test() ->
    with_rollout(fun singleton_relay_does_not_scan_worker_buckets/0).

singleton_relay_does_not_scan_worker_buckets() ->
    meck:expect(gateway_rollout_config, gateway_dispatch_relay_max_queue, fun() -> 10000 end),
    Key = {gateway_dispatch_relay, state},
    erlang:trace_pattern(
        {gateway_dispatch_relay_batch, build_shard_buckets, 2},
        true,
        [local, call_count]
    ),
    try
        lists:foreach(
            fun(Count) ->
                persistent_term:put(Key, #{workers => erlang:make_tuple(Count, self())}),
                ?assertEqual(
                    ok, gateway_dispatch_relay_batch:relay_game_activity_many([self()], #{})
                ),
                receive
                    {'$gen_cast', {deliver_many, [_], presence_update, #{}}} -> ok
                after 1000 -> error(missing_delivery)
                end
            end,
            [1, 16, 4096]
        ),
        ?assertEqual(
            {call_count, 0},
            erlang:trace_info(
                {gateway_dispatch_relay_batch, build_shard_buckets, 2}, call_count
            )
        )
    after
        persistent_term:erase(Key),
        erlang:trace_pattern(
            {gateway_dispatch_relay_batch, build_shard_buckets, 2},
            false,
            [local, call_count]
        )
    end.

completed_inactive_pairs_are_reclaimed_without_context_revival_test() ->
    State = owner(),
    Initial = maps:get(game_activity_state, State),
    Context = presence_game_activity_policy:context(2, Initial),
    Final = lists:foldl(
        fun(Viewer, Game) ->
            Id = integer_to_binary(Viewer),
            Request = #{viewer_id => Viewer, phase => <<"fence">>, request_id => Id},
            {ok, Fenced} = presence_game_activity_policy:pair_control(Request, Game),
            Ack = presence_game_activity_policy:ack(pair, Request, Fenced),
            {ok, Applied} = presence_game_activity_policy:pair_control(
                Request#{
                    phase => <<"apply">>,
                    owner_epoch => maps:get(owner_epoch, Fenced),
                    pair_generation => maps:get(<<"pair_generation">>, Ack)
                },
                Fenced
            ),
            ?assertEqual(0, map_size(maps:get(pairs, Applied))),
            Applied
        end,
        Initial,
        lists:seq(2, 10001)
    ),
    Grant = #{
        owner_id => <<"1">>,
        policy_revision => <<"0">>,
        request_nonce => maps:get(request_nonce, Context),
        allowed => true,
        friend => true,
        blocked => false,
        eligible_16_plus => true,
        profile_view => <<"full">>
    },
    ?assertNot(presence_game_activity_policy:grant_allowed(2, Context, Grant, Final, State)),
    ?assertNot(presence_game_activity_policy:interest_allowed(2, Context, Grant, Final, State)).

newer_policy_reconciles_only_pinned_recoverable_fences_test() ->
    Base = maps:get(game_activity_state, owner()),
    Fence = #{phase => <<"fence">>, owner_epoch => null, policy_revision => <<"0">>},
    {ok, Abandoned} = presence_game_activity_policy:control(
        Fence#{request_id => <<"abandoned">>, recoverable => true}, Base
    ),
    {ok, Protected} = presence_game_activity_policy:control(
        Fence#{request_id => <<"account">>}, Abandoned
    ),
    {ok, Retried} = presence_game_activity_policy:control(
        Fence#{request_id => <<"retry">>, recoverable => true}, Protected
    ),
    Apply = #{
        phase => <<"apply">>,
        owner_epoch => maps:get(owner_epoch, Retried),
        request_id => <<"retry">>,
        policy_revision => <<"1">>,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    },
    {ok, Reconciled} = presence_game_activity_policy:control(Apply, Retried),
    ?assertEqual(#{<<"account">> => <<"0">>}, maps:get(policy_requests, Reconciled)),
    ?assertNot(presence_game_activity_policy:permitted(Reconciled)),
    {ok, Open} = presence_game_activity_policy:control(
        Apply#{request_id => <<"account">>}, Reconciled
    ),
    ?assert(presence_game_activity_policy:permitted(Open)).

receiver_cleanup_invalidates_old_context_and_keeps_other_pairs_test() ->
    Initial = maps:get(game_activity_state, owner()),
    First = presence_game_activity_policy:track_receiver(2, self(), Initial),
    Other = presence_game_activity_policy:track_receiver(3, self(), First),
    Old = presence_game_activity_policy:context(2, Other),
    OtherContext = presence_game_activity_policy:context(3, Other),
    Clean = presence_game_activity_policy:untrack_receiver(2, self(), Other),
    ?assertNotEqual(Old, presence_game_activity_policy:context(2, Clean)),
    ?assertEqual(OtherContext, presence_game_activity_policy:context(3, Clean)),
    ?assertEqual(1, map_size(maps:get(pairs, Clean))).

recoverable_fences_coalesce_and_retry_after_many_abandoned_writes_test() ->
    Base = maps:get(game_activity_state, owner()),
    Fence = #{
        phase => <<"fence">>,
        owner_epoch => null,
        policy_revision => <<"0">>,
        recoverable => true
    },
    Final = lists:foldl(
        fun(N, Game) ->
            {ok, Next} = presence_manager_game_activity:pending_control(
                policy,
                Fence#{request_id => integer_to_binary(N)},
                Game
            ),
            Next
        end,
        Base,
        lists:seq(1, 1000)
    ),
    ?assertEqual(1, map_size(maps:get(policy_requests, Final))),
    Rejected = presence_manager_game_activity:remove_rejected_request(
        policy,
        Fence#{request_id => <<"1000">>},
        #{},
        Final
    ),
    ?assert(maps:get(fenced, Rejected)),
    Apply = #{
        phase => <<"apply">>,
        owner_epoch => maps:get(owner_epoch, Base),
        request_id => <<"1000">>,
        policy_revision => <<"0">>,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    },
    ?assertEqual({error, stale}, presence_game_activity_policy:control(Apply, Rejected)),
    {ok, Open} = presence_game_activity_policy:control(
        Apply#{policy_revision => <<"1">>}, Rejected
    ),
    ?assert(presence_game_activity_policy:permitted(Open)),
    ?assertEqual(#{}, maps:get(policy_requests, Open)).

manager_coalesces_rejection_tokens_and_preserves_inherited_guard_test() ->
    From = {self(), make_ref()},
    Fence = #{
        phase => <<"fence">>,
        owner_epoch => null,
        policy_revision => <<"0">>,
        recoverable => true,
        request_id => <<"first">>
    },
    State = #{presences => #{1 => {self(), make_ref()}}},
    Final = lists:foldl(
        fun(N, Current) ->
            Request = Fence#{request_id => integer_to_binary(N)},
            {reply, {owner, _, _}, Next} = presence_manager_shard:handle_call(
                {game_activity_prepare, 1, policy, Request}, From, Current
            ),
            Game = maps:get(1, maps:get(game_activity_pending, Next)),
            Ack = presence_game_activity_policy:ack(policy, Request, Game),
            {reply, ok, Recorded} = presence_manager_shard:handle_call(
                {game_activity_finish, 1, policy, Request, self(), Ack}, From, Next
            ),
            Recorded
        end,
        State,
        lists:seq(1, 1000)
    ),
    Game = maps:get(1, maps:get(game_activity_pending, Final)),
    ?assertEqual(1, map_size(maps:get(policy_requests, Game))),
    ?assertEqual(1, map_size(maps:get(inherited_policy_requests, Game))),
    ?assertEqual(#{}, maps:get(rejection_tokens, Game)),
    Newer = Fence#{policy_revision => <<"1">>, request_id => <<"newer">>},
    {reply, {owner, _, Token}, Prepared} = presence_manager_shard:handle_call(
        {game_activity_prepare, 1, policy, Newer}, From, Final
    ),
    {reply, ok, Rejected} = presence_manager_shard:handle_call(
        {game_activity_reject, 1, policy, Newer, self(), Token}, From, Prepared
    ),
    Pending = maps:get(1, maps:get(game_activity_pending, Rejected)),
    ?assert(maps:is_key({recoverable, <<"1">>}, maps:get(policy_requests, Pending))),
    ?assert(maps:get(fenced, Pending)),
    Replacement = Pending#{owner_epoch => <<"replacement">>},
    Apply = #{
        phase => <<"apply">>,
        owner_epoch => maps:get(owner_epoch, Game),
        policy_revision => <<"1">>,
        request_id => <<"1000">>
    },
    ?assertEqual({error, stale}, presence_game_activity_policy:control(Apply, Replacement)),
    {ok, Reconciled} = presence_game_activity_policy:control(
        Apply#{policy_revision => <<"2">>}, Replacement
    ),
    ?assertEqual(#{}, maps:get(policy_requests, Reconciled)).

pending_requests_and_pair_keys_are_bounded_test() ->
    Base = maps:get(game_activity_state, owner()),
    Final = lists:foldl(
        fun(N, Game) ->
            Request = #{
                phase => <<"fence">>,
                owner_epoch => null,
                policy_revision => <<"0">>,
                request_id => integer_to_binary(N)
            },
            case presence_game_activity_policy:control(Request, Game) of
                {ok, Next} -> Next;
                {error, busy} -> Game
            end
        end,
        Base,
        lists:seq(1, 1000)
    ),
    ?assert(map_size(maps:get(policy_requests, Final)) =< 64),
    Pairs = lists:foldl(
        fun(N, Game) ->
            Request = #{
                phase => <<"fence">>, viewer_id => N, request_id => integer_to_binary(N)
            },
            case presence_game_activity_policy:pair_control(Request, Game) of
                {ok, Next} -> Next;
                {error, busy} -> Game
            end
        end,
        Base,
        lists:seq(1, 2000)
    ),
    ?assert(map_size(maps:get(pairs, Pairs)) =< 64).

manager_pending_users_have_a_hard_bound_test() ->
    Game = maps:get(game_activity_state, owner()),
    Pending = maps:from_keys(lists:seq(1, 10000), Game),
    State = #{presences => #{10001 => {self(), make_ref()}}, game_activity_pending => Pending},
    Request = #{
        phase => <<"fence">>,
        owner_epoch => null,
        policy_revision => <<"0">>,
        request_id => <<"overflow">>
    },
    ?assertMatch(
        {reply, {error, busy}, State},
        presence_manager_shard:handle_call(
            {game_activity_prepare, 10001, policy, Request}, {self(), make_ref()}, State
        )
    ).

manager_total_pending_entries_bound_preserves_existing_recovery_test() ->
    Fence = #{
        phase => <<"fence">>,
        owner_epoch => null,
        policy_revision => <<"0">>,
        request_id => <<"first">>,
        recoverable => true
    },
    {ok, Game} = presence_game_activity_policy:control(
        Fence, maps:get(game_activity_state, owner())
    ),
    State = #{
        presences => #{1 => {self(), make_ref()}},
        game_activity_pending => #{1 => Game},
        game_activity_pending_count => 10000
    },
    From = {self(), make_ref()},
    New = Fence#{request_id => <<"protected">>, recoverable => false},
    ?assertMatch(
        {reply, {error, busy}, State},
        presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, New}, From, State
        )
    ),
    ?assertMatch(
        {reply, {owner, _, _}, _},
        presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, Fence#{request_id => <<"retry">>}}, From, State
        )
    ).

owner() ->
    Game = (presence_game_activity_policy:new())#{
        policy => #{
            visibility => <<"friends">>,
            eligible_16_plus => true,
            effective_profile_audience => <<"friends">>
        },
        rollout_epoch => 0,
        rollout_generation => 0,
        tokens => 2
    },
    #{
        game_activity_state => Game,
        user_id => 1,
        friends => #{2 => true},
        sessions => #{<<"s">> => #{status => online}}
    }.

input() ->
    #{
        session_id => <<"s">>,
        game_activity => #{
            <<"game_id">> => <<"game">>,
            <<"started_at">> => erlang:system_time(millisecond)
        }
    }.

with_rollout(Fun) ->
    meck:new(gateway_rollout_config, [non_strict, no_link]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 0} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 0 end),
    try
        Fun()
    after
        meck:unload(gateway_rollout_config)
    end.
