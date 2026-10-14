%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_retry_tests).
-include_lib("eunit/include/eunit.hrl").

new_revision_recovery_at_owner_capacity_test() ->
    Base = policy(),
    Requests = maps:from_list([
        {{recoverable, integer_to_binary(N)}, integer_to_binary(N)}
     || N <- lists:seq(0, 63)
    ]),
    Full = Base#{
        policy_revision => <<"63">>,
        policy_requests => Requests,
        recoverable_policy_requests => maps:from_keys(maps:keys(Requests), true),
        fenced => true
    },
    {ok, Retried} = presence_game_activity_policy:control(fence(<<"64">>), Full),
    ?assertEqual(#{{recoverable, <<"64">>} => <<"64">>}, maps:get(policy_requests, Retried)),
    ?assertEqual(1, presence_game_activity_policy:pending_count(Retried)),
    ?assertNot(presence_game_activity_policy:permitted(Retried)),
    {ok, Applied} = presence_game_activity_policy:control(
        apply_request(<<"65">>, Retried), Retried
    ),
    ?assert(presence_game_activity_policy:permitted(Applied)).

new_revision_recovery_at_real_shard_capacity_test() ->
    {ok, Game} = presence_game_activity_policy:control(fence(<<"0">>), policy()),
    Pending = maps:from_keys(lists:seq(1, 10000), Game),
    State = #{
        presences => #{1 => {self(), make_ref()}},
        game_activity_pending => Pending,
        game_activity_pending_count => 10000
    },
    From = {self(), make_ref()},
    Request = fence(<<"1">>),
    {reply, {owner, _, Token}, Prepared} = presence_manager_shard:handle_call(
        {game_activity_prepare, 1, policy, Request}, From, State
    ),
    ?assertEqual(10000, maps:get(game_activity_pending_count, Prepared)),
    {reply, ok, Rejected} = presence_manager_shard:handle_call(
        {game_activity_reject, 1, policy, Request, self(), Token}, From, Prepared
    ),
    Replacement = maps:get(1, maps:get(game_activity_pending, Rejected)),
    ?assertEqual(#{{recoverable, <<"1">>} => <<"1">>}, maps:get(policy_requests, Replacement)),
    ?assert(maps:get(fenced, Replacement)),
    ?assertEqual(10000, maps:get(game_activity_pending_count, Rejected)),
    Apply = apply_request(<<"2">>, Replacement),
    {reply, ok, Finished} = presence_manager_shard:handle_call(
        {game_activity_finish, 1, policy, Apply, self(), #{}}, From, Rejected
    ),
    ?assertEqual(9999, maps:get(game_activity_pending_count, Finished)),
    ?assertNot(maps:is_key(1, maps:get(game_activity_pending, Finished))).

newer_fence_preserves_protected_and_current_writer_guards_test() ->
    Protected = maps:from_list([{integer_to_binary(N), <<"0">>} || N <- lists:seq(1, 61)]),
    Requests = Protected#{{recoverable, <<"0">>} => <<"0">>, {recoverable, <<"1">>} => <<"1">>},
    Pair = #{generation => 1, requests => #{<<"pair">> => 1}, fenced => true},
    Game = (policy())#{
        policy_revision => <<"1">>,
        policy_requests => Requests,
        recoverable_policy_requests => #{
            {recoverable, <<"0">>} => true, {recoverable, <<"1">>} => true
        },
        pairs => #{2 => Pair},
        fenced => true
    },
    ?assertEqual(64, presence_game_activity_policy:pending_count(Game)),
    {ok, SameRevision} = presence_game_activity_policy:control(fence(<<"1">>), Game),
    ?assertEqual(63, presence_game_activity_policy:pending_count(SameRevision)),
    ?assertEqual(
        Protected, maps:with(maps:keys(Protected), maps:get(policy_requests, SameRevision))
    ),
    ?assertEqual(#{2 => Pair}, maps:get(pairs, SameRevision)),
    ?assert(maps:is_key({recoverable, <<"1">>}, maps:get(policy_requests, SameRevision))),
    ?assertNot(presence_game_activity_policy:permitted(SameRevision)).

stale_or_invalid_revision_retry_cannot_remove_guards_test() ->
    {ok, Old} = presence_game_activity_policy:control(fence(<<"0">>), policy()),
    Game = Old#{policy_revision => <<"2">>},
    State = #{
        presences => #{1 => {self(), make_ref()}},
        game_activity_pending => #{1 => Game},
        game_activity_pending_count => 1
    },
    lists:foreach(
        fun(Request) ->
            ?assertEqual({error, stale}, presence_game_activity_policy:control(Request, Game)),
            ?assertEqual(
                {reply, {error, stale}, State},
                presence_manager_shard:handle_call(
                    {game_activity_prepare, 1, policy, Request}, {self(), make_ref()}, State
                )
            )
        end,
        [fence(<<"1">>), (fence(<<"3">>))#{request_id => <<>>}, fence(<<"invalid">>)]
    ).

protected_capacity_cannot_be_replaced_by_recovery_test() ->
    Requests = maps:from_list([{integer_to_binary(N), <<"0">>} || N <- lists:seq(1, 64)]),
    Game = (policy())#{policy_requests => Requests, fenced => true},
    ?assertEqual({error, busy}, presence_game_activity_policy:control(fence(<<"1">>), Game)),
    State = #{
        presences => #{1 => {self(), make_ref()}},
        game_activity_pending => #{1 => Game},
        game_activity_pending_count => 10000
    },
    ?assertEqual(
        {reply, {error, busy}, State},
        presence_manager_shard:handle_call(
            {game_activity_prepare, 1, policy, fence(<<"1">>)}, {self(), make_ref()}, State
        )
    ).

