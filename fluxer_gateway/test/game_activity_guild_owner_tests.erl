%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_guild_owner_tests).
-include_lib("eunit/include/eunit.hrl").

t3_permitted_friends_or_everyone_test() ->
    ?assert(presence_game_activity_policy:permitted(policy_game(<<"friends">>))),
    ?assert(presence_game_activity_policy:permitted(policy_game(<<"everyone">>))),
    ?assertNot(presence_game_activity_policy:permitted(policy_game(<<"off">>))),
    ?assertNot(presence_game_activity_policy:permitted_everyone(policy_game(<<"friends">>))),
    ?assert(presence_game_activity_policy:permitted_everyone(policy_game(<<"everyone">>))),
    ?assertNot(
        presence_game_activity_policy:permitted_everyone(
            (policy_game(<<"everyone">>))#{fenced => true}
        )
    ).

t3_publish_on_activity_change_only_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        {game_activity_publish, 1, Owner, Alpha, Stamp1, Excluded} = next_cast(Guild),
        ?assertEqual(self(), Owner),
        ?assertEqual(#{}, Excluded),
        ?assertEqual(<<"alpha">>, maps:get(<<"game_id">>, Alpha)),
        ?assertEqual(
            [activity_revision, owner_epoch, rollout_epoch], lists:sort(maps:keys(Stamp1))
        ),
        S2 = play(<<"alpha">>, S1),
        no_guild_message(Guild),
        _ = play(<<"beta">>, S2),
        {game_activity_publish, 1, _, Beta, Stamp2, _} = next_cast(Guild),
        ?assertEqual(<<"beta">>, maps:get(<<"game_id">>, Beta)),
        ?assert(maps:get(activity_revision, Stamp2) > maps:get(activity_revision, Stamp1))
    end).

t3_friends_visibility_never_reaches_guilds_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        _ = play(<<"alpha">>, fixture(<<"friends">>)),
        no_guild_message(Guild),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, '_'))
    end).

t3_lease_renew_zero_guild_messages_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        Lookups = meck:num_calls(guild_manager, lookup, '_'),
        _ = lists:foldl(fun(_, S) -> play(<<"alpha">>, S) end, S1, lists:seq(1, 5)),
        no_guild_message(Guild),
        ?assertEqual(Lookups, meck:num_calls(guild_manager, lookup, '_'))
    end).

t3_invisible_publishes_null_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        {noreply, _} = presence:handle_cast(
            {presence_update, #{session_id => <<"a">>, status => invisible}}, S1
        ),
        {game_activity_publish, 1, _, null, _, _} = next_cast(Guild)
    end).

t3_only_me_or_under15_never_publishes_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        lists:foreach(
            fun(Policy) ->
                State = with_policy(Policy, fixture(<<"everyone">>)),
                _ = play(<<"alpha">>, State)
            end,
            [
                #{effective_profile_audience => <<"only_me">>},
                #{eligible_16_plus => false},
                #{effective_profile_audience => <<"unknown">>, eligible_16_plus => null}
            ]
        ),
        no_guild_message(Guild),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, '_'))
    end).

