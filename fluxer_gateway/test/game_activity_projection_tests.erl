%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_projection_tests).
-include_lib("eunit/include/eunit.hrl").

unknown_new_owner_denies_test() ->
    {reply, Reply, _} = presence:handle_call(
        {game_activity_subscribe, 2, self(), #{}, #{}}, {self(), make_ref()}, #{}
    ),
    ?assertEqual({error, denied}, Reply).

fixture() ->
    G = (presence_game_activity_policy:new())#{
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
        game_activity_state => G,
        user_id => 1,
        is_bot => false,
        friends => #{2 => true},
        sessions => #{<<"a">> => #{status => online, afk => false, mobile => false}},
        custom_status => null
    }.

grant(G) ->
    #{
        owner_id => <<"1">>,
        policy_revision => <<"0">>,
        request_nonce => maps:get(request_nonce, G),
        allowed => true,
        friend => true,
        blocked => false,
        eligible_16_plus => true,
        profile_view => <<"full">>
    }.

ready_friend_only_test() ->
    S = fixture(),
    G = maps:get(game_activity_state, S),
    C = presence_game_activity_policy:context(2, G),
    ?assert(presence_game_activity_policy:grant_allowed(2, C, grant(G), G, S)),
    ?assertNot(presence_game_activity_policy:grant_allowed(3, C, grant(G), G, S)),
    ?assertNot(
        presence_game_activity_policy:grant_allowed(1, C, grant(G), G, S#{
            friends => #{1 => true}
        })
    ).

dm_gdm_nonfriend_denied_test() ->
    with_rollout(fun() ->
        S = fixture(),
        G = maps:get(game_activity_state, S),
        C = presence_game_activity_policy:context(2, G),
        Denied = S#{
            friends => #{},
            group_dm_recipients => #{1 => #{2 => true}},
            subscriptions => #{2 => true}
        },
        ?assertMatch(
            {{error, denied}, _},
            presence_game_activity:subscribe(2, self(), C, grant(G), Denied)
        ),
        ?assertEqual(
            0, meck:num_calls(gateway_dispatch_relay, dispatch_game_activity_many, '_')
        )
    end).

cached_subscribe_denied_test() ->
    with_rollout(fun() ->
        S = fixture(),
        G = maps:get(game_activity_state, S),
        C = presence_game_activity_policy:context(2, G),
        lists:foreach(
            fun({K, V}) ->
                ?assertMatch(
                    {{error, denied}, _},
                    presence_game_activity:subscribe(2, self(), C, (grant(G))#{K => V}, S)
                )
            end,
            [
                {friend, false},
                {allowed, false},
                {blocked, true},
                {profile_view, <<"limited">>},
                {profile_view, <<"public">>},
                {eligible_16_plus, false},
                {request_nonce, <<"stale">>}
            ]
        ),
        ?assertEqual(
            0, meck:num_calls(gateway_dispatch_relay, dispatch_game_activity_many, '_')
        )
    end).

game_only_never_publishes_bus_or_cache_test() ->
    with_rollout(fun() ->
        meck:new(presence_broadcast, [non_strict]),
        meck:expect(presence_broadcast, publish_global_presence, fun(_, _) ->
            error(unexpected_common_publish)
        end),
        try
            State = fixture(),
            {noreply, New} = presence:handle_cast(
                {presence_update, #{
                    session_id => <<"a">>,
                    status => online,
                    game_activity => #{
                        <<"game_id">> => <<"test-game">>,
                        <<"started_at">> => erlang:system_time(millisecond)
                    }
                }},
                State
            ),
            ?assertEqual(1, maps:get(activity_revision, maps:get(game_activity_state, New))),
            ?assertEqual(0, meck:num_calls(presence_broadcast, publish_global_presence, '_')),
            ?assertEqual(0, meck:num_calls(gateway_dispatch_relay, dispatch_many, '_'))
        after
            meck:unload(presence_broadcast),
            flush()
        end
    end).

