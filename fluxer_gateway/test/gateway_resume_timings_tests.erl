%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_resume_timings_tests).
-typing([eqwalizer]).

-include_lib("eunit/include/eunit.hrl").

handle_resume_success_dispatches_gateway_timings_test() ->
    drain_mailbox(),
    SessionPid = spawn(fun() -> fake_resume_session_loop(<<"resume-token">>, 12, true) end),
    meck:new(session_manager, [passthrough, no_link]),
    meck:new(rpc_client, [passthrough, no_link]),
    meck:expect(
        session_manager,
        lookup_or_rehydrate,
        fun(<<"session-with-timings">>, <<"resume-token">>, SocketPid) when is_pid(SocketPid) ->
            {ok, SessionPid}
        end
    ),
    meck:expect(rpc_client, call, fun(_Request) -> error(unexpected_resume_api_call) end),
    try
        State0 = maps:remove(peer_ip, new_json_state()),
        {ok, State1} = gateway_handler_identify:handle_resume(
            #{
                <<"token">> => <<"resume-token">>,
                <<"session_id">> => <<"session-with-timings">>,
                <<"seq">> => 7
            },
            State0
        ),
        ?assertEqual(SessionPid, maps:get(session_pid, State1)),
        assert_resumed_timing_dispatch(12)
    after
        SessionPid ! stop,
        meck:unload(rpc_client),
        meck:unload(session_manager)
    end.

handle_resume_omits_gateway_timings_for_non_staff_test() ->
    drain_mailbox(),
    SessionPid = spawn(fun() -> fake_resume_session_loop(<<"resume-token">>, 12, false) end),
    meck:new(session_manager, [passthrough, no_link]),
    meck:new(rpc_client, [passthrough, no_link]),
    meck:expect(
        session_manager,
        lookup_or_rehydrate,
        fun(<<"session-non-staff">>, <<"resume-token">>, SocketPid) when is_pid(SocketPid) ->
            {ok, SessionPid}
        end
    ),
    meck:expect(rpc_client, call, fun(_Request) -> error(unexpected_resume_api_call) end),
    try
        State0 = maps:remove(peer_ip, new_json_state()),
        {ok, State1} = gateway_handler_identify:handle_resume(
            #{
                <<"token">> => <<"resume-token">>,
                <<"session_id">> => <<"session-non-staff">>,
                <<"seq">> => 7
            },
            State0
        ),
        ?assertEqual(SessionPid, maps:get(session_pid, State1)),
        assert_resumed_dispatch_without_timings(12)
    after
        SessionPid ! stop,
        meck:unload(rpc_client),
        meck:unload(session_manager)
    end.

handle_resume_missing_session_sends_invalid_session_without_api_test() ->
    drain_mailbox(),
    meck:new(session_manager, [passthrough, no_link]),
    meck:expect(
        session_manager,
        lookup_or_rehydrate,
        fun(<<"missing-session">>, <<"resume-token">>, SocketPid) when is_pid(SocketPid) ->
            {error, not_found}
        end
    ),
    try
        {Frames, _State1} = gateway_handler_identify:handle_resume(
            #{
                <<"token">> => <<"resume-token">>,
                <<"session_id">> => <<"missing-session">>,
                <<"seq">> => 7
            },
            new_json_state()
        ),
        ?assertMatch([_Frame], Frames)
    after
        meck:unload(session_manager)
    end.

handle_resume_below_replay_floor_sends_invalid_session_test() ->
    drain_mailbox(),
    SessionPid = spawn(fun() -> fake_not_resumable_session_loop(<<"resume-token">>) end),
    meck:new(session_manager, [passthrough, no_link]),
    meck:expect(
        session_manager,
        lookup_or_rehydrate,
        fun(<<"evicted-session">>, <<"resume-token">>, SocketPid) when is_pid(SocketPid) ->
            {ok, SessionPid}
        end
    ),
    try
        {Frames, _State1} = gateway_handler_identify:handle_resume(
            #{
                <<"token">> => <<"resume-token">>,
                <<"session_id">> => <<"evicted-session">>,
                <<"seq">> => 7
            },
            new_json_state()
        ),
        [{text, Payload}] = Frames,
        Message = json:decode(Payload),
        ?assertEqual(constants:opcode_to_num(invalid_session), maps:get(<<"op">>, Message)),
        ?assertEqual(false, maps:get(<<"d">>, Message))
    after
        SessionPid ! stop,
        meck:unload(session_manager)
    end.

fake_not_resumable_session_loop(Token) ->
    receive
        {'$gen_call', From, {token_verify, Candidate}} ->
            gen_server:reply(From, Candidate =:= Token),
            fake_not_resumable_session_loop(Token);
        {'$gen_call', From, {resume, _Seq, SocketPid}} when is_pid(SocketPid) ->
            gen_server:reply(From, not_resumable),
            fake_not_resumable_session_loop(Token);
        stop ->
            ok
    after 30000 ->
        ok
    end.

assert_resumed_dispatch_without_timings(ExpectedSeq) ->
    assert_current_rollout_dispatch(ExpectedSeq),
    receive
        {dispatch, resumed, ResumedData, ExpectedSeq} ->
            ?assertNot(maps:is_key(<<"_timings_gw">>, ResumedData))
    after 1000 ->
        ?assert(false, resumed_not_dispatched)
    end.