t3_fence_waits_guild_acks_test() ->
    with_owner(fun() ->
        Guild = guild(hold),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        Epoch = maps:get(owner_epoch, maps:get(game_activity_state, S1)),
        Tag = make_ref(),
        {noreply, S2} = presence:handle_call(
            {game_activity_control, policy, fence(<<"close">>)}, {self(), Tag}, S1
        ),
        ?assertEqual({game_activity_revoke, 1, Epoch}, next_call(Guild)),
        receive
            {game_activity_barrier_done, _, _} -> ?assert(false)
        after 300 -> ok
        end,
        Guild ! {reply, ok},
        S3 = feed_guild_reply(S2),
        Done = barrier_done(3000),
        {noreply, _} = presence:handle_info(Done, S3),
        receive
            {Tag, Reply} -> ?assertMatch({ok, #{<<"phase">> := <<"fence">>}}, Reply)
        after 500 -> ?assert(false)
        end,
        no_guild_message(Guild)
    end).

t3_guild_ack_timeout_fails_fence_test_() ->
    {timeout, 15, fun guild_ack_timeout_fails_fence/0}.

t3_fence_timeout_abandons_requests_keeps_leave_test_() ->
    {timeout, 10, fun() ->
        with_owner(fun() ->
            Left = guild(silent),
            Active = guild(silent),
            set_guilds(#{10 => Left, 11 => Active}),
            S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
                guild_ids => #{10 => true, 11 => true}
            }),
            _ = next_cast(Left),
            _ = next_cast(Active),
            {reply, ok, S2} = presence_connect:handle_leave_guild(10, S1),
            _ = next_call(Left),
            Before = owner_monitors(),
            {noreply, S3} = presence:handle_call(
                {game_activity_control, policy, fence(<<"timeout-cleanup">>)},
                {self(), make_ref()},
                S2
            ),
            _ = next_call(Active),
            Requests = barrier_requests(S3),
            {noreply, S4} = presence:handle_info(barrier_done(6000), S3),
            ?assertEqual(Before, owner_monitors()),
            assert_abandoned_aliases(Requests),
            Game = maps:get(game_activity_state, S4),
            ?assertEqual(1, map_size(maps:get(guild_leaves, Game))),
            ?assertEqual(1, gen_server:reqids_size(maps:get(guild_leave_requests, Game)))
        end)
    end}.

t3_fence_early_error_abandons_remaining_requests_test() ->
    with_owner(fun() ->
        Failed = guild(hold),
        Silent = guild(silent),
        set_guilds(#{10 => Failed, 11 => Silent}),
        S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
            guild_ids => #{10 => true, 11 => true}
        }),
        _ = next_cast(Failed),
        _ = next_cast(Silent),
        Before = owner_monitors(),
        {noreply, S2} = presence:handle_call(
            {game_activity_control, policy, fence(<<"error-cleanup">>)},
            {self(), make_ref()},
            S1
        ),
        _ = next_call(Failed),
        _ = next_call(Silent),
        Requests = barrier_requests(S2),
        Failed ! {reply, {error, unavailable}},
        S3 = feed_guild_reply(S2),
        {noreply, _} = presence:handle_info(barrier_done(3000), S3),
        ?assertEqual(Before, owner_monitors()),
        assert_abandoned_aliases(Requests)
    end).

owner_monitors() ->
    {monitors, Monitors} = process_info(self(), monitors),
    lists:sort(Monitors).

barrier_requests(State) ->
    lists:flatmap(
        fun({_Worker, Requests, _Leaves}) ->
            [Ref || {Ref, _Label} <- gen_server:reqids_to_list(Requests)]
        end,
        maps:values(maps:get(game_activity_guild_barriers, State))
    ).

assert_abandoned_aliases(Requests) ->
    Marker = make_ref(),
    lists:foreach(fun(Ref) -> Ref ! Marker end, Requests),
    receive
        Marker -> ?assert(false)
    after 0 -> ok
    end.

guild_ack_timeout_fails_fence() ->
    with_owner(fun() ->
        Guild = guild(silent),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        Tag = make_ref(),
        {noreply, S2} = presence:handle_call(
            {game_activity_control, policy, fence(<<"close">>)}, {self(), Tag}, S1
        ),
        {game_activity_revoke, 1, _} = next_call(Guild),
        Started = erlang:monotonic_time(millisecond),
        Done = barrier_done(6000),
        ?assert(erlang:monotonic_time(millisecond) - Started >= 1500),
        {noreply, _} = presence:handle_info(Done, S2),
        receive
            {Tag, Reply} -> ?assertMatch({error, _}, Reply)
        after 500 -> ?assert(false)
        end
    end).

