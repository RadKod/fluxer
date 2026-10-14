%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_revocation_tests).
-include_lib("eunit/include/eunit.hrl").

healthy_150ms_revocation_ack_test() ->
    with_rollout(fun() ->
        with_receivers([150], fun(Pids, Ledger) ->
            ?assertEqual({ok, 1}, revoke_ledger(Ledger, 1000)),
            assert_receivers_closed(Pids)
        end)
    end).

pair_fence_survives_dropped_relationship_event_and_crowded_mailbox_test() ->
    with_rollout(fun() ->
        with_receivers([0], fun([Pid], Ledger) ->
            [Pid ! filler || _ <- lists:seq(1, 5001)],
            ?assertEqual({message_queue_len, 5001}, process_info(Pid, message_queue_len)),
            ok = presence_broadcast:dispatch_to_all_sessions(
                relationship_remove,
                #{<<"id">> => <<"42">>},
                #{sessions => #{<<"receiver">> => #{pid => Pid}}}
            ),
            ?assertEqual({message_queue_len, 5001}, process_info(Pid, message_queue_len)),
            ?assertEqual({ok, 1}, revoke_ledger(Ledger, 1000)),
            Closed = gen_server:call(Pid, state),
            ?assertEqual(#{42 => 1}, maps:get(relationships, Closed)),
            ?assertEqual(
                null,
                maps:get(
                    <<"game_activity">>,
                    session_game_activity:wire(presence_update, stamped_payload(), Closed)
                )
            ),
            [#{data := Replay}] = session_game_activity:replay(
                [#{seq => 1, event => presence_update, data => stamped_payload()}], Closed
            ),
            ?assertEqual(null, maps:get(<<"game_activity">>, Replay)),
            drain_dispatches(),
            session_dispatch_presence:flush_all_pending_presences(Closed#{
                pending_presences => [(entry(1))#{data => stamped_payload()}]
            }),
            {dispatch, presence_update, Pending, _} = next(),
            ?assertEqual(null, maps:get(<<"game_activity">>, Pending))
        end)
    end).

missing_revocation_ack_waits_until_deadline_test() ->
    with_rollout(fun() ->
        with_receivers([never], fun(Pids, Ledger) ->
            Started = erlang:monotonic_time(millisecond),
            ?assertEqual({error, receiver_timeout}, revoke_ledger(Ledger, 350)),
            Elapsed = erlang:monotonic_time(millisecond) - Started,
            ?assert(Elapsed >= 350),
            ?assert(Elapsed < 1500),
            assert_receivers_closed(Pids)
        end)
    end).

slow_first_hundred_still_revokes_later_receiver_test() ->
    with_rollout(fun() ->
        with_receivers(lists:duplicate(101, never), fun(Pids, Ledger) ->
            ok = gen_server:call(lists:last(lists:sort(Pids)), {delay, 0}),
            ?assertEqual({error, receiver_timeout}, revoke_ledger(Ledger, 350)),
            assert_receivers_closed(Pids)
        end)
    end).

replacement_owner_accepts_newer_persisted_policy_test() ->
    Old = policy_game(),
    {ok, _Fenced} = presence_game_activity_policy:control(
        policy_request(<<"fence">>, <<"close">>, <<"1">>, null), Old
    ),
    Replacement = policy_game(),
    Apply = policy_request(<<"apply">>, <<"close">>, <<"2">>, maps:get(owner_epoch, Old)),
    {ok, Applied} = presence_game_activity_policy:control(Apply, Replacement),
    ?assertEqual(<<"2">>, maps:get(policy_revision, Applied)),
    ?assertEqual(#{}, maps:get(candidates, Applied)),
    ?assertEqual(#{}, maps:get(grants, Applied)),
    ?assertEqual(undefined, maps:get(pending, Applied)),
    ?assertEqual(undefined, maps:get(owner, Applied)),
    Ack = presence_game_activity_policy:ack(policy, Apply, Applied),
    ?assertEqual(maps:get(owner_epoch, Replacement), maps:get(<<"owner_epoch">>, Ack)),
    ?assertNotEqual(maps:get(owner_epoch, Old), maps:get(<<"owner_epoch">>, Ack)),
    lists:foreach(
        fun(Revision) ->
            ?assertEqual(
                {error, stale},
                presence_game_activity_policy:control(
                    Apply#{policy_revision => Revision, request_id => <<"late">>}, Applied
                )
            )
        end,
        [<<"1">>, <<"2">>]
    ).

newer_apply_preserves_other_pending_fences_test() ->
    G = policy_game(),
    Epoch = maps:get(owner_epoch, G),
    {ok, First} = presence_game_activity_policy:control(
        policy_request(<<"fence">>, <<"first">>, <<"1">>, null), G
    ),
    {ok, Both} = presence_game_activity_policy:control(
        policy_request(<<"fence">>, <<"second">>, <<"1">>, null), First
    ),
    {ok, Advanced} = presence_game_activity_policy:control(
        policy_request(<<"apply">>, <<"recovered">>, <<"2">>, <<"old-owner">>), Both
    ),
    ?assertNot(presence_game_activity_policy:permitted(Advanced)),
    ?assertEqual(2, map_size(maps:get(policy_requests, Advanced))),
    {ok, OneLeft} = presence_game_activity_policy:control(
        policy_request(<<"apply">>, <<"first">>, <<"3">>, Epoch), Advanced
    ),
    ?assertNot(presence_game_activity_policy:permitted(OneLeft)),
    {ok, Settled} = presence_game_activity_policy:control(
        policy_request(<<"apply">>, <<"second">>, <<"3">>, Epoch), OneLeft
    ),
    ?assert(presence_game_activity_policy:permitted(Settled)),
    ?assertEqual(
        {error, stale},
        presence_game_activity_policy:control(
            policy_request(<<"apply">>, <<"second">>, <<"3">>, Epoch), Settled
        )
    ).

owner_and_manager_crash_before_persist_apply_test() ->
    with_rollout(fun assert_dual_crash_policy_recovery/0).

assert_dual_crash_policy_recovery() ->
    %% Micup: upstream moved the initial subscription hook into presence_broadcast_subscriptions.
    meck:new(presence_broadcast_subscriptions, [passthrough, no_link]),
    meck:expect(
        presence_broadcast_subscriptions,
        ensure_initial_global_subscriptions,
        fun(State) -> State end
    ),
    try
        {Owner, Manager} = start_policy_actors(),
        sys:replace_state(Owner, fun(State) ->
            State#{game_activity_state => policy_game()}
        end),
        Fence = policy_request(<<"fence">>, <<"close">>, <<"1">>, null),
        {ok, Ack} = gen_server:call(Owner, {game_activity_control, policy, Fence}),
        stop_policy_actors(Owner, Manager),
        assert_replacement_policy(Ack)
    after
        meck:unload(presence_broadcast_subscriptions)
    end.

assert_replacement_policy(Ack) ->
    {Replacement, NewManager} = start_policy_actors(),
    try
        Apply = policy_request(
            <<"apply">>, <<"close">>, <<"2">>, maps:get(<<"owner_epoch">>, Ack)
        ),
        {ok, AppliedAck} = gen_server:call(
            Replacement, {game_activity_control, policy, Apply#{visibility => <<"off">>}}
        ),
        ?assertNotEqual(
            maps:get(<<"owner_epoch">>, Ack), maps:get(<<"owner_epoch">>, AppliedAck)
        ),
        #{game_activity_state := Applied} = sys:get_state(Replacement),
        ?assertEqual(<<"2">>, maps:get(policy_revision, Applied)),
        ?assertNot(presence_game_activity_policy:permitted(Applied)),
        ?assertEqual(
            {error, stale},
            gen_server:call(
                Replacement,
                {game_activity_control, policy, Apply#{policy_revision => <<"1">>}}
            )
        )
    after
        stop_policy_actors(Replacement, NewManager)
    end.

start_policy_actors() ->
    {ok, Owner} = presence:start_link(#{user_id => 42, user_data => #{}, status => online}),
    unlink(Owner),
    {ok, Manager} = presence_manager_shard:start_link(0),
    unlink(Manager),
    sys:replace_state(Manager, fun(State) ->
        State#{presences => #{42 => {Owner, monitor(process, Owner)}}}
    end),
    {Owner, Manager}.

stop_policy_actors(Owner, Manager) ->
    References = [{monitor(process, Pid), Pid} || Pid <- [Manager, Owner]],
    [exit(Pid, kill) || {_Ref, Pid} <- References],
    lists:foreach(
        fun({Ref, Pid}) ->
            receive
                {'DOWN', Ref, process, Pid, _} -> ok
            after 1000 -> error(actor_did_not_stop)
            end
        end,
        References
    ).

inherited_policy_fence_settles_equal_revision_test() ->
    G = policy_game(),
    {ok, Fenced} = presence_game_activity_policy:control(
        policy_request(<<"fence">>, <<"pending">>, <<"1">>, null), G
    ),
    Epoch = maps:get(owner_epoch, G),
    Replacement = Fenced#{
        owner_epoch => <<"replacement">>,
        inherited_policy_requests => #{<<"pending">> => Epoch}
    },
    Request = policy_request(<<"apply">>, <<"pending">>, <<"1">>, Epoch),
    ?assertEqual(
        {error, stale},
        presence_game_activity_policy:control(
            Request#{owner_epoch => <<"unrelated">>}, Replacement
        )
    ),
    {ok, Applied} = presence_game_activity_policy:control(Request, Replacement),
    ?assert(presence_game_activity_policy:permitted(Applied)),
    ?assertEqual(#{}, maps:get(inherited_policy_requests, Applied)).

inherited_pair_fence_requires_original_epoch_and_generation_test() ->
    G = presence_game_activity_policy:new(),
    Epoch = maps:get(owner_epoch, G),
    Fence = #{viewer_id => 7, phase => <<"fence">>, request_id => <<"pair">>},
    {ok, Fenced} = presence_game_activity_policy:pair_control(Fence, G),
    Pair = maps:get(7, maps:get(pairs, Fenced)),
    Replacement = Fenced#{
        owner_epoch => <<"replacement">>,
        pairs => #{7 => Pair#{inherited_requests => #{<<"pair">> => Epoch}}}
    },
    Apply = Fence#{phase => <<"apply">>, owner_epoch => Epoch, pair_generation => <<"1">>},
    lists:foreach(
        fun(Bad) ->
            ?assertEqual(
                {error, stale}, presence_game_activity_policy:pair_control(Bad, Replacement)
            )
        end,
        [Apply#{owner_epoch => <<"unrelated">>}, Apply#{pair_generation => <<"2">>}]
    ),
    {ok, Applied} = presence_game_activity_policy:pair_control(Apply, Replacement),
    ?assertNot(maps:is_key(7, maps:get(pairs, Applied))).

policy_game() ->
    (presence_game_activity_policy:new())#{
        policy_revision => <<"1">>,
        policy => policy_request(<<"apply">>, <<"initial">>, <<"1">>, null),
        candidates => #{<<"session">> => #{}},
        grants => #{7 => #{}},
        pending => old,
        owner => <<"session">>
    }.

policy_request(Phase, Id, Revision, Epoch) ->
    #{
        phase => Phase,
        request_id => Id,
        policy_revision => Revision,
        owner_epoch => Epoch,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"close">>
    }.

with_receivers(Delays, Fun) ->
    ReceiverState = permitted(),
    Pids = [spawn(fun() -> ack_receiver(Delay, ReceiverState) end) || Delay <- Delays],
    Ledger = maps:from_list([{Pid, #{viewer_id => 7, stamp => stamp()}} || Pid <- Pids]),
    try
        Fun(Pids, Ledger)
    after
        [Pid ! stop || Pid <- Pids],
        drain_dispatches()
    end.

revoke_ledger(Ledger, Timeout) ->
    Game = (presence_game_activity_policy:new())#{
        owner_epoch => <<"epoch">>,
        policy_revision => <<"1">>,
        pairs => #{7 => #{generation => 1}}
    },
    presence_game_activity_policy:revoke(
        {all, maps:iterator(Ledger, ordered)},
        #{user_id => 42, game_activity_state => Game},
        erlang:monotonic_time(millisecond) + Timeout
    ).

assert_receivers_closed(Pids) ->
    lists:foreach(
        fun(Pid) ->
            ?assertEqual(#{}, gen_server:call(Pid, grants))
        end,
        Pids
    ).

ack_receiver(Delay, State) ->
    receive
        {'$gen_cast', {game_activity_fence, Owner, Stamp}} ->
            {reply, {ok, _}, Next} = session_game_activity:fence(Owner, Stamp, State),
            ack_receiver(Delay, Next);
        {'$gen_call', From, {game_activity_fence, Owner, Stamp}} ->
            {reply, {ok, _}, Next} = session_game_activity:fence(Owner, Stamp, State),
            case Delay of
                never -> ok;
                _ -> erlang:send_after(Delay, self(), {ack, From, Stamp})
            end,
            ack_receiver(Delay, Next);
        {ack, From, Stamp} ->
            gen_server:reply(From, {ok, Stamp}),
            ack_receiver(Delay, State);
        {'$gen_call', From, grants} ->
            gen_server:reply(From, maps:get(game_activity_grants, State)),
            ack_receiver(Delay, State);
        {'$gen_call', From, state} ->
            gen_server:reply(From, State),
            ack_receiver(Delay, State);
        {'$gen_call', From, {delay, NewDelay}} ->
            gen_server:reply(From, ok),
            ack_receiver(NewDelay, State);
        stop ->
            ok
    after 10000 -> error(receiver_idle_timeout)
    end.

pending_flush_rechecks_grant_test() ->
    State = state(#{pending_presences => [entry(1)]}),
    session_dispatch_presence:flush_all_pending_presences(State),
    {dispatch, presence_update, Data, 1} = next(),
    ?assertEqual(null, maps:get(<<"game_activity">>, Data)),
    ?assertEqual(<<"online">>, maps:get(<<"status">>, Data)).

next_entry() ->
    {dispatch, Event, Data, Seq} = next(),
    #{event => Event, data => Data, seq => Seq}.

repeated_rollout_keeps_cleanup_barrier_test() ->
    with_rollout(fun() ->
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> false end),
        Grants = maps:from_list([{Id, stamp()} || Id <- lists:seq(1001, 1101)]),
        Cleaning = session_game_activity:rollout(state(#{game_activity_grants => Grants})),
        ?assert(maps:get(game_activity_cleaning, Cleaning)),
        ?assertEqual(Cleaning, session_game_activity:rollout(Cleaning)),
        ?assertMatch(
            {reply, {error, rollout_closed}, _},
            session_game_activity:grant(42, stamp(), Cleaning)
        ),
        [next() || _ <- lists:seq(1, 100)],
        receive
            {game_activity_cleanup, Iterator} ->
                Finished = session_game_activity:cleanup(Iterator, Cleaning),
                ?assertNot(maps:is_key(game_activity_cleaning, Finished))
        after 1000 -> error(missing_cleanup)
        end,
        {dispatch, presence_update, Data, 101} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Data))
    end).

replay_both_branches_keep_sequence_test() ->
    lists:foreach(
        fun(N) ->
            Entries = [entry(I) || I <- lists:seq(1, N)],
            {reply, {ok, Reply, N}, _} = session_lifecycle:handle_resume(
                0, self(), state(#{seq => N, buffer => Entries})
            ),
            Actual =
                case Reply of
                    [] ->
                        [next_entry() || _ <- Entries];
                    _ ->
                        Reply
                end,
            ?assertEqual(lists:seq(1, N), [maps:get(seq, E) || E <- Actual]),
            lists:foreach(
                fun(#{data := D}) ->
                    ?assertEqual(null, maps:get(<<"game_activity">>, D)),
                    ?assertEqual(<<"online">>, maps:get(<<"status">>, D))
                end,
                Actual
            )
        end,
        [1, 257]
    ).

off_then_delayed_game_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        {noreply, Sent} = session_game_activity:deliver(42, activity(), stamp(), Open),
        {dispatch, presence_update, First, 1} = next(),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, First)),
        ?assertNot(maps:is_key(game_activity_stamp, First)),
        {reply, {ok, _}, Closed} = session_game_activity:fence(42, stamp(), Sent),
        {dispatch, presence_update, Clear, 2} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Clear)),
        session_game_activity:deliver(42, activity(), stamp(), Closed),
        {dispatch, presence_update, Late, 3} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Late))
    end).

delayed_snapshot_after_fence_test() ->
    with_rollout(fun() ->
        {reply, ok, Expected} = session_game_activity:expect(42, stamp(), state(#{})),
        {reply, {ok, _}, Closed} = session_game_activity:fence(42, stamp(), Expected),
        next(),
        ?assertMatch(
            {reply, {error, fenced}, _}, session_game_activity:expect(42, stamp(), Closed)
        ),
        ?assertMatch(
            {reply, {error, unknown_owner}, _}, session_game_activity:grant(42, stamp(), Closed)
        )
    end).

unfriend_with_gdm_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        GroupDm = #{<<"type">> => 3, <<"recipient_ids">> => [42]},
        Closed = Open#{relationships => #{}, channels => #{99 => GroupDm}},
        session_dispatch_presence:dispatch_presence_now(
            #{event => presence_update, data => stamped_payload()}, Closed
        ),
        {dispatch, presence_update, Safe, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Safe))
    end).

both_direction_block_resume_test() ->
    with_rollout(fun() ->
        lists:foreach(
            fun(Relationships) ->
                Open = permitted(),
                Closed = Open#{
                    relationships => Relationships,
                    seq => 1,
                    buffer => [#{event => presence_update, seq => 1, data => stamped_payload()}]
                },
                {reply, {ok, [], 1}, _} = session_lifecycle:handle_resume(0, self(), Closed),
                {dispatch, presence_update, Safe, 1} = next(),
                ?assertEqual(null, maps:get(<<"game_activity">>, Safe))
            end,
            [#{42 => 2}, #{}]
        )
    end).

apply_ack_waits_for_receiver_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        {reply, {ok, Stamp}, Closed} = session:handle_call(
            {game_activity_fence, 42, stamp()}, {self(), make_ref()}, Open
        ),
        ?assertEqual(stamp(), Stamp),
        ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
        {dispatch, presence_update, Data, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Data))
    end).

unknown_new_owner_denies_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        NewStamp = (stamp())#{owner_epoch => <<"new">>},
        ?assertMatch(
            {reply, {error, unknown_owner}, _}, session_game_activity:grant(42, NewStamp, Open)
        ),
        Data = (payload())#{game_activity_stamp => NewStamp},
        ?assertEqual(
            null,
            maps:get(
                <<"game_activity">>, session_game_activity:wire(presence_update, Data, Open)
            )
        )
    end).

ready_rechecks_and_strips_stamp_test() ->
    with_rollout(fun() ->
        Data = #{<<"presences">> => [stamped_payload()]},
        session_ready_dispatch:dispatch_event(ready, Data, permitted()),
        {dispatch, ready, #{<<"presences">> := [Visible]}, 1} = next(),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, Visible)),
        ?assertNot(maps:is_key(game_activity_stamp, Visible)),
        session_ready_dispatch:dispatch_event(ready, Data, state(#{})),
        {dispatch, ready, #{<<"presences">> := [Denied]}, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Denied))
    end).

rollout_generation_cannot_revive_old_grant_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 2 end),
        ?assertEqual(
            null,
            maps:get(
                <<"game_activity">>,
                session_game_activity:wire(presence_update, stamped_payload(), Open)
            )
        )
    end).

regrant_cannot_revive_old_nonce_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        {reply, {ok, _}, Closed} = session_game_activity:fence(42, stamp(), Open),
        next(),
        FreshStamp = (stamp())#{request_nonce => <<"fresh">>},
        {reply, ok, Expected} = session_game_activity:expect(42, FreshStamp, Closed),
        {reply, {ok, _}, Reopened} = session_game_activity:grant(42, FreshStamp, Expected),
        session_dispatch_presence:dispatch_presence_now(
            #{event => presence_update, data => stamped_payload()}, Reopened
        ),
        {dispatch, presence_update, Data, 2} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Data))
    end).

