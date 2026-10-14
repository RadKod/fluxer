%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_input_tests).
-include_lib("eunit/include/eunit.hrl").

absent_is_noop_test() ->
    {ok, Result} = validate(#{}),
    ?assertNot(maps:is_key(<<"game_activity">>, Result)).

null_survives_input_whitelist_test() ->
    ?assertMatch(
        {ok, #{<<"game_activity">> := null}}, validate(#{<<"game_activity">> => null})
    ).

status_still_required_test() ->
    ?assertEqual(
        {error, invalid_presence},
        gateway_handler_dispatch:validate_presence_data(#{<<"game_activity">> => null})
    ).

xor_identity_and_bounds_test() ->
    Good = #{<<"game_id">> => <<"sample-game">>, <<"started_at">> => 1},
    ?assertMatch({ok, #{<<"game_activity">> := Good}}, game(Good)),
    ?assertEqual({error, invalid_presence}, game(Good#{<<"manual_name">> => <<"Game">>})),
    ?assertEqual({error, invalid_presence}, game(Good#{<<"owner_epoch">> => 1})),
    ?assertEqual({error, invalid_presence}, game(Good#{<<"game_id">> => <<"../game">>})),
    ?assertEqual({error, invalid_presence}, game(Good#{<<"game_id">> => <<"game\n">>})),
    ?assertEqual({error, invalid_presence}, game(#{<<"started_at">> => 1})),
    ?assertEqual({error, invalid_presence}, game([])).

manual_unicode_bounds_test() ->
    Good = #{<<"manual_name">> => <<"A Game">>, <<"started_at">> => 1},
    ?assertMatch({ok, _}, game(Good)),
    lists:foreach(
        fun(Name) ->
            ?assertEqual({error, invalid_presence}, game(Good#{<<"manual_name">> => Name}))
        end,
        [
            <<>>,
            binary:copy(<<"a">>, 65),
            <<"a\nb">>,
            <<16#202E/utf8>>,
            <<16#200B/utf8>>,
            <<255>>
        ]
    ).

unsafe_number_rejected_test() ->
    lists:foreach(
        fun(Start) ->
            ?assertEqual(
                {error, invalid_presence},
                game(#{<<"game_id">> => <<"game">>, <<"started_at">> => Start})
            )
        end,
        [9007199254740992, -9007199254740992, 1.25, <<"1">>, null]
    ).

validate(Extra) ->
    gateway_handler_dispatch:validate_presence_data(Extra#{<<"status">> => <<"online">>}).

game(Activity) -> validate(#{<<"game_activity">> => Activity}).

session_rpc_nonce_echo_test() ->
    meck:new(api_rpc_client, [non_strict]),
    try
        lists:foreach(
            fun assert_session_rpc_nonce_echo/1,
            [matching, wrong, missing]
        ),
        ?assertEqual(3, meck:num_calls(api_rpc_client, call_with_retry, '_'))
    after
        meck:unload(api_rpc_client)
    end.

assert_session_rpc_nonce_echo(Echo) ->
    meck:expect(api_rpc_client, call_with_retry, fun(Request, _) ->
        Nonce = maps:get(<<"game_activity_request_nonce">>, Request, undefined),
        self() ! {requested_nonce, Nonce},
        Data = #{<<"game_activity_policy">> => bootstrap_policy()},
        {ok,
            case Echo of
                matching -> Data#{<<"game_activity_request_nonce">> => Nonce};
                wrong -> Data#{<<"game_activity_request_nonce">> => <<"wrong">>};
                missing -> Data
            end}
    end),
    {ok, Data} = session_manager_shard_drain:fetch_rpc_data(
        #{identify_data => #{token => <<"token">>}, version => 1}, <<"127.0.0.1">>
    ),
    receive
        {requested_nonce, Nonce} ->
            ?assert(is_binary(Nonce)),
            ?assert(byte_size(Nonce) >= 24),
            case Echo of
                matching -> ?assertEqual(Nonce, maps:get(game_activity_request_nonce, Data));
                _ -> ?assertNot(maps:is_key(game_activity_request_nonce, Data))
            end
    after 100 -> ?assert(false)
    end.

session_bootstrap_reaches_unknown_owner_test() ->
    Nonce = <<"verified-session-nonce">>,
    User = #{
        <<"id">> => <<"1">>,
        <<"username">> => <<"player">>,
        <<"discriminator">> => <<"0001">>,
        <<"avatar">> => null,
        <<"flags">> => 0
    },
    Data = #{
        <<"user">> => User,
        <<"guilds">> => [],
        <<"game_activity_policy">> => bootstrap_policy(),
        game_activity_request_nonce => Nonce
    },
    Built = session_manager_shard_drain:build_session_data(
        Data, #{properties => #{}, token => <<"token">>}, 1, self(), <<"session">>, User, 1
    ),
    ?assertEqual(Nonce, maps:get(game_activity_request_nonce, Built, undefined)),
    State = session_init:build_state(Built),
    ?assertEqual(Nonce, maps:get(game_activity_request_nonce, State, undefined)),
    Parent = self(),
    Owner = spawn(fun() ->
        receive
            {'$gen_call', From, {session_connect, Request}} ->
                Initial = presence_game_activity:init(#{user_id => 1, sessions => #{}}),
                {reply, {ok, _}, Boot} = presence_session:handle_session_connect(
                    Request, Parent, Initial
                ),
                Parent ! {bootstrapped, maps:get(game_activity_state, Boot)},
                gen_server:reply(From, {error, test_complete})
        after 1000 -> error(owner_connect_timeout)
        end
    end),
    meck:new(presence_manager, [non_strict]),
    meck:expect(presence_manager, start_or_lookup, fun(_) -> {ok, Owner} end),
    try
        {noreply, _} = session_connection_presence:handle_presence_connect(0, State),
        receive
            {bootstrapped, Game} ->
                ?assertEqual(<<"4">>, maps:get(policy_revision, Game)),
                ?assert(presence_game_activity_policy:permitted(Game))
        after 1000 -> ?assert(false)
        end
    after
        meck:unload(presence_manager),
        erlang:demonitor(maps:get(socket_mref, State), [flush])
    end.

bootstrap_policy() ->
    #{
        <<"policy_revision">> => <<"4">>,
        <<"visibility">> => <<"friends">>,
        <<"eligible_16_plus">> => true,
        <<"effective_profile_audience">> => <<"friends">>
    }.

offline_fence_survives_owner_creation_test() ->
    meck:new(process_registry, [non_strict]),
    meck:new(presence, [non_strict]),
    meck:expect(process_registry, build_process_key, fun(_, Id) -> Id end),
    meck:expect(process_registry, lookup_or_monitor, fun(_, _, _) -> {error, not_found} end),
    meck:expect(process_registry, registry_whereis, fun(_) -> undefined end),
    Parent = self(),
    meck:expect(presence, start_link, fun(Data) ->
        Parent ! {owner_data, Data},
        {error, captured}
    end),
    try
        Fence = control_fence(),
        {reply, {offline, Ack}, Pending} = presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, Fence}, {self(), make_ref()}, #{presences => #{}}
        ),
        ?assertEqual(<<"fence">>, maps:get(<<"phase">>, Ack)),
        {reply, {error, captured}, _} = presence_manager_shard:handle_call(
            {start_or_lookup, #{
                user_id => 1, user_data => #{}, guild_ids => [], status => online
            }},
            {self(), make_ref()},
            Pending
        ),
        assert_owner_inherited_fence(),
        Apply = (bootstrap_policy())#{
            <<"phase">> => <<"apply">>,
            <<"policy_revision">> => <<"5">>,
            <<"request_id">> => <<"close">>,
            <<"owner_epoch">> => maps:get(<<"owner_epoch">>, Ack)
        },
        {reply, {offline, _}, Applied} = presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, Apply}, {self(), make_ref()}, Pending
        ),
        ?assertEqual(#{}, maps:get(game_activity_pending, Applied)),
        {reply, {offline, _}, NoopApplied} = presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, Apply#{<<"policy_revision">> => <<"4">>}},
            {self(), make_ref()},
            Pending
        ),
        ?assertEqual(#{}, maps:get(game_activity_pending, NoopApplied))
    after
        meck:unload([process_registry, presence])
    end.

assert_owner_inherited_fence() ->
    receive
        {owner_data, Data} ->
            Shadow = maps:get(game_activity_pending, Data),
            ?assert(maps:get(fenced, Shadow)),
            ?assertEqual(<<"4">>, maps:get(policy_revision, Shadow)),
            ?assertEqual(
                Shadow,
                presence_game_activity_policy:bootstrap(
                    {session, <<"late">>}, bootstrap_policy(), Shadow
                )
            )
    after 100 -> ?assert(false)
    end.

offline_pair_fence_is_idempotent_and_applies_test() ->
    meck:new(process_registry, [non_strict]),
    meck:expect(process_registry, build_process_key, fun(_, Id) -> Id end),
    meck:expect(process_registry, lookup_or_monitor, fun(_, _, _) -> {error, not_found} end),
    try
        Fence = #{viewer_id => 2, phase => <<"fence">>, request_id => <<"pair-close">>},
        Call = {game_activity_prepare, 1, pair, Fence},
        From = {self(), make_ref()},
        {reply, {offline, Ack}, Pending} = presence_manager_shard:handle_call(
            Call, From, #{presences => #{}}
        ),
        {reply, {offline, Again}, _} = presence_manager_shard:handle_call(Call, From, Pending),
        ?assertEqual(Ack, Again),
        Apply = Fence#{
            phase => <<"apply">>,
            owner_epoch => maps:get(<<"owner_epoch">>, Ack),
            pair_generation => maps:get(<<"pair_generation">>, Ack)
        },
        {reply, {offline, _}, Applied} = presence_manager_shard:handle_call(
            {game_activity_prepare, 1, pair, Apply}, From, Pending
        ),
        ?assertEqual(#{}, maps:get(game_activity_pending, Applied))
    after
        meck:unload(process_registry)
    end.

live_fence_keeps_manager_guard_until_current_owner_apply_test() ->
    Other = spawn(fun() ->
        receive
            stop -> ok
        after 5000 -> error(owner_stop_timeout)
        end
    end),
    try
        State = #{presences => #{1 => {self(), make_ref()}}},
        {reply, {owner, Pid, _Token}, Pending} = presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, control_fence()}, {self(), make_ref()}, State
        ),
        ?assertEqual(self(), Pid),
        ?assert(maps:is_key(1, maps:get(game_activity_pending, Pending))),
        Ack = #{
            <<"owner_epoch">> => <<"old-owner">>,
            <<"phase">> => <<"fence">>,
            <<"request_id">> => <<"close">>,
            <<"policy_revision">> => <<"4">>,
            <<"revoked_sessions">> => 0
        },
        Replaced = Pending#{presences => #{1 => {Other, make_ref()}}},
        {reply, retry, Preserved} = presence_manager_shard:handle_call(
            {game_activity_finish, 1, policy, control_fence(), self(), Ack},
            {self(), make_ref()},
            Replaced
        ),
        ?assertEqual(
            maps:get(game_activity_pending, Pending), maps:get(game_activity_pending, Preserved)
        )
    after
        Other ! stop
    end.

rejected_new_fence_does_not_strand_manager_guard_test() ->
    From = {self(), make_ref()},
    Request = control_fence(),
    State = #{presences => #{1 => {self(), make_ref()}}},
    {reply, Reply, Pending} = presence_manager_shard:handle_call(
        {game_activity_prepare, 1, policy, Request}, From, State
    ),
    Token = element(tuple_size(Reply), Reply),
    {reply, ok, Rejected} = presence_manager_shard:handle_call(
        {game_activity_reject, 1, policy, Request, self(), Token}, From, Pending
    ),
    ?assertEqual(#{}, maps:get(game_activity_pending, Rejected)),
    {reply, _, Retried} = presence_manager_shard:handle_call(
        {game_activity_prepare, 1, policy, Request}, From, Pending
    ),
    {reply, ok, Preserved} = presence_manager_shard:handle_call(
        {game_activity_reject, 1, policy, Request, self(), Token}, From, Retried
    ),
    ?assert(maps:is_key(1, maps:get(game_activity_pending, Preserved))).

control_fence() ->
    #{
        <<"phase">> => <<"fence">>,
        <<"policy_revision">> => <<"4">>,
        <<"request_id">> => <<"close">>,
        <<"owner_epoch">> => null
    }.

busy_fence_fails_fast_and_releases_only_rejected_guard_test_() ->
    [{timeout, 8, fun() -> assert_busy_fence(At) end} || At <- [owner, manager]].

assert_busy_fence(At) ->
    Owner = spawn(fun busy_owner/0),
    Initial = #{
        presences => #{1 => {Owner, make_ref()}},
        game_activity_pending_count =>
            case At of
                manager -> 10000;
                owner -> 0
            end
    },
    Manager = spawn(fun() -> busy_manager(Initial) end),
    true = register(presence_manager, Manager),
    meck:new(gateway_node_router, [non_strict]),
    meck:expect(gateway_node_router, owner_node_result, fun(_, _) -> {ok, node()} end),
    Started = erlang:monotonic_time(millisecond),
    try
        ?assertError(
            {gateway_rpc_error, <<"game_activity_policy_unavailable">>},
            gateway_rpc_presence:execute_method(
                <<"presence.game_activity_policy">>,
                (control_fence())#{<<"user_id">> => <<"1">>}
            )
        ),
        ?assert(erlang:monotonic_time(millisecond) - Started < 500),
        Final = gen_server:call(Manager, state),
        ?assertEqual(#{}, maps:get(game_activity_pending, Final, #{})),
        ?assertEqual(
            maps:get(game_activity_pending_count, Initial),
            maps:get(game_activity_pending_count, Final)
        )
    after
        exit(Manager, kill),
        exit(Owner, kill),
        meck:unload(gateway_node_router)
    end.

busy_owner() ->
    receive
        {'$gen_call', From, _} ->
            gen_server:reply(From, {error, busy}),
            busy_owner()
    after 5000 -> error(busy_owner_timeout)
    end.

busy_manager(State) ->
    receive
        {'$gen_call', From, state} ->
            gen_server:reply(From, State),
            busy_manager(State);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = presence_manager_shard:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            busy_manager(Next)
    after 5000 -> error(busy_manager_timeout)
    end.

gateway_apply_retries_current_owner_test() ->
    Dead = spawn(fun() -> ok end),
    Ref = monitor(process, Dead),
    receive
        {'DOWN', Ref, process, Dead, _} -> ok
    after 1000 -> ?assert(false)
    end,
    Parent = self(),
    Ack = #{
        <<"owner_epoch">> => <<"replacement">>,
        <<"phase">> => <<"apply">>,
        <<"request_id">> => <<"close">>,
        <<"policy_revision">> => <<"5">>,
        <<"revoked_sessions">> => 0
    },
    Owner = spawn(fun() ->
        receive
            {'$gen_call', From, {game_activity_control, policy, _}} ->
                Parent ! applied_to_current_owner,
                gen_server:reply(From, {ok, Ack})
        after 5000 -> error(owner_apply_timeout)
        end
    end),
    Manager = spawn(fun() -> route_manager([Dead, Owner], Parent) end),
    true = register(presence_manager, Manager),
    meck:new(gateway_node_router, [non_strict]),
    meck:expect(gateway_node_router, owner_node_result, fun(1, presence) -> {ok, node()} end),
    try
        Params = (control_fence())#{
            <<"user_id">> => <<"1">>,
            <<"phase">> => <<"apply">>,
            <<"policy_revision">> => <<"5">>
        },
        ?assertEqual(
            Ack,
            gateway_rpc_presence:execute_method(<<"presence.game_activity_policy">>, Params)
        ),
        receive
            applied_to_current_owner -> ok
        after 100 -> ?assert(false)
        end,
        receive
            {finished_current_owner, Owner} -> ok
        after 100 -> ?assert(false)
        end
    after
        exit(Manager, kill),
        exit(Owner, kill),
        meck:unload(gateway_node_router)
    end.

route_manager([Pid | Rest], Parent) ->
    receive
        {'$gen_call', From, {game_activity_prepare, 1, policy, _}} ->
            gen_server:reply(From, {owner, Pid, undefined}),
            route_manager(Rest, Parent)
    after 5000 -> error(manager_prepare_timeout)
    end;
route_manager([], Parent) ->
    receive
        {'$gen_call', From, {game_activity_finish, 1, policy, _, Pid, _}} ->
            Parent ! {finished_current_owner, Pid},
            gen_server:reply(From, ok)
    after 5000 -> error(manager_finish_timeout)
    end.

unavailable_manager_never_acknowledges_test_() ->
    {timeout, 8, fun() ->
        meck:new(gateway_node_router, [non_strict]),
        meck:expect(gateway_node_router, owner_node_result, fun(_, _) ->
            {error, unavailable}
        end),
        Started = erlang:monotonic_time(millisecond),
        try
            ?assertError(
                {gateway_rpc_error, <<"game_activity_policy_timeout">>},
                gateway_rpc_presence:execute_method(
                    <<"presence.game_activity_policy">>,
                    (control_fence())#{<<"user_id">> => <<"1">>}
                )
            ),
            ?assert(erlang:monotonic_time(millisecond) - Started < 5500)
        after
            meck:unload(gateway_node_router)
        end
    end}.