t3_pair_fence_excludes_viewer_in_guilds_test() ->
    with_owner(fun() ->
        Guild = guild(hold),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        Tag = make_ref(),
        Fence = #{viewer_id => 7, phase => <<"fence">>, request_id => <<"pair-a">>},
        {noreply, S2} = presence:handle_call(
            {game_activity_control, pair, Fence}, {self(), Tag}, S1
        ),
        ?assertEqual({game_activity_exclude, 1, 7}, next_call(Guild)),
        receive
            {game_activity_barrier_done, _, _} -> ?assert(false)
        after 300 -> ok
        end,
        Guild ! {reply, ok},
        S3 = feed_guild_reply(S2),
        {noreply, S4} = presence:handle_info(barrier_done(3000), S3),
        receive
            {Tag, {ok, _}} -> ok
        after 500 -> ?assert(false)
        end,
        _ = play(<<"beta">>, S4),
        {game_activity_publish, 1, _, _, _, Excluded} = next_cast(Guild),
        ?assertEqual(#{7 => true}, Excluded)
    end).

t3_stale_sync_cannot_unexclude_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        S2 = pair(7, true, S1, Guild),
        {noreply, S3} = presence:handle_cast({game_activity_blocked, []}, S2),
        no_guild_message(Guild),
        S4 = play(<<"beta">>, S3),
        {game_activity_publish, 1, _, _, _, Blocked} = next_cast(Guild),
        ?assertEqual(#{7 => true}, Blocked),
        _ = pair(7, false, S4, Guild),
        {game_activity_publish, 1, _, _, _, Unblocked} = next_cast(Guild),
        ?assertEqual(#{}, Unblocked)
    end).

t3_blocked_sync_updates_exclusion_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        {noreply, S2} = presence:handle_cast({game_activity_blocked, [8, 9]}, S1),
        {game_activity_publish, 1, _, Alpha, _, Excluded} = next_cast(Guild),
        ?assertEqual(<<"alpha">>, maps:get(<<"game_id">>, Alpha)),
        ?assertEqual(#{8 => true, 9 => true}, Excluded),
        {noreply, _} = presence:handle_cast({game_activity_blocked, [8, 9]}, S2),
        no_guild_message(Guild)
    end).

t3_leave_guild_stops_publish_test() ->
    with_owner(fun() ->
        Left = guild(ack),
        Kept = guild(ack),
        set_guilds(#{10 => Left, 11 => Kept}),
        S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
            guild_ids => #{10 => true, 11 => true}
        }),
        {game_activity_publish, 1, _, _, Stamp, _} = next_cast(Left),
        _ = next_cast(Kept),
        ?assertEqual(S1, presence_game_activity:leave_guild(99, S1)),
        no_guild_message(Left),
        no_guild_message(Kept),
        {reply, ok, S2} = presence_connect:handle_leave_guild(10, S1),
        ?assertEqual(
            {game_activity_revoke, 1, maps:get(owner_epoch, Stamp)}, next_call(Left)
        ),
        ?assertEqual(S2, presence_game_activity:leave_guild(10, S2)),
        _ = play(<<"beta">>, S2),
        {game_activity_publish, 1, _, Beta, _, _} = next_cast(Kept),
        ?assertEqual(<<"beta">>, maps:get(<<"game_id">>, Beta)),
        no_guild_message(Left)
    end).

t3_leave_unpublished_guild_sends_no_message_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        State = fixture(<<"everyone">>),
        Game = maps:get(game_activity_state, State),
        Ref = monitor(process, Guild),
        Tracked = State#{
            game_activity_state => Game#{
                guild_targets => #{10 => {Guild, Ref}}, guild_refs => #{Ref => 10}
            }
        },
        {reply, ok, Left} = presence_connect:handle_leave_guild(10, Tracked),
        LeftGame = maps:get(game_activity_state, Left),
        ?assertEqual(#{}, maps:get(guild_targets, LeftGame)),
        ?assertEqual(#{}, maps:get(guild_refs, LeftGame)),
        no_guild_message(Guild)
    end).

t3_join_guild_publishes_current_test() ->
    with_owner(fun() ->
        Old = guild(ack),
        Joined = guild(ack),
        set_guilds(#{10 => Old, 12 => Joined}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        {game_activity_publish, 1, _, _, Stamp, _} = next_cast(Old),
        {reply, ok, S2} = presence_connect:handle_join_guild(12, S1),
        _ = pump(S2),
        {game_activity_publish, 1, _, Alpha, Stamp, #{}} = next_cast(Joined),
        ?assertEqual(<<"alpha">>, maps:get(<<"game_id">>, Alpha)),
        no_guild_message(Old)
    end).

t3_pending_leaves_keep_target_budget_bounded_test() ->
    with_owner(fun() ->
        Guild = guild(silent),
        Ids = lists:seq(1, 200),
        set_guilds(maps:from_keys(Ids ++ [201], Guild)),
        S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
            guild_ids => maps:from_keys(Ids, true)
        }),
        [_ = next_cast(Guild) || _ <- Ids],
        Left = lists:foldl(
            fun(Id, State) ->
                {reply, ok, Next} = presence_connect:handle_leave_guild(Id, State),
                {game_activity_revoke, 1, _} = next_call(Guild),
                Next
            end,
            S1,
            Ids
        ),
        {reply, ok, Joined} = presence_connect:handle_join_guild(201, Left),
        #{game_activity_state := Game} = pump(Joined),
        ?assertEqual(200, map_size(maps:get(guild_leaves, Game))),
        ?assertEqual(200, gen_server:reqids_size(maps:get(guild_leave_requests, Game))),
        ?assertEqual(#{}, maps:get(guild_targets, Game)),
        ?assertEqual(#{}, maps:get(guild_resolving, Game)),
        no_guild_message(Guild)
    end).

t3_completed_lookup_wakes_budget_deferred_join_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild, 201 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        Game = maps:get(game_activity_state, S1),
        Targets = maps:from_list([
            {Id, {Guild, monitor(process, Guild)}}
         || Id <- lists:seq(1, 199)
        ]),
        Refs = maps:from_list([{Ref, Id} || {Id, {_Pid, Ref}} <- maps:to_list(Targets)]),
        Full = S1#{
            guild_ids => maps:from_keys(lists:seq(1, 200), true),
            game_activity_state => Game#{
                guild_targets => Targets,
                guild_refs => Refs,
                guild_resolving => #{200 => true}
            }
        },
        {reply, ok, Left} = presence_connect:handle_leave_guild(200, Full),
        {reply, ok, Joined} = presence_connect:handle_join_guild(201, Left),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, [201, '_'])),
        Completed = presence_game_activity:guild_resolved(200, {ok, Guild}, Joined),
        #{game_activity_state := Resolved} = pump(Completed),
        ?assert(maps:is_key(201, maps:get(guild_targets, Resolved))),
        ?assertEqual(1, meck:num_calls(guild_manager, lookup, [201, '_'])),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, [200, '_'])),
        {game_activity_publish, 1, _, _, _, _} = next_cast(Guild),
        set_guilds(#{10 => Guild}),
        {reply, ok, ErrorJoined} = presence_connect:handle_join_guild(201, Full),
        ErrorCompleted = presence_game_activity:guild_resolved(200, error, ErrorJoined),
        #{game_activity_state := Failed} = pump(ErrorCompleted),
        ?assertEqual(#{}, maps:get(guild_resolving, Failed)),
        ?assertEqual(#{201 => true}, maps:get(guild_deferred, Failed)),
        ?assertEqual([200], maps:keys(maps:get(guild_retries, Failed))),
        ?assertEqual(1, meck:num_calls(guild_manager, lookup, [201, '_'])),
        {reply, ok, Released} = presence_connect:handle_leave_guild(200, ErrorCompleted),
        #{game_activity_state := Retried} = pump(Released),
        ?assertEqual(#{}, maps:get(guild_deferred, Retried)),
        ?assertEqual([201], maps:keys(maps:get(guild_retries, Retried))),
        ?assertEqual(2, meck:num_calls(guild_manager, lookup, [201, '_'])),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, [200, '_'])),
        no_guild_message(Guild)
    end).

t3_guild_down_republishes_with_backoff_test_() ->
    {timeout, 10, fun guild_down_republishes_with_backoff/0}.

t3_failed_lookup_retries_and_recovers_test_() ->
    {timeout, 10, fun() ->
        with_owner(fun() ->
            S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
            ?assertEqual(1, meck:num_calls(guild_manager, lookup, [10, '_'])),
            Game1 = maps:get(game_activity_state, S1),
            ?assertEqual(1, map_size(maps:get(guild_retries, Game1, #{}))),
            {Timer, Token} = maps:get(guild_retry_timer, Game1),
            ?assert(is_integer(erlang:read_timer(Timer))),
            Guild = guild(ack),
            set_guilds(#{10 => Guild}),
            Retry =
                receive
                    {game_activity_guild_retry, Token} = Message -> Message
                after 3000 -> error(missing_lookup_retry)
                end,
            {noreply, S2} = presence:handle_info(Retry, S1),
            S3 = pump(S2),
            {game_activity_publish, 1, _, Alpha, _, _} = next_cast(Guild),
            ?assertEqual(<<"alpha">>, maps:get(<<"game_id">>, Alpha)),
            ?assertEqual(2, meck:num_calls(guild_manager, lookup, [10, '_'])),
            Game3 = maps:get(game_activity_state, S3),
            ?assertEqual(#{}, maps:get(guild_retries, Game3)),
            ?assertEqual(undefined, maps:get(guild_retry_timer, Game3)),
            _ = play(<<"alpha">>, S3),
            no_guild_message(Guild),
            ?assertEqual(2, meck:num_calls(guild_manager, lookup, [10, '_']))
        end)
    end}.

t3_lookup_retry_single_timer_cap_and_cancel_test() ->
    with_owner(fun() ->
        S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
            guild_ids => #{10 => true, 11 => true}
        }),
        Game1 = maps:get(game_activity_state, S1),
        ?assertEqual(2, map_size(maps:get(guild_retries, Game1, #{}))),
        {Timer1, _} = maps:get(guild_retry_timer, Game1),
        ?assertEqual(S1, presence_game_activity:join_guild(10, S1)),
        S2 = lists:foldl(
            fun(_, State) ->
                Game = maps:get(game_activity_state, State),
                {Timer, Token} = maps:get(guild_retry_timer, Game),
                erlang:cancel_timer(Timer),
                Now = erlang:monotonic_time(millisecond),
                Due = maps:map(
                    fun(_, Entry) -> Entry#{at => Now - 1} end, maps:get(guild_retries, Game)
                ),
                {noreply, Next} = presence:handle_info(
                    {game_activity_guild_retry, Token},
                    State#{game_activity_state => Game#{guild_retries => Due}}
                ),
                pump(Next)
            end,
            S1,
            lists:seq(1, 7)
        ),
        ?assertEqual(false, erlang:read_timer(Timer1)),
        Game2 = maps:get(game_activity_state, S2),
        ?assertEqual(#{10 => 30000, 11 => 30000}, maps:get(guild_retry_backoff, Game2)),
        Now = erlang:monotonic_time(millisecond),
        maps:foreach(
            fun(_, #{at := At}) ->
                ?assert(At - Now > 14000),
                ?assert(At - Now =< 30000)
            end,
            maps:get(guild_retries, Game2)
        ),
        {reply, ok, S3} = presence_connect:handle_leave_guild(10, S2),
        ?assertEqual(
            [11], maps:keys(maps:get(guild_retries, maps:get(game_activity_state, S3)))
        ),
        {Timer3, Token3} = maps:get(guild_retry_timer, maps:get(game_activity_state, S3)),
        {noreply, S4} = presence:handle_cast(
            {presence_update, #{session_id => <<"a">>, game_activity => null}}, S3
        ),
        Game4 = maps:get(game_activity_state, S4),
        ?assertEqual(#{}, maps:get(guild_retries, Game4)),
        ?assertEqual(#{}, maps:get(guild_retry_backoff, Game4)),
        ?assertEqual(undefined, maps:get(guild_retry_timer, Game4)),
        ?assertEqual(false, erlang:read_timer(Timer3)),
        ?assertEqual(
            {noreply, S4}, presence:handle_info({game_activity_guild_retry, Token3}, S4)
        )
    end).

t3_lookup_retries_share_target_budget_test() ->
    with_owner(fun() ->
        S1 = play(<<"alpha">>, (fixture(<<"everyone">>))#{
            guild_ids => maps:from_keys(lists:seq(1, 200), true)
        }),
        Game1 = maps:get(game_activity_state, S1),
        ?assertEqual(200, map_size(maps:get(guild_retries, Game1, #{}))),
        {reply, ok, S2} = presence_connect:handle_join_guild(201, S1),
        ?assertEqual(0, meck:num_calls(guild_manager, lookup, [201, '_'])),
        Guild = guild(ack),
        set_guilds(#{201 => Guild}),
        {reply, ok, S3} = presence_connect:handle_leave_guild(1, S2),
        Game3 = maps:get(game_activity_state, pump(S3)),
        ?assertEqual(199, map_size(maps:get(guild_retries, Game3))),
        ?assert(maps:is_key(201, maps:get(guild_targets, Game3))),
        ?assertEqual(1, meck:num_calls(guild_manager, lookup, [201, '_'])),
        _ = next_cast(Guild)
    end).

guild_down_republishes_with_backoff() ->
    with_owner(fun() ->
        Crashed = guild(ack),
        set_guilds(#{10 => Crashed}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Crashed),
        Restarted = guild(ack),
        set_guilds(#{10 => Restarted}),
        Crashed ! stop,
        Down =
            receive
                {'DOWN', _, process, Crashed, _} = D -> D
            after 1000 -> error(missing_guild_down)
            end,
        DownAt = erlang:monotonic_time(millisecond),
        {noreply, S2} = presence:handle_info(Down, S1),
        {_, Token} = maps:get(guild_retry_timer, maps:get(game_activity_state, S2)),
        Retry =
            receive
                {game_activity_guild_retry, Token} = R -> R
            after 5000 -> error(missing_guild_retry)
            end,
        ?assert(erlang:monotonic_time(millisecond) - DownAt >= 500),
        {noreply, S3} = presence:handle_info(Retry, S2),
        _ = pump(S3),
        {game_activity_publish, 1, _, Alpha, _, _} = next_cast(Restarted),
        ?assertEqual(<<"alpha">>, maps:get(<<"game_id">>, Alpha))
    end).

t3_rollout_close_publishes_null_test() ->
    with_owner(fun() ->
        Guild = guild(ack),
        set_guilds(#{10 => Guild}),
        S1 = play(<<"alpha">>, fixture(<<"everyone">>)),
        _ = next_cast(Guild),
        meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> false end),
        {noreply, _} = presence:handle_cast({game_activity_rollout, 1}, S1),
        {game_activity_publish, 1, _, null, _, _} = next_cast(Guild)
    end).

t3_friend_grant_allowed_with_everyone_test() ->
    State = (fixture(<<"everyone">>))#{friends => #{2 => true}},
    Game = maps:get(game_activity_state, State),
    Context = presence_game_activity_policy:context(2, Game),
    Grant = #{
        owner_id => <<"1">>,
        policy_revision => <<"0">>,
        request_nonce => maps:get(request_nonce, Game),
        allowed => true,
        friend => true,
        blocked => false,
        eligible_16_plus => true,
        profile_view => <<"full">>
    },
    ?assert(presence_game_activity_policy:grant_allowed(2, Context, Grant, Game, State)),
    ?assertNot(
        presence_game_activity_policy:grant_allowed(
            2, Context, Grant#{friend => false}, Game, State
        )
    ).

pair(Viewer, Blocked, State, Guild) ->
    Base = #{
        viewer_id => Viewer, request_id => <<"pair-", (integer_to_binary(Viewer))/binary>>
    },
    Tag = make_ref(),
    {noreply, Fenced} = presence:handle_call(
        {game_activity_control, pair, Base#{phase => <<"fence">>}}, {self(), Tag}, State
    ),
    {game_activity_exclude, 1, Viewer} = next_call(Guild),
    Acked = feed_guild_reply(Fenced),
    {noreply, Done} = presence:handle_info(barrier_done(3000), Acked),
    {ok, Ack} =
        receive
            {Tag, R} -> R
        after 500 -> error(missing_fence_ack)
        end,
    Apply = Base#{
        phase => <<"apply">>,
        owner_epoch => maps:get(<<"owner_epoch">>, Ack),
        pair_generation => maps:get(<<"pair_generation">>, Ack),
        blocked => Blocked
    },
    ApplyTag = make_ref(),
    {noreply, Applied} = presence:handle_call(
        {game_activity_control, pair, Apply}, {self(), ApplyTag}, Done
    ),
    {noreply, Final} = presence:handle_info(barrier_done(3000), Applied),
    receive
        {ApplyTag, {ok, _}} -> Final
    after 500 -> error(missing_apply_ack)
    end.

policy_game(Visibility) ->
    (presence_game_activity_policy:new())#{
        policy => #{
            visibility => Visibility,
            eligible_16_plus => true,
            effective_profile_audience => <<"friends">>
        }
    }.

fixture(Visibility) ->
    Game = (policy_game(Visibility))#{rollout_epoch => 0, rollout_generation => 0, tokens => 2},
    #{
        game_activity_state => Game,
        user_id => 1,
        user_data => #{<<"id">> => <<"1">>},
        is_bot => false,
        friends => #{},
        guild_ids => #{10 => true},
        temporary_guild_ids => #{},
        sessions => #{
            <<"a">> => #{
                status => online,
                afk => false,
                mobile => false,
                pid => self(),
                mref => make_ref()
            }
        },
        custom_status => null
    }.

with_policy(Changes, #{game_activity_state := Game} = State) ->
    State#{game_activity_state => Game#{policy => maps:merge(maps:get(policy, Game), Changes)}}.

fence(Id) ->
    #{phase => <<"fence">>, owner_epoch => null, request_id => Id, policy_revision => <<"1">>}.

play(GameId, State) ->
    Started = persistent_term:get({?MODULE, started}),
    Request = #{
        session_id => <<"a">>,
        status => online,
        game_activity => #{<<"game_id">> => GameId, <<"started_at">> => Started}
    },
    {noreply, Next} = presence:handle_cast({presence_update, Request}, State),
    pump(Next).

pump(State) ->
    receive
        {game_activity_guild_resolved, _, _} = Resolved ->
            {noreply, Next} = presence:handle_info(Resolved, State),
            pump(Next)
    after 150 -> State
    end.

feed_guild_reply(State) ->
    receive
        {[alias | _], _} = Reply ->
            {noreply, Next} = presence:handle_info(Reply, State),
            Next
    after 1000 -> error(missing_guild_reply)
    end.

barrier_done(Timeout) ->
    receive
        {game_activity_barrier_done, _, _} = Done -> Done
    after Timeout -> error(missing_barrier_done)
    end.

guild(Mode) ->
    Parent = self(),
    Pid = spawn(fun() -> guild_loop(Parent, Mode) end),
    put({?MODULE, guilds}, [Pid | get_guilds()]),
    Pid.

get_guilds() ->
    case get({?MODULE, guilds}) of
        undefined -> [];
        Pids -> Pids
    end.

guild_loop(Parent, Mode) ->
    receive
        {'$gen_cast', Message} ->
            Parent ! {guild, self(), cast, Message},
            guild_loop(Parent, Mode);
        {'$gen_call', From, Message} ->
            Parent ! {guild, self(), call, Message},
            guild_reply(Mode, From),
            guild_loop(Parent, Mode);
        stop ->
            ok
    after 15000 -> ok
    end.

guild_reply(ack, From) ->
    gen_server:reply(From, ok);
guild_reply(hold, From) ->
    receive
        {reply, Reply} -> gen_server:reply(From, Reply)
    after 5000 -> ok
    end;
guild_reply(silent, _From) ->
    ok.

next_cast(Guild) ->
    receive
        {guild, Guild, cast, Message} -> Message
    after 1000 -> error({missing_guild_cast, Guild})
    end.

next_call(Guild) ->
    receive
        {guild, Guild, call, Message} -> Message
    after 1000 -> error({missing_guild_call, Guild})
    end.

no_guild_message(Guild) ->
    receive
        {guild, Guild, _, Message} -> error({unexpected_guild_message, Message})
    after 200 -> ok
    end.

set_guilds(Pids) ->
    meck:expect(guild_manager, lookup, fun(GuildId, _Timeout) ->
        case maps:find(GuildId, Pids) of
            {ok, Pid} -> {ok, Pid};
            error -> {error, not_found}
        end
    end).

with_owner(Fun) ->
    persistent_term:put({?MODULE, started}, erlang:system_time(millisecond)),
    meck:new(gateway_rollout_config, [non_strict, no_link]),
    meck:new(gateway_dispatch_relay, [non_strict, no_link]),
    meck:new(guild_manager, [non_strict, no_link]),
    meck:new(presence_broadcast, [passthrough, no_link]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 0} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 0 end),
    meck:expect(gateway_dispatch_relay, dispatch_game_activity_many, fun(_, _) -> ok end),
    meck:expect(gateway_dispatch_relay, dispatch_many, fun(_, _, _, _) -> ok end),
    meck:expect(presence_broadcast, publish_global_presence, fun(_, State) -> State end),
    set_guilds(#{}),
    try
        Fun()
    after
        lists:foreach(fun(Pid) -> Pid ! stop end, get_guilds()),
        erase({?MODULE, guilds}),
        meck:unload([
            gateway_rollout_config, gateway_dispatch_relay, guild_manager, presence_broadcast
        ]),
        persistent_term:erase({?MODULE, started}),
        flush()
    end.

flush() ->
    receive
        _ -> flush()
    after 0 -> ok
    end.