lease_never_sessions_replace_test() ->
    with_rollout(fun() ->
        Req = #{
            session_id => <<"a">>,
            status => online,
            game_activity => #{
                <<"game_id">> => <<"test-game">>,
                <<"started_at">> => erlang:system_time(millisecond)
            }
        },
        {noreply, S1} = presence:handle_cast({presence_update, Req}, fixture()),
        flush(),
        {noreply, S2} = presence:handle_cast({presence_update, Req}, S1),
        ?assertEqual(
            maps:get(activity_revision, maps:get(game_activity_state, S1)),
            maps:get(activity_revision, maps:get(game_activity_state, S2))
        ),
        ?assertEqual(0, meck:num_calls(gateway_dispatch_relay, dispatch_many, '_')),
        receive
            {game_activity_delivery, _, _} -> ?assert(false)
        after 0 -> ok
        end
    end).

negative_network_payload_matrix_test() ->
    with_rollout(fun() ->
        S = fixture(),
        G = maps:get(game_activity_state, S),
        Stamp = (presence_game_activity_policy:context(2, G))#{allowed => true},
        Entry = #{viewer_id => 2, stamp => Stamp},
        {Started, _} = presence_game_activity:transition(
            <<"a">>,
            #{<<"game_id">> => <<"test-game">>, <<"started_at">> => 1000},
            erlang:monotonic_time(millisecond),
            1000,
            G
        ),
        Active = S#{game_activity_state => Started#{grants => #{self() => Entry}}},
        _ = presence_game_activity:deliver([{self(), Entry}], Active),
        receive
            {wire, Payload} ->
                ?assertMatch(#{<<"game_activity">> := #{<<"game_id">> := _}}, Payload)
        after 100 -> ?assert(false)
        end,
        _ = presence_game_activity:deliver([{self(), Entry}], Active#{friends => #{}}),
        receive
            {wire, _} -> ?assert(false)
        after 0 -> ok
        end
    end).

owner_only_restart_inherits_fence_dual_loss_requires_fresh_grant_test() ->
    with_rollout(fun assert_owner_restart_fence/0).

assert_owner_restart_fence() ->
    meck:new(presence_broadcast, [passthrough]),
    meck:expect(presence_broadcast, ensure_initial_global_subscriptions, fun(S) -> S end),
    try
        Original = presence_game_activity_policy:new(),
        {ok, Pending} = presence_game_activity_policy:control(
            #{
                phase => <<"fence">>,
                owner_epoch => null,
                request_id => <<"close">>,
                policy_revision => <<"4">>
            },
            Original
        ),
        Data = #{user_id => 1, user_data => #{}, status => online, friend_ids => [2]},
        {ok, Restarted} = presence:init(Data#{game_activity_pending => Pending}),
        Policy = #{
            policy_revision => <<"4">>,
            visibility => <<"friends">>,
            eligible_16_plus => true,
            effective_profile_audience => <<"friends">>
        },
        StillClosed = presence_game_activity:bootstrap(
            {session, <<"old-response">>}, Policy, Restarted
        ),
        ?assertNot(
            presence_game_activity_policy:permitted(
                maps:get(game_activity_state, StillClosed)
            )
        ),
        {ok, LostBoth} = presence:init(Data),
        Open = presence_game_activity:bootstrap(
            {session, <<"old-response">>}, Policy, LostBoth
        ),
        Game = maps:get(game_activity_state, Open),
        Context = presence_game_activity_policy:context(2, Game),
        ?assertNot(
            presence_game_activity_policy:grant_allowed(
                2, Context, (grant(Game))#{policy_revision => <<"5">>}, Game, Open
            )
        ),
        %% The accepted dual-loss window ends when the authoritative write commits.
        ?assert(
            presence_game_activity_policy:grant_allowed(
                2, Context, (grant(Game))#{policy_revision => <<"4">>}, Game, Open
            )
        ),
        ?assertNotEqual(maps:get(owner_epoch, Original), maps:get(owner_epoch, Game))
    after
        meck:unload(presence_broadcast)
    end.

session_snapshot_cannot_reopen_fence_test() ->
    Game = presence_game_activity_policy:new(),
    Policy = #{
        policy_revision => <<"4">>,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    },
    Boot = presence_game_activity_policy:bootstrap({session, <<"verified">>}, Policy, Game),
    ?assert(presence_game_activity_policy:permitted(Boot)),
    {ok, Fenced} = presence_game_activity_policy:control(
        #{
            owner_epoch => null,
            policy_revision => <<"4">>,
            request_id => <<"close">>,
            phase => <<"fence">>
        },
        Boot
    ),
    ?assertEqual(
        Fenced,
        presence_game_activity_policy:bootstrap({session, <<"verified">>}, Policy, Fenced)
    ),
    ?assertEqual(
        Game,
        presence_game_activity_policy:bootstrap({session, <<>>}, Policy, Game)
    ).

