%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_game_activity_tests).

-include_lib("eunit/include/eunit.hrl").

-define(GUILD_ID, 42).
-define(VIEW_ROLE, 1000).
-define(OTHER_ROLE, 2000).
-define(OWNER, 20).
-define(EPOCH, 7).
-define(DM_FLAG, dm_presence_mutual_context).
-define(ROLLOUT_KEY, gateway_rollout_config).
-define(GATE_KEY, {gateway_rollout_config, game_activity_gate}).

null_snapshot_without_broadcaster_preserves_state_test() ->
    Receiver = spawn(fun idle/0),
    State = #{id => ?GUILD_ID},
    Snapshot = (guild_game_activity:snapshot_fields(?OWNER, #{}, State))#{
        <<"status">> => <<"online">>
    },
    try
        Result = guild_game_activity:send_snapshot(Receiver, Snapshot, State),
        ?assertEqual(
            {messages, [{'$gen_cast', {dispatch, presence_update, Snapshot}}]},
            process_info(Receiver, messages)
        ),
        ?assertEqual(State, Result)
    after
        exit(Receiver, kill)
    end.

full_snapshot_starts_broadcaster_test() ->
    Receiver = spawn(fun idle/0),
    Snapshot = #{<<"game_activity">> => activity(<<"a">>)},
    try
        State = guild_game_activity:send_snapshot(Receiver, Snapshot, #{id => ?GUILD_ID}),
        B = maps:get(broadcaster_pid, State),
        try
            _ = sys:get_state(B),
            ?assertEqual(
                {messages, [{'$gen_cast', {dispatch, presence_update, Snapshot}}]},
                process_info(Receiver, messages)
            )
        after
            gen_server:stop(B)
        end
    after
        exit(Receiver, kill)
    end.

null_snapshot_uses_existing_ordered_channel_test() ->
    {ok, B} = guild_broadcaster:start_link(?GUILD_ID),
    Receiver = spawn(fun idle/0),
    State = #{id => ?GUILD_ID, broadcaster_pid => B},
    Full = #{<<"game_activity">> => activity(<<"a">>)},
    Null = #{<<"game_activity">> => null},
    ok = sys:suspend(B),
    try
        ?assertEqual(State, guild_game_activity:send_snapshot(Receiver, Full, State)),
        ?assertEqual(State, guild_game_activity:send_snapshot(Receiver, Null, State)),
        ?assertEqual({messages, []}, process_info(Receiver, messages)),
        ok = sys:resume(B),
        _ = sys:get_state(B),
        {messages, Delivered} = process_info(Receiver, messages),
        ?assertEqual(
            [
                {'$gen_cast', {dispatch, presence_update, Full}},
                {'$gen_cast', {dispatch, presence_update, Null}}
            ],
            Delivered
        )
    after
        _ = sys:resume(B),
        gen_server:stop(B),
        exit(Receiver, kill)
    end.

t5_revoke_and_exclude_wait_for_broadcaster_test() ->
    lists:foreach(
        fun(Request) ->
            with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
                {ok, B} = guild_broadcaster:start_link(?GUILD_ID),
                ok = sys:suspend(B),
                try
                    S1 = publish(
                        Base#{broadcaster_pid => B}, Owner, activity(<<"a">>), stamp(1), #{}
                    ),
                    Tag = make_ref(),
                    ?assertMatch({noreply, _}, guild:handle_call(Request, {self(), Tag}, S1)),
                    receive
                        {Tag, _} -> ?assert(false)
                    after 0 -> ok
                    end,
                    ok = sys:resume(B),
                    receive
                        {Tag, ok} -> ok
                    after 1000 -> ?assert(false)
                    end,
                    {messages, Delivered} = process_info(pid(10, Ctx), messages),
                    ?assertEqual([activity(<<"a">>), null], [
                        maps:get(<<"game_activity">>, P)
                     || {'$gen_cast', {dispatch, presence_update, P}} <- Delivered
                    ]),
                    {messages, Pending} = process_info(B, messages),
                    ?assertEqual([], [
                        P
                     || {'$gen_cast', {event_broadcast, presence_update, P, _}} <- Pending
                    ])
                after
                    _ = sys:resume(B),
                    gen_server:stop(B)
                end
            end)
        end,
        [{game_activity_revoke, ?OWNER, <<"epoch-1">>}, {game_activity_exclude, ?OWNER, 10}]
    ).

t5_full_updates_and_snapshots_shed_at_queue_limit_test() ->
    with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
        {ok, B} = guild_broadcaster:start_link(?GUILD_ID),
        ok = sys:suspend(B),
        try
            [B ! filler || _ <- lists:seq(1, 500)],
            S1 = publish(Base#{broadcaster_pid => B}, Owner, activity(<<"a">>), stamp(1), #{}),
            Snapshot = #{<<"game_activity">> => activity(<<"a">>)},
            S2 = guild_game_activity:send_snapshot(pid(10, Ctx), Snapshot, S1),
            ?assertEqual({message_queue_len, 500}, process_info(B, message_queue_len)),
            Tag = make_ref(),
            ?assertMatch(
                {noreply, _},
                guild:handle_call(
                    {game_activity_revoke, ?OWNER, <<"epoch-1">>}, {self(), Tag}, S2
                )
            ),
            ?assertEqual({message_queue_len, 501}, process_info(B, message_queue_len)),
            ok = sys:resume(B),
            receive
                {Tag, ok} -> ok
            after 1000 -> ?assert(false)
            end,
            {messages, Delivered} = process_info(pid(10, Ctx), messages),
            ?assertEqual([null], [
                maps:get(<<"game_activity">>, P)
             || {'$gen_cast', {dispatch, presence_update, P}} <- Delivered
            ])
        after
            _ = sys:resume(B),
            gen_server:stop(B)
        end
    end).

t5_game_delivery_bypasses_delayed_relay_test() ->
    with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
        Key = {gateway_dispatch_relay, state},
        Previous = persistent_term:get(Key, undefined),
        Relay = spawn(fun idle/0),
        {ok, B} = guild_broadcaster:start_link(?GUILD_ID),
        try
            persistent_term:put(Key, #{workers => {Relay}}),
            S1 = publish(Base#{broadcaster_pid => B}, Owner, activity(<<"a">>), stamp(1), #{}),
            Snapshot = (guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S1))#{
                <<"user">> => #{<<"id">> => <<"20">>}, <<"guild_id">> => <<"42">>
            },
            S2 = guild_game_activity:send_snapshot(pid(10, Ctx), Snapshot, S1),
            _ = sys:get_state(B),
            Tag = make_ref(),
            Result = guild:handle_call(
                {game_activity_revoke, ?OWNER, <<"epoch-1">>}, {self(), Tag}, S2
            ),
            _ = sys:get_state(B),
            ?assertEqual({messages, []}, process_info(Relay, messages)),
            ?assertMatch({noreply, _}, Result),
            receive
                {Tag, ok} -> ok
            after 1000 -> ?assert(false)
            end,
            {messages, Delivered} = process_info(pid(10, Ctx), messages),
            ?assertEqual([activity(<<"a">>), activity(<<"a">>), null], [
                maps:get(<<"game_activity">>, P)
             || {'$gen_cast', {dispatch, presence_update, P}} <- Delivered
            ])
        after
            case Previous of
                undefined -> persistent_term:erase(Key);
                _ -> persistent_term:put(Key, Previous)
            end,
            gen_server:stop(B),
            exit(Relay, kill)
        end
    end).