assert_resumed_timing_dispatch(ExpectedSeq) ->
    assert_current_rollout_dispatch(ExpectedSeq),
    receive
        {dispatch, resumed, ResumedData, ExpectedSeq} ->
            Timings = maps:get(<<"_timings_gw">>, ResumedData),
            ?assertEqual(<<"microseconds">>, maps:get(<<"unit">>, Timings)),
            ?assert(is_binary(maps:get(<<"pod_name">>, Timings))),
            Trace = maps:get(<<"trace">>, Timings),
            TraceNames = [maps:get(<<"name">>, Span) || Span <- Trace],
            ?assert(
                lists:member(<<"gateway_handler_identify:validate_resume_data/1">>, TraceNames)
            ),
            ?assert(lists:member(<<"session_manager:lookup_or_rehydrate/3">>, TraceNames)),
            ?assert(lists:member(<<"session_lifecycle:handle_token_verify/2">>, TraceNames)),
            ?assert(lists:member(<<"session_lifecycle:handle_resume/3">>, TraceNames)),
            ?assert(
                lists:member(<<"gateway_handler_identify:replay_missed_events/2">>, TraceNames)
            ),
            ResumeSpan = find_trace_span(<<"session_lifecycle:handle_resume/3">>, Trace),
            ResumeRemote = maps:get(<<"remote">>, ResumeSpan),
            ?assertEqual(<<"session">>, maps:get(<<"operation">>, ResumeRemote)),
            ?assert(is_binary(maps:get(<<"pod_name">>, ResumeRemote)))
    after 1000 ->
        ?assert(false, resumed_not_dispatched)
    end.

fake_resume_session_loop(Token, CurrentSeq, IsStaff) ->
    receive
        {'$gen_call', From, {token_verify, Candidate}} ->
            gen_server:reply(From, Candidate =:= Token),
            fake_resume_session_loop(Token, CurrentSeq, IsStaff);
        {'$gen_call', From, {resume, _Seq, SocketPid}} when is_pid(SocketPid) ->
            gen_server:reply(From, {ok, [], CurrentSeq}),
            fake_resume_session_loop(Token, CurrentSeq, IsStaff);
        {'$gen_call', From, {is_staff}} ->
            gen_server:reply(From, IsStaff),
            fake_resume_session_loop(Token, CurrentSeq, IsStaff);
        {'$gen_cast', {game_activity_resume, SocketPid}} ->
            {noreply, _} = session:handle_cast({game_activity_resume, SocketPid}, #{
                socket_pid => SocketPid,
                game_activity_resuming => SocketPid,
                seq => CurrentSeq,
                user_id => 1,
                bot => false,
                relationships => #{},
                channels => #{}
            }),
            fake_resume_session_loop(Token, CurrentSeq, IsStaff);
        stop ->
            ok
    after 30000 ->
        ok
    end.

rollout_order_ignores_internal_session_messages_test() ->
    drain_mailbox(),
    Seq = 12,
    Data = #{
        <<"game_activity_enabled">> => gateway_rollout_config:game_activity_allowed(),
        <<"game_activity_epoch">> => maps:get(
            <<"game_activity_epoch">>, gateway_rollout_config:get(), 0
        )
    },
    self() ! {guild_connect, 9001, 0},
    self() ! {dispatch, gateway_rollout_update, Data, Seq},
    try
        assert_current_rollout_dispatch(Seq)
    after
        drain_mailbox()
    end.

rollout_order_rejects_resumed_first_test() ->
    drain_mailbox(),
    Resumed = {dispatch, resumed, #{}, 12},
    self() ! Resumed,
    try
        ?assertError(
            {expected_rollout_before_resumed, Resumed}, assert_current_rollout_dispatch(12)
        )
    after
        drain_mailbox()
    end.

rollout_order_rejects_incorrect_sequence_test() ->
    drain_mailbox(),
    WrongSequence = {dispatch, gateway_rollout_update, #{}, 13},
    self() ! WrongSequence,
    try
        ?assertError(
            {expected_rollout_before_resumed, WrongSequence},
            assert_current_rollout_dispatch(12)
        )
    after
        drain_mailbox()
    end.

assert_current_rollout_dispatch(ExpectedSeq) ->
    receive
        {dispatch, gateway_rollout_update, Data, ExpectedSeq} ->
            ?assertEqual(
                gateway_rollout_config:game_activity_allowed(),
                maps:get(<<"game_activity_enabled">>, Data)
            ),
            ?assertEqual(
                maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0),
                maps:get(<<"game_activity_epoch">>, Data)
            );
        {dispatch, _, _, _} = Other ->
            error({expected_rollout_before_resumed, Other})
    after 1000 -> ?assert(false, rollout_not_dispatched)
    end.

find_trace_span(Name, Trace) ->
    case [Span || Span <- Trace, maps:get(<<"name">>, Span, undefined) =:= Name] of
        [Span | _] -> Span;
        [] -> error({trace_span_not_found, Name})
    end.

drain_mailbox() ->
    receive
        _ -> drain_mailbox()
    after 0 ->
        ok
    end.

new_json_state() ->
    (gateway_handler:new_state())#{
        version => 1,
        encoding => json,
        compress_ctx => gateway_compress:new_context(none),
        peer_ip => <<"127.0.0.1">>
    }.