replaced_owner_snapshot_needs_fresh_matching_grant_test() ->
    Original = maps:get(game_activity_state, fixture()),
    Policy = (maps:get(policy, Original))#{policy_revision => <<"4">>},
    Replacement = presence_game_activity_policy:bootstrap(
        {session, <<"reused-session-response">>}, Policy, presence_game_activity_policy:new()
    ),
    State = (fixture())#{game_activity_state => Replacement},
    OldContext = presence_game_activity_policy:context(2, Original),
    Context = presence_game_activity_policy:context(2, Replacement),
    Matching = (grant(Replacement))#{policy_revision => <<"4">>},
    ?assertNot(
        presence_game_activity_policy:grant_allowed(2, OldContext, Matching, Replacement, State)
    ),
    ?assertNot(
        presence_game_activity_policy:grant_allowed(
            2, Context, Matching#{policy_revision => <<"5">>}, Replacement, State
        )
    ),
    ?assert(
        presence_game_activity_policy:grant_allowed(2, Context, Matching, Replacement, State)
    ).

bootstrap_nonce_and_fence_test() ->
    G = presence_game_activity_policy:new(),
    Policy = #{
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    },
    ?assertEqual(G, presence_game_activity_policy:bootstrap(<<"old">>, Policy, G)),
    Boot = presence_game_activity_policy:bootstrap(maps:get(request_nonce, G), Policy, G),
    ?assert(presence_game_activity_policy:permitted(Boot)),
    Req = #{
        owner_epoch => maps:get(owner_epoch, G),
        policy_revision => <<"1">>,
        request_id => <<"one">>,
        phase => <<"fence">>
    },
    {ok, Fenced} = presence_game_activity_policy:control(Req, Boot),
    ?assertNot(presence_game_activity_policy:permitted(Fenced)),
    ?assertEqual(
        {error, stale},
        presence_game_activity_policy:control(
            Req#{phase => <<"apply">>, request_id => <<"old">>}, Fenced
        )
    ).

