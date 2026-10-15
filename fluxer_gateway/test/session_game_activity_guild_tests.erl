%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(session_game_activity_guild_tests).
-include_lib("eunit/include/eunit.hrl").

t4_guild_scope_allowed_when_member_and_unblocked_test() ->
    with_rollout(fun() ->
        Wired = session_game_activity:wire(presence_update, guild_payload(1), state(#{})),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, Wired)),
        ?assertEqual(<<"50">>, maps:get(<<"guild_id">>, Wired)),
        ?assertNot(maps:is_key(game_activity_stamp, Wired)),
        {noreply, _} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(1), state(#{})
        ),
        {dispatch, presence_update, Sent, 1} = next(),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, Sent)),
        ?assertNot(maps:is_key(game_activity_stamp, Sent))
    end).

t4_viewer_block_rejects_guild_scope_test() ->
    with_rollout(fun() ->
        Blocked = state(#{relationships => #{42 => 2}}),
        {noreply, _} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(1), Blocked
        ),
        {dispatch, presence_update, Sent, 1} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Sent)),
        ?assertNot(maps:is_key(game_activity_stamp, Sent))
    end).

t4_guild_scope_rejected_after_guild_leave_test() ->
    with_rollout(fun() ->
        {noreply, Left} = session_guilds:handle_guild_leave(50, state(#{})),
        {dispatch, guild_delete, _, 1} = next(),
        ?assertNot(maps:is_key(50, maps:get(guilds, Left))),
        ?assertEqual(
            null,
            maps:get(
                <<"game_activity">>,
                session_game_activity:wire(presence_update, guild_payload(1), Left)
            )
        )
    end).

t4_unstamped_guild_game_nulled_test() ->
    with_rollout(fun() ->
        Open = friend_grant(),
        Unstamped = maps:remove(game_activity_stamp, guild_payload(1)),
        FriendStamped = (guild_payload(1))#{game_activity_stamp => friend_stamp(1)},
        lists:foreach(
            fun(Data) ->
                ?assertEqual(
                    null,
                    maps:get(
                        <<"game_activity">>,
                        session_game_activity:wire(presence_update, Data, Open)
                    )
                )
            end,
            [Unstamped, FriendStamped]
        )
    end).

t4_bot_receiver_nulled_test() ->
    with_rollout(fun() ->
        Wired = session_game_activity:wire(
            presence_update, guild_payload(1), state(#{bot => true})
        ),
        ?assertEqual(null, maps:get(<<"game_activity">>, Wired))
    end).

t4_self_and_closed_rollout_nulled_test() ->
    with_rollout(fun() ->
        Own = session_game_activity:wire(
            presence_update, guild_payload(1), state(#{user_id => 42})
        ),
        ?assertEqual(null, maps:get(<<"game_activity">>, Own)),
        StaleEpoch = guild_payload(1, #{rollout_epoch => 0}),
        ?assertEqual(
            null,
            maps:get(
                <<"game_activity">>,
                session_game_activity:wire(presence_update, StaleEpoch, state(#{}))
            )
        ),
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> false end),
        ?assertEqual(
            null,
            maps:get(
                <<"game_activity">>,
                session_game_activity:wire(presence_update, guild_payload(1), state(#{}))
            )
        )
    end).

t4_older_revision_rejected_across_scopes_test() ->
    with_rollout(fun() ->
        {noreply, Friend} = session_game_activity:deliver(
            42, activity(), friend_stamp(5), friend_grant()
        ),
        {dispatch, presence_update, _, 1} = next(),
        {noreply, Older} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(4), Friend
        ),
        {dispatch, presence_update, OlderSent, 2} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, OlderSent)),
        {noreply, Newer} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(6), Older
        ),
        {dispatch, presence_update, NewerSent, 3} = next(),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, NewerSent)),
        {noreply, Unchanged} = session_game_activity:deliver(
            42, activity(), friend_stamp(5), Newer
        ),
        ?assertEqual(3, maps:get(seq, Unchanged)),
        no_dispatch()
    end).

t4_new_owner_epoch_resets_guild_revision_test() ->
    with_rollout(fun() ->
        {noreply, Seen} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(9), state(#{})
        ),
        next(),
        Restarted = guild_payload(1, #{owner_epoch => <<"restarted">>}),
        {noreply, _} = session_dispatch:handle_dispatch(presence_update, Restarted, Seen),
        {dispatch, presence_update, Sent, 2} = next(),
        ?assertEqual(activity(), maps:get(<<"game_activity">>, Sent))
    end).

t4_guild_null_forgets_revision_without_grant_test() ->
    with_rollout(fun() ->
        {noreply, Seen} = session_dispatch:handle_dispatch(
            presence_update, guild_payload(6), state(#{})
        ),
        next(),
        ?assertEqual(6, maps:get(42, maps:get(game_activity_revisions, Seen))),
        Cleared = (guild_payload(7))#{<<"game_activity">> => null},
        {noreply, Forgotten} = session_dispatch:handle_dispatch(presence_update, Cleared, Seen),
        {dispatch, presence_update, Sent, 2} = next(),
        ?assertEqual(null, maps:get(<<"game_activity">>, Sent)),
        ?assertNot(maps:is_key(42, maps:get(game_activity_revisions, Forgotten, #{})))
    end).

t4_replay_processed_guild_null_never_reopens_game_test() ->
    with_rollout(fun() ->
        lists:foreach(
            fun(N) ->
                Buffered = state(#{socket_pid => undefined}),
                {noreply, Seen} = session_dispatch:handle_dispatch(
                    presence_update, guild_payload(1), Buffered
                ),
                Cleared = (guild_payload(2))#{<<"game_activity">> => null},
                {noreply, Forgotten} = session_dispatch:handle_dispatch(
                    presence_update, Cleared, Seen
                ),
                ?assertNot(maps:is_key(42, maps:get(game_activity_revisions, Forgotten))),
                Padding = [
                    #{event => message_create, seq => I, data => #{<<"id">> => I}}
                 || I <- lists:seq(3, N)
                ],
                Buffer = limited_deque:to_list(maps:get(buffer, Forgotten)) ++ Padding,
                Replayed = replay(N, Forgotten#{seq => N, buffer => Buffer}),
                ?assertEqual(lists:seq(1, N), [maps:get(seq, E) || E <- Replayed]),
                ?assertEqual([null], replay_games(Replayed))
            end,
            [2, 257]
        )
    end).

t4_replay_keeps_only_latest_game_per_owner_and_guild_test() ->
    with_rollout(fun() ->
        Old = (guild_payload(1))#{
            <<"status">> => <<"online">>,
            <<"custom_status">> => #{<<"text">> => <<"old status">>},
            <<"mobile">> => true
        },
        NewActivity = #{<<"manual_name">> => <<"new game">>, <<"started_at">> => 2},
        OtherOwner = (guild_payload(1))#{<<"user">> => #{<<"id">> => <<"43">>}},
        OtherGuild = (guild_payload(1))#{<<"guild_id">> => <<"51">>},
        New = (guild_payload(2))#{<<"game_activity">> => NewActivity},
        Normal = maps:without([<<"game_activity">>, game_activity_stamp], guild_payload(2)),
        Data = [Old, OtherOwner, OtherGuild, New, Normal],
        Entries = [
            #{event => presence_update, seq => I, data => D}
         || {I, D} <- lists:zip(lists:seq(1, length(Data)), Data)
        ],
        Replayed = replay(
            5,
            state(#{
                seq => 5,
                buffer => Entries,
                guilds => #{50 => {self(), make_ref()}, 51 => {self(), make_ref()}}
            })
        ),
        ?assertEqual([1, 2, 3, 4, 5], [maps:get(seq, E) || E <- Replayed]),
        ?assertEqual([activity(), activity(), NewActivity], replay_games(Replayed)),
        [#{data := First}, _, _, _, #{data := Last}] = Replayed,
        ?assertEqual(maps:without([<<"game_activity">>, game_activity_stamp], Old), First),
        ?assertEqual(Normal, Last)
    end).

t4_replay_encoded_guild_game_before_null_is_removed_test() ->
    with_rollout(fun() ->
        Old =
            {pre_encoded,
                iolist_to_binary(
                    json:encode(
                        maps:remove(game_activity_stamp, guild_payload(1))
                    )
                )},
        Cleared = (guild_payload(2))#{<<"game_activity">> => null},
        Entries = [
            #{event => <<"PRESENCE_UPDATE">>, seq => 1, data => Old},
            #{event => presence_update, seq => 2, data => Cleared}
        ],
        Replayed = replay(2, state(#{seq => 2, buffer => Entries})),
        ?assertEqual([null], replay_games(Replayed))
    end).

t4_replay_inline_and_finalize_redact_guild_scope_test() ->
    with_rollout(fun() ->
        lists:foreach(
            fun(N) ->
                Entries = [entry(I) || I <- lists:seq(1, N)],
                Base = #{seq => N, buffer => Entries},
                Blocked = replay(N, state(Base#{relationships => #{42 => 2}})),
                ?assertEqual(lists:seq(1, N), [maps:get(seq, E) || E <- Blocked]),
                ?assertEqual([null], replay_games(Blocked)),
                ?assert(
                    lists:all(
                        fun(#{data := D}) -> not maps:is_key(game_activity_stamp, D) end,
                        Blocked
                    )
                ),
                Left = replay(N, state(Base#{guilds => #{}})),
                ?assertEqual([null], replay_games(Left)),
                Allowed = replay(N, state(Base)),
                ?assertEqual([activity()], replay_games(Allowed))
            end,
            [1, 257]
        )
    end).

t4_ready_and_guild_create_unchanged_test() ->
    with_rollout(fun() ->
        Presence = #{<<"user">> => #{<<"id">> => <<"42">>}, <<"status">> => <<"online">>},
        Ready = session_game_activity:wire(
            ready, #{<<"presences">> => [Presence]}, state(#{})
        ),
        ?assertEqual([Presence], maps:get(<<"presences">>, Ready)),
        GuildCreate = #{<<"id">> => <<"50">>, <<"presences">> => [], <<"members">> => []},
        ?assertEqual(
            GuildCreate, session_game_activity:wire(guild_create, GuildCreate, state(#{}))
        ),
        ?assertEqual(
            GuildCreate, session_game_activity:wire(<<"GUILD_CREATE">>, GuildCreate, state(#{}))
        )
    end).

replay(N, State) ->
    {reply, {ok, Reply, N}, _} = session_lifecycle:handle_resume(0, self(), State),
    case Reply of
        [] -> [next_entry() || _ <- lists:seq(1, N)];
        _ -> Reply
    end.

replay_games(Entries) ->
    [Game || #{data := #{<<"game_activity">> := Game}} <- Entries].

entry(Seq) -> #{event => presence_update, seq => Seq, user_id => 42, data => guild_payload(1)}.

guild_payload(Revision) -> guild_payload(Revision, #{}).

guild_payload(Revision, StampChanges) ->
    #{
        <<"user">> => #{<<"id">> => <<"42">>},
        <<"guild_id">> => <<"50">>,
        <<"game_activity">> => activity(),
        game_activity_stamp => maps:merge(
            #{
                owner_epoch => <<"epoch">>,
                activity_revision => Revision,
                rollout_epoch => 1,
                scope => guild
            },
            StampChanges
        )
    }.

friend_stamp(Revision) ->
    #{
        owner_pid => self(),
        owner_epoch => <<"epoch">>,
        policy_revision => 1,
        pair_generation => 1,
        activity_revision => Revision,
        rollout_epoch => 1,
        request_nonce => <<"nonce">>,
        allowed => true
    }.

friend_grant() ->
    State = state(#{relationships => #{42 => 1}}),
    {reply, ok, Expected} = session_game_activity:expect(42, friend_stamp(1), State),
    {reply, {ok, _}, Open} = session_game_activity:grant(42, friend_stamp(1), Expected),
    Open.

activity() -> #{<<"game_id">> => <<"game">>, <<"started_at">> => 1}.

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
            presence_pid => undefined,
            presence_mref => undefined,
            socket_mref => undefined,
            resume_timer => undefined,
            offline_timer => undefined,
            relationships => #{},
            channels => #{},
            guilds => #{50 => {self(), make_ref()}},
            suppress_presence_updates => false,
            pending_presences => []
        },
        Extra
    ).

with_rollout(Fun) ->
    meck:new(gateway_rollout_config, [non_strict, no_link]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 1} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 1 end),
    try
        Fun()
    after
        meck:unload(gateway_rollout_config),
        flush()
    end.

next() ->
    receive
        {dispatch, _, _, _} = M -> M
    after 1000 -> error(missing_dispatch)
    end.

next_entry() ->
    {dispatch, Event, Data, Seq} = next(),
    #{event => Event, data => Data, seq => Seq}.

no_dispatch() ->
    receive
        {dispatch, _, _, _} = M -> error({unexpected_dispatch, M})
    after 100 -> ok
    end.

flush() ->
    receive
        _ -> flush()
    after 0 -> ok
    end.