receiver_rollout_cleanup_queues_null_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> false end),
        {noreply, Closed} = session:handle_cast(game_activity_rollout_changed, Open),
        ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
        {dispatch, presence_update, Data, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Data)),
        {dispatch, gateway_rollout_update, Rollout, 2} = next(),
        ?assertEqual(false, maps:get(<<"game_activity_enabled">>, Rollout))
    end).

null_revision_rejects_delayed_activity_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        NewStamp = (stamp())#{activity_revision => 2},
        {noreply, Cleared} = session_game_activity:deliver(42, null, NewStamp, Open),
        {dispatch, presence_update, _, 1} = next(),
        {noreply, Unchanged} = session_game_activity:deliver(42, activity(), stamp(), Cleared),
        ?assertEqual(1, maps:get(seq, Unchanged)),
        [#{seq := 19, data := Safe}] = session_game_activity:replay(
            [#{seq => 19, event => presence_update, data => stamped_payload()}], Cleared
        ),
        ?assertEqual(null, maps:get(<<"game_activity">>, Safe))
    end).

cleared_activity_is_redacted_before_resume_socket_test() ->
    with_rollout(fun() ->
        {noreply, Started} = session_game_activity:deliver(
            42, activity(), stamp(), permitted()
        ),
        next(),
        {noreply, Cleared} = session_game_activity:deliver(
            42, null, (stamp())#{activity_revision => 2}, Started
        ),
        next(),
        {reply, {ok, [], 2}, _} = session_lifecycle:handle_resume(0, self(), Cleared),
        {dispatch, presence_update, First, 1} = next(),
        {dispatch, presence_update, Second, 2} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, First)),
        ?assertEqual(null, maps:get(<<"game_activity">>, Second))
    end).

