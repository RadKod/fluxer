%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_rollout_contract_tests).
-include_lib("eunit/include/eunit.hrl").

ready_uses_fresh_authority_test() ->
    set_authority(true, 7, 45000),
    Ready = session_game_activity:wire(ready, #{<<"presences">> => []}, #{}),
    ?assertEqual(payload(false, 7), maps:get(<<"gateway_rollout">>, Ready, missing)),
    set_authority(true, 7, 0),
    Fresh = session_game_activity:wire(ready, #{}, #{}),
    ?assertEqual(payload(true, 7), maps:get(<<"gateway_rollout">>, Fresh, missing)).

stale_replay_cannot_reopen_rollout_test() ->
    set_authority(false, 8, 0),
    Entry = #{event => gateway_rollout_update, seq => 1, data => payload(true, 7)},
    [#{data := Data}] = session_game_activity:replay([Entry], #{}),
    ?assertEqual(payload(false, 8), Data),
    Encoded = {pre_encoded, iolist_to_binary(json:encode(payload(true, 7)))},
    ?assertEqual(
        payload(false, 8), session_game_activity:wire(gateway_rollout_update, Encoded, #{})
    ).

live_notifications_read_current_authority_test() ->
    set_authority(false, 8, 0),
    {noreply, Closed} = session:handle_cast(game_activity_rollout_changed, state()),
    ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
    ?assertEqual(payload(false, 8), next_rollout()),
    set_authority(true, 8, 0),
    {noreply, _} = session:handle_cast(game_activity_rollout_changed, Closed),
    ?assertEqual(payload(true, 8), next_rollout()).

disabled_receiver_rejects_new_expectation_test() ->
    set_authority(false, 9, 0),
    Context = #{
        owner_pid => self(),
        owner_epoch => <<"owner">>,
        policy_revision => 1,
        pair_generation => 1,
        request_nonce => <<"fresh">>
    },
    ?assertEqual(
        {reply, {error, rollout_closed}, state()},
        session_game_activity:expect(42, Context, state())
    ).

duplicate_config_notification_preserves_fresh_grant_test() ->
    try
        duplicate_config_notification()
    after
        drain_game_messages()
    end.

duplicate_config_notification() ->
    set_authority(true, 9, 0),
    {noreply, First} = session:handle_cast(game_activity_rollout_changed, state()),
    _ = next_rollout(),
    Context = fresh_context(),
    {reply, ok, Expected} = session_game_activity:expect(42, Context, First),
    {reply, {ok, Context}, Granted} = session_game_activity:grant(42, Context, Expected),
    {noreply, Duplicate} = session:handle_cast(game_activity_rollout_changed, Granted),
    ?assertEqual(Granted, Duplicate),
    ?assertMatch({reply, ok, _}, session_game_activity:expect(42, Context, Duplicate)),
    {noreply, _} = session:handle_cast(
        {game_activity, 42, activity(), Context},
        Duplicate#{relationships => #{42 => 1}}
    ),
    receive
        {dispatch, presence_update, #{<<"game_activity">> := Visible}, _} ->
            ?assert(is_map(Visible))
    after 300 -> ?assert(false)
    end.

explicit_reset_still_clears_same_gate_grant_test() ->
    try
        explicit_reset()
    after
        drain_game_messages()
    end.

explicit_reset() ->
    set_authority(true, 9, 0),
    Context = fresh_context(),
    {reply, ok, Expected} = session_game_activity:expect(42, Context, state()),
    {reply, {ok, Context}, Granted} = session_game_activity:grant(42, Context, Expected),
    {noreply, Reset} = session:handle_cast(game_activity_reset, Granted),
    ?assertEqual(#{}, maps:get(game_activity_grants, Reset)),
    receive
        {dispatch, presence_update, #{<<"game_activity">> := null}, _} -> ok
    after 300 -> ?assert(false)
    end.

first_delayed_notification_preserves_current_authority_grant_test() ->
    try
        set_authority(true, 9, 0),
        Context = fresh_context(),
        {reply, ok, Expected} = session_game_activity:expect(42, Context, state()),
        {reply, {ok, Context}, Granted} = session_game_activity:grant(42, Context, Expected),
        {noreply, Same} = session:handle_cast(game_activity_rollout_changed, Granted),
        ?assertEqual(Granted, Same),
        ?assertMatch({reply, ok, _}, session_game_activity:expect(42, Context, Same))
    after
        drain_game_messages()
    end.

same_epoch_generation_change_cleans_old_and_new_grants_test() ->
    try
        set_authority(true, 9, 0),
        Context = fresh_context(),
        {reply, ok, Expected} = session_game_activity:expect(42, Context, state()),
        {reply, {ok, Context}, Old} = session_game_activity:grant(42, Context, Expected),
        Gate = persistent_term:get({gateway_rollout_config, game_activity_gate}),
        persistent_term:put({gateway_rollout_config, game_activity_gate}, Gate#{
            generation => 10
        }),
        {reply, ok, NewExpected} = session_game_activity:expect(43, Context, Old),
        {reply, {ok, Context}, Mixed} = session_game_activity:grant(43, Context, NewExpected),
        {noreply, Closed} = session:handle_cast(game_activity_rollout_changed, Mixed),
        ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
        ?assertEqual(payload(true, 9), next_rollout())
    after
        drain_game_messages()
    end.

fresh_context() ->
    #{
        owner_pid => self(),
        owner_epoch => <<"owner">>,
        policy_revision => 1,
        pair_generation => 1,
        request_nonce => <<"fresh">>,
        rollout_epoch => 9,
        allowed => true,
        activity_revision => 0
    }.

disabled_receiver_rejects_inflight_grant_test() ->
    set_authority(true, 9, 0),
    Context = #{
        owner_pid => self(),
        owner_epoch => <<"owner">>,
        policy_revision => 1,
        pair_generation => 1,
        request_nonce => <<"fresh">>,
        rollout_epoch => 9,
        allowed => true
    },
    {reply, ok, Expected} = session_game_activity:expect(42, Context, state()),
    set_authority(false, 9, 0),
    ?assertMatch(
        {reply, {error, stale_grant}, _},
        session_game_activity:grant(42, Context, Expected)
    ).

disabled_owner_drops_input_and_interest_test() ->
    set_authority(false, 0, 0),
    Owner = owner(),
    Game = maps:get(game_activity_state, Owner),
    {ok, Context} = presence_game_activity:context(7, Owner),
    Grant = owner_grant(Game),
    Input = #{session_id => <<"s">>, game_activity => activity()},
    ?assertEqual(Owner, presence_game_activity:update(Input, Owner)),
    {{error, denied}, Denied} = presence_game_activity:subscribe(
        7, self(), Context, Grant, Owner
    ),
    ?assertEqual(Owner, Denied),
    ?assertEqual(state(), session_game_activity:subscribe(state())).

presence_close_and_explicit_reset_clear_game_state_test() ->
    set_authority(true, 0, 0),
    Original = owner(),
    Game = maps:get(game_activity_state, Original),
    Open = Original#{game_activity_state := Game#{candidates => #{<<"s">> => activity()}}},
    set_authority(false, 0, 0),
    {noreply, Closed} = presence:handle_cast({game_activity_rollout, {false, 0, 0}}, Open),
    ClosedGame = maps:get(game_activity_state, Closed),
    ?assertEqual(#{}, maps:get(candidates, ClosedGame)),
    ?assertEqual(#{}, maps:get(grants, ClosedGame)),
    ?assertNotEqual(maps:get(request_nonce, Game), maps:get(request_nonce, ClosedGame)),
    receive
        {'$gen_cast', game_activity_rollout_changed} -> ok
    after 300 -> ?assert(false)
    end,
    Reset = presence_game_activity:rollout(Closed),
    ?assertNotEqual(
        maps:get(request_nonce, ClosedGame),
        maps:get(request_nonce, maps:get(game_activity_state, Reset))
    ),
    receive
        {'$gen_cast', game_activity_reset} -> ok
    after 300 -> ?assert(false)
    end.

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
        friends => #{7 => true},
        custom_status => null,
        sessions => #{
            <<"s">> => #{status => online, afk => false, mobile => false, pid => self()}
        }
    }.

activity() ->
    #{<<"game_id">> => <<"game">>, <<"started_at">> => erlang:system_time(millisecond)}.

disabled_game_only_has_zero_common_fanout_and_keeps_oset_test() ->
    set_authority(false, 0, 0),
    meck:new(gateway_dispatch_relay, [passthrough, no_link]),
    meck:new(presence_broadcast, [passthrough, no_link]),
    meck:expect(gateway_dispatch_relay, dispatch_many, fun(_, _, _, _) -> ok end),
    meck:expect(presence_broadcast, publish_global_presence, fun(_, State) -> State end),
    OSet = guild_member_list_oset:new(),
    Keys = [{0, <<"a">>, 1}, {1, <<"b">>, 7}],
    ok = guild_member_list_oset:from_sorted(OSet, Keys),
    Patterns = [
        {guild_member_list_oset, insert, 2},
        {guild_member_list_oset, delete, 2},
        {guild_dispatch_member_list, maybe_broadcast_member_list_update, 4}
    ],
    lists:foreach(
        fun({Module, _, _} = Pattern) ->
            code:ensure_loaded(Module),
            erlang:trace_pattern(Pattern, true, [local, call_count])
        end,
        Patterns
    ),
    try
        Original = owner(),
        Request = #{session_id => <<"s">>, status => online, game_activity => activity()},
        {noreply, Dropped} = presence:handle_cast({presence_update, Request}, Original),
        ?assertEqual(Original, Dropped),
        ?assertEqual(Keys, guild_member_list_oset:to_list(OSet)),
        ?assertEqual(0, meck:num_calls(gateway_dispatch_relay, dispatch_many, '_')),
        ?assertEqual(
            0, meck:num_calls(gateway_dispatch_relay, dispatch_game_activity_many, '_')
        ),
        ?assertEqual(0, meck:num_calls(presence_broadcast, publish_global_presence, '_')),
        lists:foreach(
            fun(Pattern) ->
                ?assertEqual({call_count, 0}, erlang:trace_info(Pattern, call_count))
            end,
            Patterns
        ),
        assert_disabled_status(idle, Request, Dropped),
        assert_disabled_status(online, Request, Dropped)
    after
        lists:foreach(
            fun(Pattern) ->
                erlang:trace_pattern(Pattern, false, [local, call_count])
            end,
            Patterns
        ),
        guild_member_list_oset:destroy(OSet),
        meck:unload([gateway_dispatch_relay, presence_broadcast])
    end.

assert_disabled_status(Status, Request, Owner) ->
    {noreply, Next} = presence:handle_cast(
        {presence_update, Request#{status => Status}}, Owner
    ),
    ?assertEqual(Status, presence_status:get_current_status(maps:get(sessions, Next))),
    ?assertEqual(maps:get(game_activity_state, Owner), maps:get(game_activity_state, Next)).

under16_policy_fences_real_receiver_test() ->
    set_authority(true, 0, 0),
    Parent = self(),
    Receiver = spawn(fun() ->
        receiver_loop((state())#{socket_pid => Parent, relationships => #{1 => 1}})
    end),
    try
        Owner = owner(),
        Game = maps:get(game_activity_state, Owner),
        {ok, Context} = presence_game_activity:context(7, Owner),
        ok = gen_server:call(Receiver, {game_activity_expect, 1, Context}),
        Grant = owner_grant(Game),
        {{ok, Stamp}, Granted} = presence_game_activity:subscribe(
            7, Receiver, Context, Grant, Owner
        ),
        gen_server:cast(Receiver, {game_activity, 1, activity(), Stamp}),
        receive
            {dispatch, presence_update, #{<<"game_activity">> := Visible}, _} ->
                ?assert(is_map(Visible))
        after 500 -> ?assert(false)
        end,
        Request = #{
            phase => <<"fence">>,
            policy_revision => <<"0">>,
            request_id => <<"narrow">>,
            owner_epoch => null
        },
        {{barrier, Targets, _}, Fenced} = presence_game_activity:control(
            policy, Request, Granted
        ),
        ?assertEqual(
            {ok, 1},
            presence_game_activity_policy:revoke(
                Targets,
                Fenced,
                erlang:monotonic_time(millisecond) + 1000
            )
        ),
        receive
            {dispatch, presence_update, #{<<"game_activity">> := null}, _} -> ok
        after 500 -> ?assert(false)
        end,
        AppliedRequest = narrowed_policy(Request, Game),
        {{barrier, _, _}, Applied} = presence_game_activity:control(
            policy, AppliedRequest, Fenced
        ),
        ?assertNot(presence_game_activity:allowed(Applied)),
        ?assertEqual(#{}, maps:get(game_activity_grants, gen_server:call(Receiver, state))),
        ?assertEqual(
            Applied,
            presence_game_activity:update(
                #{session_id => <<"s">>, game_activity => activity()}, Applied
            )
        )
    after
        Receiver ! stop,
        drain_game_messages()
    end.

owner_grant(Game) ->
    #{
        owner_id => <<"1">>,
        policy_revision => <<"0">>,
        request_nonce => maps:get(request_nonce, Game),
        allowed => true,
        friend => true,
        blocked => false,
        eligible_16_plus => true,
        profile_view => <<"full">>
    }.

narrowed_policy(Request, Game) ->
    Request#{
        phase => <<"apply">>,
        owner_epoch => maps:get(owner_epoch, Game),
        policy_revision => <<"1">>,
        visibility => <<"friends">>,
        eligible_16_plus => false,
        effective_profile_audience => <<"guilds">>
    }.

receiver_loop(State) ->
    receive
        {'$gen_call', From, state} ->
            gen_server:reply(From, State),
            receiver_loop(State);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = session:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            receiver_loop(Next);
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            receiver_loop(Next);
        stop ->
            ok
    after 5000 -> ok
    end.

drain_game_messages() ->
    receive
        {dispatch, _, _, _} -> drain_game_messages();
        {game_activity_delivery, _, _} -> drain_game_messages()
    after 0 -> ok
    end.

disabled_rollout_cancels_subscription_worker_test() ->
    set_authority(false, 9, 0),
    Worker = spawn(fun() ->
        receive
            stop -> ok
        after 5000 -> ok
        end
    end),
    Ref = monitor(process, Worker),
    Open = (state())#{
        game_activity_subscription_pid => Worker,
        game_activity_subscription_targets => #{42 => true}
    },
    Closed = session_game_activity:rollout(Open),
    ?assertEqual(#{}, maps:get(game_activity_subscription_targets, Closed, #{})),
    ?assertNot(maps:is_key(game_activity_subscription_pid, Closed)),
    receive
        {'DOWN', Ref, process, Worker, killed} -> ok
    after 300 -> ?assert(false)
    end.

payload(Enabled, Epoch) ->
    #{<<"game_activity_enabled">> => Enabled, <<"game_activity_epoch">> => Epoch}.

set_authority(Enabled, Epoch, Age) ->
    persistent_term:put(gateway_rollout_config, payload(Enabled, Epoch)),
    persistent_term:put({gateway_rollout_config, game_activity_gate}, #{
        epoch => Epoch,
        generation => Epoch,
        validated_at => erlang:monotonic_time(millisecond) - Age
    }).

state() ->
    #{
        user_id => 7,
        bot => false,
        seq => 0,
        buffer => [],
        buffer_bytes => 0,
        socket_pid => self(),
        relationships => #{},
        suppress_presence_updates => false,
        pending_presences => []
    }.

next_rollout() ->
    receive
        {dispatch, gateway_rollout_update, Data, _} -> Data
    after 300 -> error(missing_rollout_update)
    end.