t5_publish_stores_entry_only_for_member_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        Stranger = {game_activity_publish, 999, Owner, activity(<<"a">>), stamp(1), #{}},
        ?assertEqual({noreply, S0}, guild_game_activity:handle_cast(Stranger, S0)),
        ?assertEqual([], broadcasts()),
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        ?assertMatch(
            #{<<"game_activity">> := #{<<"game_id">> := <<"a">>}},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S1)
        )
    end).

t5_dispatch_to_subscribers_and_dm_eligible_minus_excluded_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        _ = publish(S0, Owner, activity(<<"a">>), stamp(1), #{50 => true}),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(lists:sort([pid(10, Ctx), pid(40, Ctx)]), Pids),
        ?assertEqual(
            #{
                <<"user">> => #{<<"id">> => <<"20">>},
                <<"guild_id">> => <<"42">>,
                <<"game_activity">> => activity(<<"a">>),
                game_activity_stamp => (stamp(1))#{scope => guild}
            },
            Payload
        )
    end).

t5_game_change_zero_member_list_dispatch_test() ->
    with_fixture(fun(#{state := Base, owner := Owner}) ->
        Tab = ets:new(game_member_presence, [set, public]),
        try
            ets:insert(Tab, {?OWNER, #{<<"status">> => <<"online">>}}),
            S0 = Base#{member_presence => Tab},
            Rows = ets:tab2list(Tab),
            S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
            S2 = publish(S1, Owner, activity(<<"b">>), stamp(2), #{}),
            ?assertEqual(maps:remove(game_activity, S0), maps:remove(game_activity, S2)),
            ?assertEqual(Rows, ets:tab2list(Tab)),
            Messages = drain(),
            ?assertEqual(2, length(Messages)),
            ?assert(
                lists:all(
                    fun
                        ({'$gen_cast', {event_broadcast, presence_update, P, _}}) ->
                            maps:is_key(<<"game_activity">>, P);
                        (_) ->
                            false
                    end,
                    Messages
                )
            )
        after
            ets:delete(Tab)
        end
    end).

t5_revoke_dispatches_null_before_ack_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        _ = drain(),
        {noreply, S2} = guild_game_activity:handle_call(
            {game_activity_revoke, ?OWNER, <<"epoch-1">>}, {self(), make_ref()}, S1
        ),
        receive
            {'$gen_cast', {game_activity_broadcast, Payload, Pids, _From}} ->
                ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
                ?assert(lists:member(pid(10, Ctx), Pids)),
                ?assert(lists:member(pid(40, Ctx), Pids)),
                ?assertNot(lists:member(pid(?OWNER, Ctx), Pids))
        after 0 ->
            ?assert(false)
        end,
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S2)
        )
    end).

t5_exclude_nulls_viewer_sessions_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        _ = drain(),
        {noreply, S2} = guild_game_activity:handle_call(
            {game_activity_exclude, ?OWNER, 10}, {self(), make_ref()}, S1
        ),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
        ?assertEqual([pid(10, Ctx)], Pids),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S2)
        ),
        ?assertMatch(
            #{<<"game_activity">> := #{}},
            guild_game_activity:snapshot_fields(?OWNER, session(40, Ctx), S2)
        )
    end).