stamp() ->
    #{
        owner_pid => self(),
        owner_epoch => <<"epoch">>,
        policy_revision => 1,
        pair_generation => 1,
        activity_revision => 1,
        rollout_epoch => 1,
        request_nonce => <<"nonce">>,
        allowed => true
    }.
activity() -> maps:get(<<"game_activity">>, payload()).
stamped_payload() -> (payload())#{game_activity_stamp => stamp()}.
permitted() ->
    {reply, ok, Expected} = session_game_activity:expect(42, stamp(), state(#{})),
    {reply, {ok, _}, Open} = session_game_activity:grant(42, stamp(), Expected),
    Open.
with_rollout(Fun) ->
    meck:new(gateway_rollout_config, [non_strict, no_link]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 1} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 1 end),
    try
        Fun()
    after
        meck:unload(gateway_rollout_config)
    end.

entry(Seq) -> #{event => presence_update, seq => Seq, user_id => 42, data => payload()}.
payload() ->
    #{
        <<"user">> => #{<<"id">> => <<"42">>},
        <<"status">> => <<"online">>,
        <<"game_activity">> => #{<<"game_id">> => <<"game">>, <<"started_at">> => 1}
    }.
state(Extra) ->
    maps:merge(
        #{
            id => <<"s">>,
            user_id => 7,
            bot => false,
            seq => 0,
            ack_seq => 0,
            buffer => [],
            buffer_bytes => 0,
            status => online,
            afk => false,
            mobile => false,
            socket_pid => self(),
            presence_pid => self(),
            presence_mref => undefined,
            socket_mref => undefined,
            resume_timer => undefined,
            offline_timer => undefined,
            relationships => #{42 => 1},
            channels => #{},
            suppress_presence_updates => false,
            pending_presences => []
        },
        Extra
    ).
