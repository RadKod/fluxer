%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_resume_contract_tests).
-include_lib("eunit/include/eunit.hrl").

%% Keep unrelated dispatches from earlier tests out of the socket mailbox.
resume_authority_precedes_immediate_fresh_game_test_() ->
    {spawn, fun() -> assert_resume_delivery_order(0) end}.

fallback_replay_finishes_before_immediate_fresh_game_test_() ->
    {spawn, fun() -> assert_resume_delivery_order(257) end}.

inline_resume_never_emits_guild_game_before_processed_null_test_() ->
    {spawn, fun() -> assert_guild_null_resume(2) end}.

finalize_resume_never_emits_guild_game_before_processed_null_test_() ->
    {spawn, fun() -> assert_guild_null_resume(257) end}.

old_socket_completion_cannot_start_game_subscription_test() ->
    State = session_state(0),
    meck:new(session_game_activity, [passthrough, no_link]),
    meck:expect(session_game_activity, subscribe, fun(_) -> error(stale_socket_subscribed) end),
    try
        ?assertEqual(
            {noreply, State}, session:handle_cast({game_activity_resume, self()}, State)
        ),
        ?assertEqual(0, meck:num_calls(session_game_activity, subscribe, '_'))
    after
        meck:unload(session_game_activity)
    end.

resume_rejects_preexisting_subscriber_until_replay_completion_test() ->
    set_authority(),
    {reply, {ok, [], 0}, Pending} = session_lifecycle:handle_resume(
        0, self(), session_state(0)
    ),
    ?assertMatch(
        {reply, {error, rollout_closed}, _},
        session_game_activity:expect(42, stamp(), Pending)
    ),
    ?assertEqual(Pending, session_game_activity:refresh(42, Pending)).