t5_unexclude_sends_current_entry_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{10 => true}),
        _ = drain(),
        _ = publish(S1, Owner, activity(<<"a">>), stamp(1), #{}),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(activity(<<"a">>), maps:get(<<"game_activity">>, Payload)),
        ?assertEqual([pid(10, Ctx)], Pids)
    end).

t5_owner_down_drops_only_same_pid_test() ->
    with_fixture(fun(#{state := S0} = Ctx) ->
        Old = spawn(fun idle/0),
        New = spawn(fun idle/0),
        S1 = publish(S0, Old, activity(<<"a">>), stamp(1), #{}),
        S2 = publish(S1, New, activity(<<"b">>), stamp(2), #{}),
        _ = drain(),
        exit(Old, kill),
        receive
            {'DOWN', _, process, Old, _} -> ?assert(false)
        after 50 ->
            ok
        end,
        ?assertEqual(unknown, guild_game_activity:handle_down(make_ref(), S2)),
        ?assertMatch(
            #{<<"game_activity">> := #{<<"game_id">> := <<"b">>}},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S2)
        ),
        exit(New, kill),
        Ref =
            receive
                {'DOWN', R, process, New, _} -> R
            after 1000 ->
                erlang:error(no_down)
            end,
        {ok, S3} = guild_game_activity:handle_down(Ref, S2),
        [{Payload, _Pids}] = broadcasts(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S3)
        )
    end).

t5_stale_rollout_entry_never_emitted_test() ->
    with_fixture(fun(#{state := S0, owner := Owner, pids := Pids} = Ctx) ->
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{10 => true}),
        _ = drain(),
        open_rollout(?EPOCH + 1),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(40, Ctx), S1)
        ),
        S2 = guild_game_activity:dm_eligibility(
            #{}, #{sid(60) => registration(60, Pids)}, [sid(60)], with_session(60, Ctx, S1)
        ),
        _ = publish(S2, Owner, activity(<<"a">>), stamp(1), #{}),
        ?assertEqual([], [
            P
         || {P, _} <- broadcasts(), maps:get(<<"game_activity">>, P) =/= null
        ]),
        close_rollout(),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(40, Ctx), S1)
        )
    end).