pair_overlapping_writes_stay_fenced_test() ->
    G = maps:get(game_activity_state, fixture()),
    Base = #{viewer_id => 2, phase => <<"fence">>},
    {ok, G1} = presence_game_activity_policy:pair_control(Base#{request_id => <<"one">>}, G),
    {ok, G2} = presence_game_activity_policy:pair_control(Base#{request_id => <<"two">>}, G1),
    Apply = Base#{phase => <<"apply">>, owner_epoch => maps:get(owner_epoch, G)},
    {ok, G3} = presence_game_activity_policy:pair_control(
        Apply#{request_id => <<"two">>, pair_generation => <<"2">>}, G2
    ),
    ?assert(maps:get(fenced, maps:get(2, maps:get(pairs, G3)))),
    {ok, G4} = presence_game_activity_policy:pair_control(
        Apply#{request_id => <<"one">>, pair_generation => <<"1">>}, G3
    ),
    ?assertNot(maps:is_key(2, maps:get(pairs, G4))).

chunks_lazy_sync_guild_create_have_no_game_test() ->
    State = (fixture())#{user_data => #{<<"id">> => <<"1">>, <<"username">> => <<"player">>}},
    {ok, Common} = presence_broadcast:current_visible_presence(State),
    ?assertNot(maps:is_key(<<"game_activity">>, Common)),
    Member = #{<<"user">> => #{<<"id">> => <<"1">>}},
    meck:new(presence_cache, [non_strict]),
    meck:expect(presence_cache, bulk_get, fun([1]) -> [Common] end),
    try
        Presences = guild_request_members_presence:maybe_fetch_presences(true, self(), [Member]),
        Chunk = guild_request_members_chunk:build_chunk_data([Member], Presences, 0, 1, null),
        ?assertEqual(false, has_game(Chunk)),
        assert_guild_payloads(Member, Common)
    after
        meck:unload(presence_cache)
    end.

assert_guild_payloads(Member, Common) ->
    Tab = ets:new(game_projection_guild, [set]),
    try
        ets:insert(Tab, {1, Common}),
        GuildState = #{
            id => 99,
            data => #{},
            sessions => #{},
            voice_states => #{},
            member_presence => Tab,
            connected_user_ids => sets:from_list([1])
        },
        LazyItem = guild_member_list_connected:add_presence_to_member(Member, GuildState),
        ?assertEqual(false, has_game(LazyItem)),
        Create = guild_data:get_guild_state(2, GuildState),
        ?assertEqual(false, has_game(Create))
    after
        ets:delete(Tab)
    end.

has_game(Map) when is_map(Map) ->
    maps:is_key(<<"game_activity">>, Map) orelse lists:any(fun has_game/1, maps:values(Map));
has_game(List) when is_list(List) -> lists:any(fun has_game/1, List);
has_game(_) ->
    false.

rollout_config_restart_resubscribes_and_cleans_test() ->
    Parent = self(),
    Config = spawn(fun() -> rollout_config_fixture(Parent) end),
    true = register(gateway_rollout_config, Config),
    {ok, Shard} = presence_manager_shard:start_link(0),
    try
        receive
            {config_subscription, Config, Shard} -> ok
        after 1000 -> ?assert(false)
        end,
        sys:replace_state(Shard, fun(State) ->
            State#{presences => #{1 => {Parent, make_ref()}}}
        end),
        Ref = monitor(process, Config),
        Config ! stop,
        receive
            {'DOWN', Ref, process, Config, normal} -> ok
        after 1000 -> ?assert(false)
        end,
        receive
            {'$gen_cast', {game_activity_rollout, {unavailable, _}}} -> ok
        after 300 -> ?assert(false)
        end,
        assert_replacement_subscription(Shard)
    after
        gen_server:stop(Shard),
        Config ! stop
    end.

rollout_config_missing_at_init_retries_test() ->
    {ok, Shard} = presence_manager_shard:start_link(0),
    try
        assert_replacement_subscription(Shard)
    after
        gen_server:stop(Shard)
    end.

assert_replacement_subscription(Shard) ->
    Parent = self(),
    Replacement = spawn(fun() -> rollout_config_fixture(Parent) end),
    true = register(gateway_rollout_config, Replacement),
    try
        receive
            {config_subscription, Replacement, Shard} -> ok
        after 1500 -> ?assert(false)
        end
    after
        Ref = monitor(process, Replacement),
        Replacement ! stop,
        receive
            {'DOWN', Ref, process, Replacement, normal} -> ok
        after 1000 -> ?assert(false)
        end
    end.

rollout_config_fixture(Parent) ->
    receive
        {'$gen_cast', {subscribe, Pid}} ->
            Parent ! {config_subscription, self(), Pid},
            rollout_config_fixture(Parent);
        stop ->
            ok
    after 10000 -> ok
    end.

invisible_clears_all_input_variants_test() ->
    with_rollout(fun() ->
        lists:foreach(fun assert_hidden_update/1, [
            absent, null, #{<<"game_id">> => <<"new">>, <<"started_at">> => 1}
        ])
    end).

assert_hidden_update(Input) ->
    S = fixture(),
    G = maps:get(game_activity_state, S),
    Candidate = #{
        changed => {0, <<"a">>},
        activity => #{},
        expires => erlang:monotonic_time(millisecond) + 120000
    },
    Game = G#{
        candidates => #{<<"a">> => Candidate, <<"b">> => Candidate},
        grants => #{self() => #{}},
        pending => {<<"a">>, #{}, maps:get(owner_epoch, G)},
        owner => <<"a">>
    },
    Request = #{session_id => <<"a">>, game_activity => Input},
    State = S#{game_activity_state => Game, sessions => #{<<"a">> => #{status => invisible}}},
    Next = presence_game_activity:update(Request, State),
    Cleared = maps:get(game_activity_state, Next),
    ?assertEqual(#{}, maps:get(candidates, Cleared)),
    ?assertEqual(#{}, maps:get(grants, Cleared)),
    ?assertEqual(undefined, maps:get(pending, Cleared)).

auth_terminate_keeps_cleanup_alive_test() ->
    with_rollout(fun assert_auth_terminate_cleanup/0).

assert_auth_terminate_cleanup() ->
    Parent = self(),
    Producer = spawn(fun terminate_producer_fixture/0),
    Receiver = spawn(fun() -> correction_receiver(Parent, healthy) end),
    meck:new(presence_broadcast, [non_strict]),
    meck:expect(presence_broadcast, publish_global_presence, fun(_, State) -> State end),
    meck:new(presence_update, [non_strict]),
    meck:expect(presence_update, flush_push_buffer, fun(State) -> State end),
    try
        S = fixture(),
        G = maps:get(game_activity_state, S),
        Entry = #{viewer_id => 2, stamp => presence_game_activity_policy:context(2, G)},
        State = S#{
            sessions => #{<<"a">> => #{pid => Producer, mref => monitor(process, Producer)}},
            game_activity_state => G#{ledger => #{Receiver => Entry}}
        },
        Result = presence_connect:handle_terminate_session_call([<<"auth">>], State),
        ?assertMatch({reply, ok, _}, Result),
        receive
            {corrected_fence, Receiver} -> ok
        after 500 -> ?assert(false)
        end
    after
        Producer ! stop,
        Receiver ! stop,
        meck:unload([presence_broadcast, presence_update])
    end.

terminate_producer_fixture() ->
    receive
        {'$gen_call', From, {terminate, _}} -> gen_server:reply(From, terminated);
        stop -> ok
    after 2000 -> ok
    end.

healthy_receiver_barrier_ack_completes_test() ->
    Parent = self(),
    Receiver = spawn(fun() -> correction_receiver(Parent, healthy) end),
    State = fixture(),
    Game = maps:get(game_activity_state, State),
    Entry = #{viewer_id => 2, stamp => presence_game_activity_policy:context(2, Game)},
    Worker = spawn(fun() ->
        presence_game_activity:barrier(
            {all, maps:iterator(#{Receiver => Entry})},
            #{<<"revoked_sessions">> => 0},
            State,
            Parent
        )
    end),
    try
        receive
            {game_activity_barrier_done, Worker, {ok, #{<<"revoked_sessions">> := 1}}} -> ok
        after 1000 -> ?assert(false)
        end
    after
        Receiver ! stop,
        exit(Worker, kill),
        flush()
    end.

all_receivers_fenced_despite_dead_and_slow_test_() ->
    {timeout, 8, fun all_receivers_fenced_despite_dead_and_slow/0}.

all_receivers_fenced_despite_dead_and_slow() ->
    Parent = self(),
    Dead = spawn(fun() -> ok end),
    DeadRef = monitor(process, Dead),
    receive
        {'DOWN', DeadRef, process, Dead, _} -> ok
    after 1000 -> ?assert(false)
    end,
    Slow = [spawn(fun() -> correction_receiver(Parent, slow) end) || _ <- lists:seq(1, 100)],
    Healthy = [
        spawn(fun() -> correction_receiver(Parent, healthy) end)
     || _ <- lists:seq(1, 101)
    ],
    S = fixture(),
    G = maps:get(game_activity_state, S),
    Entry = #{viewer_id => 2, stamp => presence_game_activity_policy:context(2, G)},
    Ledger = maps:from_list([{Pid, Entry} || Pid <- [Dead | Slow] ++ Healthy]),
    Worker = spawn(fun() ->
        presence_game_activity:barrier({all, maps:iterator(Ledger, ordered)}, #{}, S, Parent)
    end),
    try
        assert_healthy_fences(sets:from_list(Healthy)),
        receive
            {game_activity_barrier_done, Worker, {error, _}} -> ok
        after 5000 -> ?assert(false)
        end
    after
        exit(Worker, kill),
        lists:foreach(fun(Pid) -> Pid ! stop end, Slow ++ Healthy),
        flush()
    end.

assert_healthy_fences(Pending) ->
    case sets:size(Pending) of
        0 ->
            ok;
        _ ->
            receive
                {corrected_fence, Pid} -> assert_healthy_fences(sets:del_element(Pid, Pending))
            after 1000 -> ?assertEqual(0, sets:size(Pending))
            end
    end.

correction_receiver(Parent, Mode) ->
    receive
        {'$gen_cast', {game_activity_fence, _, _Stamp}} ->
            correction_receiver_notice(Mode, Parent),
            correction_receiver(Parent, Mode);
        {'$gen_call', From, {game_activity_fence, _, Stamp}} ->
            correction_receiver_reply(Mode, From, Stamp, Parent),
            correction_receiver(Parent, Mode);
        stop ->
            ok
    after 10000 -> ok
    end.

correction_receiver_notice(healthy, Parent) ->
    Parent ! {corrected_fence, self()},
    ok;
correction_receiver_notice(slow, _Parent) ->
    ok.

correction_receiver_reply(healthy, From, Stamp, Parent) ->
    Parent ! {corrected_fence, self()},
    gen_server:reply(From, {ok, Stamp});
correction_receiver_reply(slow, _From, _Stamp, _Parent) ->
    ok.

tombstone_has_active_is_false_test() ->
    {reply, HasActive, _} = presence:handle_call(has_active_sessions, {self(), make_ref()}, #{
        sessions => #{}
    }),
    ?assertEqual(false, HasActive).

tombstone_temporary_members_cleaned_immediately_test() ->
    Parent = self(),
    Ref = make_ref(),
    meck:new(presence_broadcast, [non_strict]),
    meck:expect(presence_broadcast, publish_global_presence, fun(_, State) -> State end),
    meck:new(presence_update, [non_strict]),
    meck:expect(presence_update, flush_push_buffer, fun(State) -> State end),
    meck:new(rpc_client, [non_strict]),
    meck:expect(rpc_client, call, fun(Request) ->
        Parent ! {temporary_cleanup, Request},
        ok
    end),
    try
        S = fixture(),
        State = S#{
            temporary_guild_ids => #{99 => true}, sessions => #{<<"a">> => #{mref => Ref}}
        },
        {noreply, Next} = presence_connect:handle_process_down(Ref, normal, State),
        receive
            {temporary_cleanup, #{<<"guild_ids">> := [<<"99">>]}} -> ok
        after 500 -> ?assert(false)
        end,
        ?assertEqual(#{}, maps:get(temporary_guild_ids, Next))
    after
        meck:unload([presence_broadcast, presence_update, rpc_client])
    end.

a_policy_null_epoch_fence_and_incremented_apply_test() ->
    S = fixture(),
    G = maps:get(game_activity_state, S),
    Request = #{
        owner_epoch => null,
        policy_revision => <<"0">>,
        phase => <<"fence">>,
        request_id => <<"contract">>
    },
    Result = presence_game_activity:control(policy, Request, S),
    ?assertMatch({{barrier, _, _}, _}, Result),
    {{barrier, _, Ack}, Fenced} = Result,
    ?assertEqual(
        lists:sort([
            <<"owner_epoch">>,
            <<"policy_revision">>,
            <<"phase">>,
            <<"request_id">>,
            <<"revoked_sessions">>
        ]),
        lists:sort(maps:keys(Ack))
    ),
    Apply = Request#{
        owner_epoch => maps:get(owner_epoch, G),
        policy_revision => <<"1">>,
        phase => <<"apply">>,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"close">>
    },
    ?assertMatch(
        {{barrier, _, #{<<"policy_revision">> := <<"1">>}}, _},
        presence_game_activity:control(policy, Apply, Fenced)
    ).

a_pair_ack_is_strict_and_generation_decimal_test() ->
    S = fixture(),
    Request = #{viewer_id => 2, phase => <<"fence">>, request_id => <<"pair-contract">>},
    {{barrier, _, Ack}, Fenced} = presence_game_activity:control(pair, Request, S),
    ?assertEqual(
        lists:sort([<<"owner_epoch">>, <<"pair_generation">>, <<"phase">>, <<"request_id">>]),
        lists:sort(maps:keys(Ack))
    ),
    ?assertEqual(<<"1">>, maps:get(<<"pair_generation">>, Ack)),
    Apply = Request#{
        phase => <<"apply">>,
        owner_epoch => maps:get(<<"owner_epoch">>, Ack),
        pair_generation => <<"1">>
    },
    ?assertMatch(
        {{barrier, _, #{<<"pair_generation">> := <<"1">>}}, _},
        presence_game_activity:control(pair, Apply, Fenced)
    ).

denied_initial_subscription_refreshes_after_bootstrap_test() ->
    with_rollout(fun() ->
        S = fixture(),
        G = maps:get(game_activity_state, S),
        Unknown = S#{game_activity_state => G#{policy => unknown}},
        {ok, Context} = presence_game_activity:context(2, Unknown),
        {{error, denied}, Interested} = presence_game_activity:subscribe(
            2, self(), Context, grant(G), Unknown
        ),
        _ = presence_game_activity:bootstrap(
            maps:get(request_nonce, G), maps:get(policy, G), Interested
        ),
        receive
            {'$gen_cast', {game_activity_refresh, 1}} -> ok
        after 500 -> ?assert(false)
        end
    end).

a_policy_fixture_overlapping_requests_stay_closed_test() ->
    %% A policy-fixture.json: fence A/B at revision 0, B friends at 1, A off at 2.
    G = presence_game_activity_policy:new(),
    Fence = #{
        <<"user_id">> => <<"2">>,
        <<"owner_epoch">> => null,
        <<"policy_revision">> => <<"0">>,
        <<"visibility">> => <<"off">>,
        <<"eligible_16_plus">> => true,
        <<"effective_profile_audience">> => <<"close">>,
        <<"phase">> => <<"fence">>,
        <<"request_id">> => <<"policy-request-a">>
    },
    {ok, A} = presence_game_activity_policy:control(Fence, G),
    {ok, B} = presence_game_activity_policy:control(
        Fence#{<<"request_id">> => <<"policy-request-b">>}, A
    ),
    Apply = Fence#{<<"owner_epoch">> => maps:get(owner_epoch, G), <<"phase">> => <<"apply">>},
    {ok, BApplied} = presence_game_activity_policy:control(
        Apply#{
            <<"request_id">> => <<"policy-request-b">>,
            <<"policy_revision">> => <<"1">>,
            <<"visibility">> => <<"friends">>
        },
        B
    ),
    ?assertNot(presence_game_activity_policy:permitted(BApplied)),
    {ok, AApplied} = presence_game_activity_policy:control(
        Apply#{<<"policy_revision">> => <<"2">>}, BApplied
    ),
    ?assertNot(presence_game_activity_policy:permitted(AApplied)),
    ?assertEqual(<<"2">>, maps:get(policy_revision, AApplied)).

with_rollout(Fun) ->
    meck:new(gateway_rollout_config, [non_strict]),
    meck:new(gateway_dispatch_relay, [non_strict]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 0} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 0 end),
    meck:expect(gateway_dispatch_relay, dispatch_many, fun(_, _, _) ->
        error(unexpected_sessions_replace)
    end),
    meck:expect(gateway_dispatch_relay, dispatch_game_activity_many, fun(Pids, Payload) ->
        lists:foreach(fun(P) -> P ! {wire, Payload} end, Pids),
        ok
    end),
    try
        Fun()
    after
        meck:unload([gateway_rollout_config, gateway_dispatch_relay]),
        flush()
    end.
flush() ->
    receive
        _ -> flush()
    after 0 -> ok
    end.