assert_guild_null_resume(Backlog) ->
    set_authority(),
    Base = (session_state(0))#{relationships => #{}, guilds => #{50 => {self(), make_ref()}}},
    Data = #{
        <<"user">> => #{<<"id">> => <<"42">>},
        <<"guild_id">> => <<"50">>,
        <<"game_activity">> => activity(),
        game_activity_stamp => #{
            scope => guild,
            owner_epoch => <<"owner">>,
            activity_revision => 1,
            rollout_epoch => 0
        }
    },
    {noreply, Seen} = session_dispatch:handle_dispatch(presence_update, Data, Base),
    {noreply, Cleared} = session_dispatch:handle_dispatch(
        presence_update, Data#{<<"game_activity">> => null}, Seen
    ),
    Padding = [
        #{event => message_create, seq => I, data => #{<<"id">> => I}}
     || I <- lists:seq(3, Backlog)
    ],
    Buffer = limited_deque:to_list(maps:get(buffer, Cleared)) ++ Padding,
    State = Cleared#{seq => Backlog, buffer => Buffer},
    {Session, Ref} = spawn_monitor(fun() -> resume_session(State) end),
    meck:new(session_manager, [passthrough, no_link]),
    meck:new(session_game_activity, [passthrough, no_link]),
    meck:expect(session_manager, lookup_or_rehydrate, fun(_, _, _) -> {ok, Session} end),
    meck:expect(session_game_activity, subscribe, fun(S) -> S end),
    try
        {ok, _} = gateway_handler_resume:handle_resume(
            #{<<"token">> => <<"token">>, <<"session_id">> => <<"resume">>, <<"seq">> => 0},
            maps:remove(peer_ip, gateway_handler:new_state())
        ),
        {Replay, Tail} = lists:split(Backlog, receive_until_resumed([])),
        ?assertEqual(lists:seq(1, Backlog), [Seq || {dispatch, _, _, Seq} <- Replay]),
        ?assertEqual([null], [
            Game
         || {dispatch, presence_update, #{<<"game_activity">> := Game}, _} <- Replay
        ]),
        ?assertMatch(
            [
                {dispatch, gateway_rollout_update, _, Backlog}, {dispatch, resumed, _, Backlog}
            ],
            Tail
        )
    after
        Session ! stop,
        receive
            {'DOWN', Ref, process, Session, _} -> ok
        after 1000 -> error(session_not_stopped)
        end,
        meck:unload([session_manager, session_game_activity])
    end.

assert_resume_delivery_order(Backlog) ->
    set_authority(),
    Session = spawn(fun() -> resume_session(session_state(Backlog)) end),
    meck:new(session_manager, [passthrough, no_link]),
    meck:new(session_game_activity, [passthrough, no_link]),
    meck:expect(session_manager, lookup_or_rehydrate, fun(_, _, _) -> {ok, Session} end),
    meck:expect(session_game_activity, subscribe, fun emit_fresh_game/1),
    try
        {ok, _} = gateway_handler_resume:handle_resume(
            #{<<"token">> => <<"token">>, <<"session_id">> => <<"resume">>, <<"seq">> => 0},
            maps:remove(peer_ip, gateway_handler:new_state())
        ),
        Dispatches = receive_until_resumed([]),
        assert_dispatch_order(Backlog, Dispatches)
    after
        Session ! stop,
        meck:unload([session_manager, session_game_activity])
    end.

emit_fresh_game(State) ->
    Stamp = stamp(),
    {reply, ok, Expected} = session_game_activity:expect(42, Stamp, State),
    {reply, {ok, _}, Granted} = session_game_activity:grant(42, Stamp, Expected),
    {noreply, Delivered} = session_game_activity:deliver(42, activity(), Stamp, Granted),
    Delivered.

assert_dispatch_order(Backlog, Dispatches) ->
    {Replay, Tail} = lists:split(Backlog, Dispatches),
    ?assertEqual(lists:seq(1, Backlog), [Seq || {dispatch, presence_update, _, Seq} <- Replay]),
    lists:foreach(
        fun({dispatch, presence_update, Data, _}) ->
            ?assertEqual(null, maps:get(<<"game_activity">>, Data))
        end,
        Replay
    ),
    ?assertMatch(
        [
            {dispatch, gateway_rollout_update, #{<<"game_activity_enabled">> := true}, Backlog},
            {dispatch, presence_update, #{<<"game_activity">> := _}, _},
            {dispatch, resumed, _, Backlog}
        ],
        Tail
    ),
    [_, {dispatch, presence_update, Fresh, FreshSeq}, _] = Tail,
    ?assertEqual(Backlog + 1, FreshSeq),
    ?assertEqual(activity(), maps:get(<<"game_activity">>, Fresh)).

resume_session(State) ->
    receive
        {'$gen_call', From, {token_verify, _}} ->
            gen_server:reply(From, true),
            resume_session(State);
        {'$gen_call', From, {is_staff}} ->
            gen_server:reply(From, false),
            resume_session(State);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = session:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            resume_session(Next);
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            resume_session(Next);
        stop ->
            ok
    after 5000 -> ok
    end.

receive_until_resumed(Acc) ->
    receive
        {dispatch, resumed, _, _} = Dispatch -> lists:reverse([Dispatch | Acc]);
        {dispatch, _, _, _} = Dispatch -> receive_until_resumed([Dispatch | Acc])
    after 1000 -> error(missing_resumed)
    end.

session_state(Backlog) ->
    Data = #{
        <<"user">> => #{<<"id">> => <<"42">>},
        <<"game_activity">> => activity(),
        game_activity_stamp => stamp()
    },
    #{
        id => <<"resume">>,
        user_id => 7,
        bot => false,
        seq => Backlog,
        ack_seq => 0,
        buffer => [
            #{event => presence_update, data => Data, seq => Seq}
         || Seq <- lists:seq(1, Backlog)
        ],
        buffer_bytes => 0,
        status => online,
        afk => false,
        mobile => false,
        socket_pid => undefined,
        socket_mref => undefined,
        presence_pid => self(),
        presence_mref => undefined,
        resume_timer => undefined,
        offline_timer => undefined,
        relationships => #{42 => 1},
        channels => #{},
        suppress_presence_updates => false,
        pending_presences => []
    }.

stamp() ->
    #{
        owner_pid => self(),
        owner_epoch => <<"owner">>,
        policy_revision => 1,
        pair_generation => 1,
        request_nonce => <<"fresh">>,
        rollout_epoch => 0,
        activity_revision => 1,
        allowed => true
    }.

activity() -> #{<<"game_id">> => <<"game">>, <<"started_at">> => 1}.

set_authority() ->
    persistent_term:put(
        gateway_rollout_config,
        #{<<"game_activity_enabled">> => true, <<"game_activity_epoch">> => 0}
    ),
    persistent_term:put(
        {gateway_rollout_config, game_activity_gate},
        #{epoch => 0, generation => 0, validated_at => erlang:monotonic_time(millisecond)}
    ).