unrelated_receiver_exit_during_grant_resolution_test() ->
    with_rollout(fun() -> subscription(pending_exit) end).

healthy_subscription_does_not_repeat_grant_rpc_test() ->
    with_rollout(fun() -> subscription(healthy) end).

unchanged_denial_does_not_repeat_grant_rpc_test() ->
    with_rollout(fun() -> subscription(denied) end).

repeated_context_race_stops_after_one_retry_test() ->
    with_rollout(fun() -> subscription(repeated_exit) end).

subscription(Mode) ->
    Parent = self(),
    OtherRef = make_ref(),
    Base = presence_game_activity_policy:track_receiver(3, Parent, policy()),
    Game = Base#{
        interests => #{Parent => #{viewer_id => 3, mref => OtherRef}},
        receiver_refs => #{OtherRef => Parent}
    },
    Owner = spawn(fun() -> owner_loop(owner(Game), Parent) end),
    meck:new(presence_manager, [non_strict, no_link]),
    meck:new(rpc_client, [non_strict, no_link]),
    meck:expect(presence_manager, lookup, fun(1) -> {ok, Owner} end),
    meck:expect(rpc_client, call, fun(Request) ->
        Parent ! {grant_pending, self()},
        receive
            continue_grant -> grant_response(Request, Mode)
        after 2000 -> error(grant_timeout)
        end
    end),
    Receiver = spawn(fun() ->
        receiver_loop(session_game_activity:subscribe(receiver()), Parent)
    end),
    try
        resolve_first_grant(Mode, OtherRef, Owner, Receiver),
        Open = Mode =:= healthy orelse Mode =:= pending_exit,
        finish_subscription(Mode, Owner, Open),
        State = gen_server:call(Owner, state),
        Interests = maps:get(interests, maps:get(game_activity_state, State)),
        case Open of
            true ->
                ?assertEqual(2, maps:get(viewer_id, maps:get(Receiver, Interests)));
            false ->
                ?assertNot(
                    maps:is_key(
                        Receiver, maps:get(grants, maps:get(game_activity_state, State))
                    )
                )
        end,
        ExpectedCalls =
            case Mode of
                healthy -> 1;
                denied -> 1;
                _ -> 2
            end,
        ?assertEqual(ExpectedCalls, meck:num_calls(rpc_client, call, '_'))
    after
        Owner ! stop,
        Receiver ! stop,
        meck:unload([presence_manager, rpc_client])
    end.

resolve_first_grant(Mode, OtherRef, Owner, Receiver) ->
    Old =
        receive
            {owner_context, Context} -> Context
        after 1000 -> error(context_timeout)
        end,
    Worker =
        receive
            {grant_pending, Pid} -> Pid
        after 1000 -> error(rpc_timeout)
        end,
    case Mode of
        healthy ->
            ok;
        denied ->
            ok;
        _ ->
            ok = gen_server:call(Owner, {receiver_down, OtherRef}),
            ?assertEqual(
                {error, denied},
                gen_server:call(Owner, {game_activity_subscribe, 2, Receiver, Old, grant(Old)})
            )
    end,
    Worker ! continue_grant.