t5_large_recipient_set_uses_broadcaster_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        Extra = [{1000 + N, spawn(fun idle/0)} || N <- lists:seq(1, 500)],
        try
            Sessions = maps:merge(
                maps:get(sessions, S0),
                maps:from_list([
                    {sid(U), #{user_id => U, pid => P, viewable_channels => #{500 => true}}}
                 || {U, P} <- Extra
                ])
            ),
            Subs = lists:foldl(
                fun({U, _}, Acc) -> guild_subscriptions:subscribe(sid(U), ?OWNER, Acc) end,
                maps:get(member_subscriptions, S0),
                Extra
            ),
            S1 = S0#{sessions => Sessions, member_subscriptions => Subs},
            _ = publish(S1, Owner, activity(<<"a">>), stamp(1), #{}),
            [{_Payload, Pids}] = broadcasts(),
            Expected = lists:sort(
                [pid(10, Ctx), pid(40, Ctx), pid(50, Ctx)] ++ [P || {_, P} <- Extra]
            ),
            ?assertEqual(Expected, Pids)
        after
            [exit(P, kill) || {_, P} <- Extra]
        end
    end).

t6_added_subscription_snapshot_carries_game_or_null_test() ->
    with_fixture(fun(#{state := S0, owner := Owner}) ->
        ok = start_presence(),
        [ok = presence_cache:put(Id, presence(Id)) || Id <- [?OWNER, 10]],
        _ = sys:get_state(presence_cache),
        Viewer = #{
            user_id => 60, pid => self(), viewable_channels => #{500 => true}, bot => false
        },
        S1 = (publish(S0, Owner, activity(<<"a">>), stamp(1), #{}))#{
            sessions => (maps:get(sessions, S0))#{<<"viewer">> => Viewer}
        },
        _ = drain(),
        {noreply, _} = guild_subscription_handler:handle_cast(
            {update_member_subscriptions, <<"viewer">>, [?OWNER, 10]}, S1
        ),
        Messages = drain(),
        [NoGame] = [
            P
         || {'$gen_cast',
                {event_broadcast, presence_update, #{<<"game_activity">> := null} = P, _}} <-
                Messages
        ],
        [Game] = [
            P
         || {'$gen_cast', {event_broadcast, presence_update, P, [Pid]}} <- Messages,
            Pid =:= self(),
            maps:get(<<"game_activity">>, P, null) =/= null
        ],
        ?assertEqual(
            10, snowflake_id:parse_maybe(maps:get(<<"id">>, maps:get(<<"user">>, NoGame)))
        ),
        ?assertEqual(activity(<<"a">>), maps:get(<<"game_activity">>, Game)),
        ?assertEqual((stamp(1))#{scope => guild}, maps:get(game_activity_stamp, Game)),
        ?assertEqual(<<"online">>, maps:get(<<"status">>, Game)),
        ?assertEqual(null, maps:get(<<"game_activity">>, NoGame))
    end).

t6_unsubscribe_nulls_only_without_other_interest_test() ->
    with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
        ok = start_presence(),
        S0 = subscribe(40, Base),
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        _ = drain(),
        {noreply, S2} = guild_subscription_handler:handle_cast(
            {update_member_subscriptions, sid(10), []}, S1
        ),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
        ?assertEqual([pid(10, Ctx)], Pids),
        {noreply, _} = guild_subscription_handler:handle_cast(
            {update_member_subscriptions, sid(40), []}, S2
        ),
        ?assertEqual([], broadcasts())
    end).

t6_member_remove_nulls_then_prunes_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        _ = drain(),
        S2 = guild_state:update_state(
            guild_member_remove, #{<<"user">> => #{<<"id">> => <<"20">>}}, S1
        ),
        ?assertEqual(
            [?OWNER], [
                U
             || {U, _} <- maps:to_list(maps:get(member_subscriptions, S2)), U =:= ?OWNER
            ]
        ),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
        ?assert(lists:member(pid(10, Ctx), Pids)),
        ?assert(lists:member(pid(40, Ctx), Pids)),
        S3 = guild_maintenance:maybe_prune_invalid_member_subscriptions(
            guild_member_remove, S2
        ),
        ?assertEqual(
            [],
            guild_subscriptions:get_subscribed_sessions(
                ?OWNER, maps:get(member_subscriptions, S3)
            )
        ),
        ?assertEqual([], broadcasts()),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S3)
        )
    end).

t6_prune_nulls_removed_pairs_test() ->
    with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
        S0 = subscribe(40, Base),
        S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
        _ = drain(),
        Sessions = maps:get(sessions, S1),
        Narrowed = maps:map(
            fun
                (Sid, Session) when Sid =:= <<"s10">>; Sid =:= <<"s40">> ->
                    Session#{viewable_channels => #{600 => true}};
                (_Sid, Session) ->
                    Session
            end,
            Sessions
        ),
        S2 = guild_maintenance:maybe_prune_invalid_member_subscriptions(
            guild_role_update, S1#{sessions => Narrowed}
        ),
        Subscribed = guild_subscriptions:get_subscribed_sessions(
            ?OWNER, maps:get(member_subscriptions, S2)
        ),
        ?assertNot(lists:member(sid(10), Subscribed)),
        ?assertNot(lists:member(sid(40), Subscribed)),
        [{Payload, Pids}] = broadcasts(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Payload)),
        ?assert(lists:member(pid(10, Ctx), Pids)),
        ?assertNot(lists:member(pid(40, Ctx), Pids))
    end).