next() ->
    receive
        {dispatch, _, _, _} = M -> M
    after 1000 -> error(missing_dispatch)
    end.

dead_owner_denies_queued_game_test() ->
    with_rollout(fun() ->
        Owner = spawn(fun wait_for_stop/0),
        Stamp = (stamp())#{owner_pid => Owner},
        {reply, ok, Expected} = session_game_activity:expect(42, Stamp, state(#{})),
        {reply, {ok, _}, Open} = session_game_activity:grant(42, Stamp, Expected),
        Ref = monitor(process, Owner),
        Owner ! stop,
        receive
            {'DOWN', Ref, process, Owner, _} -> ok
        after 1000 -> error(owner_alive)
        end,
        session_game_activity:deliver(42, activity(), Stamp, Open),
        {dispatch, presence_update, Data, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Data))
    end).

missing_owner_liveness_denies_test() ->
    with_rollout(fun() ->
        Stamp = maps:remove(owner_pid, stamp()),
        Result = session_game_activity:expect(42, Stamp, state(#{})),
        ?assertMatch({reply, {error, _}, _}, Result)
    end).

applied_nonce_survives_old_barrier_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        Applied = (stamp())#{request_nonce => <<"applied">>, policy_revision => 2},
        {reply, {ok, _}, Closed} = session_game_activity:fence(42, Applied, Open),
        next(),
        ?assertMatch({reply, ok, _}, session_game_activity:expect(42, Applied, Closed))
    end).

stale_fence_preserves_new_owner_test() ->
    with_rollout(fun() ->
        New = (stamp())#{owner_epoch => <<"new-owner">>, request_nonce => <<"new-nonce">>},
        {reply, ok, Expected} = session_game_activity:expect(42, New, state(#{})),
        {reply, {ok, _}, Open} = session_game_activity:grant(42, New, Expected),
        {reply, {ok, _}, After} = session_game_activity:fence(42, stamp(), Open),
        ?assertEqual(
            maps:get(game_activity_grants, Open), maps:get(game_activity_grants, After)
        ),
        ?assertEqual(0, maps:get(seq, After))
    end).

socket_down_clears_only_own_producer_test() ->
    SocketRef = make_ref(),
    {noreply, Disconnected} = session:handle_info(
        {'DOWN', SocketRef, process, self(), closed}, state(#{socket_mref => SocketRef})
    ),
    {_, ResumeTimer} = maps:get(resume_timer, Disconnected),
    {_, OfflineTimer} = maps:get(offline_timer, Disconnected),
    erlang:cancel_timer(ResumeTimer),
    erlang:cancel_timer(OfflineTimer),
    Clear =
        receive
            {'$gen_cast', {game_activity_clear, Sid}} -> Sid
        after 100 -> missing
        end,
    ?assertEqual(<<"s">>, Clear),
    ?assertEqual(online, maps:get(status, Disconnected)).

owner_down_queues_null_and_closes_buffers_test() ->
    with_rollout(fun() ->
        Owner = spawn(fun wait_for_stop/0),
        Stamp = (stamp())#{owner_pid => Owner},
        {reply, ok, Expected} = session_game_activity:expect(42, Stamp, state(#{})),
        {reply, {ok, _}, Open} = session_game_activity:grant(42, Stamp, Expected),
        #{42 := #{owner_mref := Ref}} = maps:get(game_activity_owners, Open),
        Owner ! stop,
        receive
            {'DOWN', Ref, process, Owner, Reason} ->
                {noreply, Closed} = session:handle_info(
                    {'DOWN', Ref, process, Owner, Reason}, Open
                ),
                ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
                {dispatch, presence_update, Clear, 1} = next(),
                ?assertEqual(null, maps:get(<<"game_activity">>, Clear)),
                Data = (payload())#{game_activity_stamp => Stamp},
                session_dispatch_presence:dispatch_presence_now(
                    #{event => presence_update, data => Data}, Closed
                ),
                {dispatch, presence_update, Late, 2} = next(),
                ?assertEqual(null, maps:get(<<"game_activity">>, Late))
        after 1000 -> error(missing_owner_down)
        end
    end).

delayed_revoked_context_does_not_clear_fresh_grant_test() ->
    with_rollout(fun() ->
        Fresh = (stamp())#{request_nonce => <<"fresh-apply">>},
        {reply, ok, Expected} = session_game_activity:expect(42, Fresh, state(#{})),
        {reply, {ok, _}, Open} = session_game_activity:grant(42, Fresh, Expected),
        Fence = Fresh#{revoked_context => stamp()},
        {reply, {ok, Fence}, After} = session_game_activity:fence(42, Fence, Open),
        ?assertEqual(Open, After)
    end).

friend_online_refreshes_once_without_game_rpc_test() ->
    with_rollout(fun check_friend_online_refresh/0).

check_friend_online_refresh() ->
    Parent = self(),
    Owner = spawn(fun() -> resolver_owner(Parent) end),
    ReceiverState = state(#{presence_pid => undefined}),
    Receiver = spawn(fun() -> resolver_receiver(ReceiverState) end),
    meck:new(presence_manager, [non_strict, no_link]),
    meck:new(rpc_client, [non_strict, no_link]),
    meck:expect(presence_manager, lookup, fun(42) -> {ok, Owner} end),
    meck:expect(rpc_client, call, fun(Request) ->
        {ok, #{
            <<"request_nonce">> => maps:get(<<"request_nonce">>, Request),
            <<"grants">> => [#{<<"owner_id">> => <<"42">>}]
        }}
    end),
    try
        Base = maps:remove(<<"game_activity">>, payload()),
        gen_server:cast(
            Receiver, {dispatch, presence_update, Base#{<<"status">> => <<"offline">>}}
        ),
        gen_server:cast(Receiver, {dispatch, presence_update, Base}),
        receive
            {resolved, Stamp} ->
                gen_server:cast(Receiver, {dispatch, presence_update, Base}),
                gen_server:cast(
                    Receiver, {dispatch, presence_update, Base#{<<"status">> => <<"idle">>}}
                ),
                gen_server:cast(Receiver, {game_activity, 42, activity(), Stamp}),
                ok = gen_server:call(Receiver, test_barrier),
                ?assertEqual(1, meck:num_calls(rpc_client, call, '_'))
        after 2000 -> error(missing_resolution)
        end
    after
        Receiver ! stop,
        Owner ! stop,
        meck:unload(presence_manager),
        meck:unload(rpc_client),
        drain_dispatches()
    end.

resolver_owner(Parent) ->
    receive
        {'$gen_call', From, {game_activity_context, _Viewer}} ->
            gen_server:reply(From, {ok, stamp()}),
            resolver_owner(Parent);
        {'$gen_call', From, {game_activity_subscribe, _Viewer, Receiver, _Context, _Grant}} ->
            Stamp = stamp(),
            {ok, Stamp} = gen_server:call(Receiver, {game_activity_grant, 42, Stamp}),
            gen_server:reply(From, {ok, Stamp}),
            Parent ! {resolved, Stamp},
            resolver_owner(Parent);
        stop ->
            ok
    after 5000 -> ok
    end.

resolver_receiver(State) ->
    receive
        {'$gen_call', From, test_barrier} ->
            gen_server:reply(From, ok),
            resolver_receiver(State);
        {'$gen_call', From, Request} ->
            {reply, Reply, Next} = session:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            resolver_receiver(Next);
        {'$gen_cast', Request} ->
            {noreply, Next} = session:handle_cast(Request, State),
            resolver_receiver(Next);
        stop ->
            ok;
        Info ->
            {noreply, Next} = session:handle_info(Info, State),
            resolver_receiver(Next)
    after 5000 -> ok
    end.

drain_dispatches() ->
    receive
        {dispatch, _, _, _} -> drain_dispatches()
    after 0 -> ok
    end.

wait_for_stop() ->
    receive
        stop -> ok
    after 5000 -> ok
    end.

fresh_expectation_survives_old_grant_fence_test() ->
    with_rollout(fun() ->
        Open = permitted(),
        Fresh = (stamp())#{request_nonce => <<"applied-fresh">>},
        {reply, ok, Expected} = session_game_activity:expect(42, Fresh, Open),
        Fence = Fresh#{revoked_context => stamp()},
        {noreply, Closed} = session:handle_cast({game_activity_fence, 42, Fence}, Expected),
        next(),
        {reply, {ok, Fence}, Same} = session_game_activity:fence(42, Fence, Closed),
        ?assertEqual(Closed, Same),
        ?assertMatch({reply, {ok, Fresh}, _}, session_game_activity:grant(42, Fresh, Closed))
    end).

replacement_context_clears_previous_owner_before_grant_test() ->
    with_rollout(fun() ->
        Owner = spawn(fun wait_for_stop/0),
        NewContext = (stamp())#{owner_epoch => <<"replacement">>, owner_pid => Owner},
        {reply, ok, Closed} = session_game_activity:expect(42, NewContext, permitted()),
        ?assertEqual(#{}, maps:get(game_activity_grants, Closed)),
        {dispatch, presence_update, Clear, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Clear)),
        Owner ! stop
    end).