finish_subscription(Mode, Owner, Open) ->
    receive
        {grant_pending, Worker} ->
            case Mode of
                repeated_exit -> ok = gen_server:call(Owner, invalidate_context);
                _ -> ok
            end,
            Worker ! continue_grant,
            finish_subscription(Mode, Owner, Open);
        {owner_context, _} ->
            finish_subscription(Mode, Owner, Open);
        {subscription_finished, State} ->
            ?assertEqual(Open, maps:is_key(1, maps:get(game_activity_grants, State, #{})))
    after 1500 -> error(subscription_timeout)
    end.

owner_loop(State, Parent) ->
    receive
        {'$gen_call', From, state} ->
            gen_server:reply(From, State),
            owner_loop(State, Parent);
        {'$gen_call', From, {receiver_down, Ref}} ->
            Next = presence_game_activity:receiver_down(Ref, State),
            gen_server:reply(From, ok),
            owner_loop(Next, Parent);
        {'$gen_call', From, invalidate_context} ->
            Tracked = presence_game_activity_policy:track_receiver(
                3, Parent, maps:get(game_activity_state, State)
            ),
            Next = presence_game_activity_policy:untrack_receiver(3, Parent, Tracked),
            gen_server:reply(From, ok),
            owner_loop(State#{game_activity_state => Next}, Parent);
        {'$gen_call', From, {game_activity_context, _} = Request} ->
            {reply, {ok, Context} = Reply, Next} = presence:handle_call(Request, From, State),
            Parent ! {owner_context, Context},
            gen_server:reply(From, Reply),
            owner_loop(Next, Parent);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = presence:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            owner_loop(Next, Parent);
        stop ->
            ok
    after 5000 -> error(owner_timeout)
    end.

receiver_loop(State, Parent) ->
    receive
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = session:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            receiver_loop(Next, Parent);
        {game_activity_subscribed, _} = Info ->
            {noreply, Next} = session:handle_info(Info, State),
            Parent ! {subscription_finished, Next},
            receiver_loop(Next, Parent);
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            receiver_loop(Next, Parent);
        stop ->
            ok
    after 5000 -> error(receiver_timeout)
    end.

policy() ->
    (presence_game_activity_policy:new())#{
        policy => #{
            visibility => <<"friends">>,
            eligible_16_plus => true,
            effective_profile_audience => <<"friends">>
        },
        rollout_epoch => 0,
        rollout_generation => 0
    }.

fence(Revision) ->
    #{
        phase => <<"fence">>,
        owner_epoch => null,
        policy_revision => Revision,
        recoverable => true,
        request_id => <<"retry">>
    }.

apply_request(Revision, Game) ->
    #{
        phase => <<"apply">>,
        owner_epoch => maps:get(owner_epoch, Game),
        policy_revision => Revision,
        request_id => <<"retry">>,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    }.

owner(Game) ->
    #{
        game_activity_state => Game,
        user_id => 1,
        friends => #{2 => true, 3 => true},
        sessions => #{<<"s">> => #{status => online}}
    }.

receiver() ->
    #{
        id => <<"viewer">>,
        user_id => 2,
        bot => false,
        socket_pid => self(),
        presence_pid => undefined,
        relationships => #{1 => 1},
        channels => #{},
        seq => 0,
        ack_seq => 0,
        buffer => [],
        buffer_bytes => 0,
        suppress_presence_updates => false,
        pending_presences => []
    }.

grant(Context) ->
    #{
        <<"owner_id">> => <<"1">>,
        <<"policy_revision">> => <<"0">>,
        <<"request_nonce">> => maps:get(request_nonce, Context),
        <<"allowed">> => true,
        <<"friend">> => true,
        <<"blocked">> => false,
        <<"eligible_16_plus">> => true,
        <<"profile_view">> => <<"full">>
    }.

grant_response(Request, Mode) ->
    Grant = grant(#{request_nonce => <<"rpc">>}),
    Allowed = Mode =/= denied,
    {ok, #{
        <<"request_nonce">> => maps:get(<<"request_nonce">>, Request),
        <<"grants">> => [Grant#{<<"allowed">> => Allowed}]
    }}.

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