t6_dm_eligibility_gain_sends_entry_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        with_flag(true, fun() ->
            S1 = with_session(60, Ctx, publish(S0, Owner, activity(<<"a">>), stamp(1), #{})),
            _ = drain(),
            {noreply, _} = guild_dm_partners:handle_cast(
                {update_dm_partners, sid(60), [?OWNER]}, S1
            ),
            [{Payload, Pids}] = broadcasts(),
            ?assertEqual(activity(<<"a">>), maps:get(<<"game_activity">>, Payload)),
            ?assertEqual([pid(60, Ctx)], Pids)
        end)
    end).

t6_dm_eligibility_drop_nulls_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        with_flag(true, fun() ->
            S1 = with_session(60, Ctx, publish(S0, Owner, activity(<<"a">>), stamp(1), #{})),
            {noreply, S2} = guild_dm_partners:handle_cast(
                {update_dm_partners, sid(60), [?OWNER]}, S1
            ),
            _ = drain(),
            S3 = with_member(member(?OWNER, [?OTHER_ROLE]), S2),
            _ = guild_dm_partners:maybe_reevaluate(
                guild_member_update, #{<<"user">> => #{<<"id">> => <<"20">>}}, S2, S3
            ),
            Nulls = [
                Pids
             || {P, Pids} <- broadcasts(), maps:get(<<"game_activity">>, P) =:= null
            ],
            ?assert(lists:member(pid(60, Ctx), lists:append(Nulls)))
        end)
    end).

t6_offline_presence_drops_entry_test() ->
    with_fixture(fun(#{state := Base, owner := Owner} = Ctx) ->
        Tab = ets:new(game_offline_presence, [set, public]),
        try
            S0 = Base#{
                member_presence => Tab,
                member_list_subscriptions => guild_member_list_subs:new()
            },
            ets:insert(Tab, {?OWNER, presence(?OWNER)}),
            S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
            _ = drain(),
            Offline = #{<<"status">> => <<"invisible">>, <<"user">> => #{<<"id">> => <<"20">>}},
            {noreply, S2} = guild_presence:handle_bus_presence(?OWNER, Offline, S1),
            Games = [P || {P, _} <- broadcasts(), maps:is_key(<<"game_activity">>, P)],
            ?assertMatch([#{<<"game_activity">> := null}], Games),
            ?assertMatch(
                #{<<"game_activity">> := null},
                guild_game_activity:snapshot_fields(?OWNER, session(10, Ctx), S2)
            )
        after
            ets:delete(Tab)
        end
    end).

t6_member_list_sync_payload_has_no_game_test() ->
    with_fixture(fun(#{state := Base, owner := Owner}) ->
        ok = start_presence(),
        ok = presence_cache:put(?OWNER, presence(?OWNER)),
        _ = sys:get_state(presence_cache),
        Cached = presence_cache:get(?OWNER),
        Tab = ets:new(game_sync_presence, [set, public]),
        try
            S0 = Base#{
                member_presence => Tab,
                member_list_subscriptions => guild_member_list_subs:new()
            },
            S1 = publish(S0, Owner, activity(<<"a">>), stamp(1), #{}),
            ?assertEqual([], ets:tab2list(Tab)),
            ?assertEqual(Cached, presence_cache:get(?OWNER)),
            _ = drain(),
            {noreply, _} = guild_presence:handle_bus_presence(?OWNER, presence(?OWNER), S1),
            Presence = [P || {P, _} <- broadcasts()],
            ?assertMatch([_], Presence),
            [
                ?assertNot(maps:is_key(K, P))
             || P <- Presence, K <- [<<"game_activity">>, game_activity_stamp]
            ],
            ?assertNot(maps:is_key(<<"game_activity">>, element(2, Cached)))
        after
            ets:delete(Tab)
        end
    end).

guild_routes_game_activity_messages_test() ->
    with_fixture(fun(#{state := S0} = Ctx) ->
        Owner = spawn(fun idle/0),
        Publish = {game_activity_publish, ?OWNER, Owner, activity(<<"a">>), stamp(1), #{}},
        {noreply, S1} = guild:handle_cast(Publish, S0),
        [{_, _}] = broadcasts(),
        {noreply, S2} = guild:handle_call(
            {game_activity_exclude, ?OWNER, 10}, {self(), make_ref()}, S1
        ),
        [{_, [P10]}] = broadcasts(),
        ?assertEqual(pid(10, Ctx), P10),
        exit(Owner, kill),
        Down =
            receive
                {'DOWN', _, process, Owner, _} = D -> D
            after 1000 ->
                erlang:error(no_down)
            end,
        {noreply, S3} = guild:handle_info(Down, S2),
        ?assertMatch(
            #{<<"game_activity">> := null},
            guild_game_activity:snapshot_fields(?OWNER, session(40, Ctx), S3)
        ),
        {noreply, _} = guild:handle_call(
            {game_activity_revoke, ?OWNER, <<"epoch-1">>}, {self(), make_ref()}, S3
        )
    end).

dm_index_follows_registrations_test() ->
    with_fixture(fun(#{state := S0, owner := Owner} = Ctx) ->
        with_flag(true, fun() ->
            S1 = with_session(60, Ctx, S0),
            {noreply, S2} = guild_dm_partners:handle_cast(
                {update_dm_partners, sid(60), [?OWNER]}, S1
            ),
            {noreply, S3} = guild_dm_partners:handle_cast(
                {update_dm_partners, sid(60), []}, S2
            ),
            _ = drain(),
            _ = publish(S3, Owner, activity(<<"a">>), stamp(1), #{}),
            [{_, Pids}] = broadcasts(),
            ?assertNot(lists:member(pid(60, Ctx), Pids))
        end)
    end).

with_fixture(Fun) ->
    open_rollout(?EPOCH),
    Pids = maps:from_list([{U, spawn(fun idle/0)} || U <- [10, 20, 30, 40, 50, 60]]),
    Owner = spawn(fun idle/0),
    _ = drain(),
    Ctx = #{pids => Pids, owner => Owner},
    try
        Fun(Ctx#{state => state(Ctx)})
    after
        close_rollout(),
        [exit(P, kill) || P <- [Owner | maps:values(Pids)]],
        _ = drain()
    end.

state(#{pids := Pids}) ->
    Channels = [channel(500, ?VIEW_ROLE), channel(600, ?OTHER_ROLE)],
    Members = maps:from_list(
        [{7, member(7, [])}, {30, member(30, [?OTHER_ROLE])}] ++
            [{U, member(U, [?VIEW_ROLE])} || U <- [10, 20, 40, 50, 60]]
    ),
    Sessions = maps:from_list([
        {sid(U), #{
            session_id => sid(U),
            user_id => U,
            pid => maps:get(U, Pids),
            viewable_channels => viewable(U),
            bot => false
        }}
     || U <- [10, 20, 30, 40, 50]
    ]),
    Subs = lists:foldl(
        fun(U, Acc) -> guild_subscriptions:subscribe(sid(U), ?OWNER, Acc) end,
        guild_subscriptions:init_state(),
        [10, 20, 30, 50]
    ),
    Registrations = #{sid(40) => registration(40, Pids)},
    Base = #{
        id => ?GUILD_ID,
        broadcaster_pid => self(),
        disable_guild_count_cache_updates => true,
        disable_permission_cache_updates => true,
        virtual_channel_access => #{},
        data => #{
            <<"guild">> => #{<<"owner_id">> => <<"7">>},
            <<"roles">> => [role(?GUILD_ID), role(?VIEW_ROLE), role(?OTHER_ROLE)],
            <<"members">> => Members,
            <<"channels">> => Channels,
            <<"channel_index">> => guild_data_index:build_id_index(Channels)
        },
        sessions => Sessions,
        member_subscriptions => Subs,
        member_presence => ets:new(game_member_presence, [set, public]),
        member_list_subscriptions => guild_member_list_subs:new(),
        dm_partners => Registrations
    },
    guild_game_activity:dm_eligibility(#{}, Registrations, [sid(40)], Base).

registration(UserId, Pids) ->
    #{
        user_id => UserId,
        pid => maps:get(UserId, Pids),
        partners => #{?OWNER => true},
        eligible => #{?OWNER => true}
    }.

with_session(UserId, #{pids := Pids}, State) ->
    Session = #{
        session_id => sid(UserId),
        user_id => UserId,
        pid => maps:get(UserId, Pids),
        viewable_channels => viewable(UserId),
        bot => false
    },
    State#{sessions => (maps:get(sessions, State))#{sid(UserId) => Session}}.

subscribe(UserId, State) ->
    State#{
        member_subscriptions => guild_subscriptions:subscribe(
            sid(UserId), ?OWNER, maps:get(member_subscriptions, State)
        )
    }.

with_member(Member, #{data := Data} = State) ->
    #{<<"user">> := #{<<"id">> := RawId}} = Member,
    Members = maps:get(<<"members">>, Data),
    State#{data => Data#{<<"members">> => Members#{binary_to_integer(RawId) => Member}}}.

session(UserId, #{pids := Pids}) ->
    #{user_id => UserId, pid => maps:get(UserId, Pids), bot => false}.

pid(UserId, #{pids := Pids}) ->
    maps:get(UserId, Pids).

sid(UserId) ->
    <<"s", (integer_to_binary(UserId))/binary>>.

viewable(30) -> #{600 => true};
viewable(_) -> #{500 => true}.

publish(State, OwnerPid, Activity, Stamp, Excluded) ->
    {noreply, NewState} = guild_game_activity:handle_cast(
        {game_activity_publish, ?OWNER, OwnerPid, Activity, Stamp, Excluded}, State
    ),
    NewState.

activity(GameId) ->
    #{<<"game_id">> => GameId, <<"started_at">> => 1700000000000}.

stamp(Revision) ->
    #{owner_epoch => <<"epoch-1">>, activity_revision => Revision, rollout_epoch => ?EPOCH}.

presence(UserId) ->
    #{
        <<"status">> => <<"online">>,
        <<"mobile">> => false,
        <<"afk">> => false,
        <<"user">> => #{<<"id">> => integer_to_binary(UserId)}
    }.

role(RoleId) ->
    #{<<"id">> => integer_to_binary(RoleId), <<"permissions">> => <<"0">>}.

member(UserId, RoleIds) ->
    #{
        <<"user">> => #{<<"id">> => integer_to_binary(UserId)},
        <<"roles">> => [integer_to_binary(RoleId) || RoleId <- RoleIds]
    }.

channel(ChannelId, RoleId) ->
    #{
        <<"id">> => integer_to_binary(ChannelId),
        <<"type">> => 0,
        <<"permission_overwrites">> => [
            #{
                <<"id">> => integer_to_binary(RoleId),
                <<"type">> => 0,
                <<"allow">> => integer_to_binary(constants:view_channel_permission()),
                <<"deny">> => <<"0">>
            }
        ]
    }.

open_rollout(Epoch) ->
    persistent_term:put(?ROLLOUT_KEY, #{
        <<"game_activity_enabled">> => true, <<"game_activity_epoch">> => Epoch
    }),
    persistent_term:put(?GATE_KEY, #{
        validated_at => erlang:monotonic_time(millisecond), epoch => Epoch, generation => 1
    }).

close_rollout() ->
    _ = persistent_term:erase(?ROLLOUT_KEY),
    _ = persistent_term:erase(?GATE_KEY),
    ok.

start_presence() ->
    ok = ensure_started(presence_bus, fun presence_bus:start_link/0),
    ensure_started(presence_cache, fun presence_cache:start_link/0).

ensure_started(Name, Start) ->
    case whereis(Name) of
        undefined ->
            case Start() of
                {ok, Pid} ->
                    unlink(Pid),
                    ok;
                {error, {already_started, _}} ->
                    ok
            end;
        _ ->
            ok
    end.

with_flag(Value, Fun) ->
    Previous = application:get_env(fluxer_gateway, ?DM_FLAG),
    application:set_env(fluxer_gateway, ?DM_FLAG, Value),
    try
        Fun()
    after
        case Previous of
            undefined -> application:unset_env(fluxer_gateway, ?DM_FLAG);
            {ok, V} -> application:set_env(fluxer_gateway, ?DM_FLAG, V)
        end
    end.

broadcasts() ->
    lists:flatmap(
        fun
            ({'$gen_cast', {event_broadcast, presence_update, Payload, Pids}}) ->
                [{Payload, lists:sort(Pids)}];
            ({'$gen_cast', {game_activity_broadcast, Payload, Pids, _From}}) ->
                [{Payload, lists:sort(Pids)}];
            (_) ->
                []
        end,
        drain()
    ).

drain() ->
    drain([]).

drain(Acc) ->
    receive
        {dm_partner_mutual, _, _} -> drain(Acc);
        Msg -> drain([Msg | Acc])
    after 50 -> lists:reverse(Acc)
    end.

idle() ->
    receive
        stop -> ok
    after 60000 -> ok
    end.
