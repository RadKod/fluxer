%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_guild_e2e_tests).
-include_lib("eunit/include/eunit.hrl").

%% Owner presence actor, guild game projection and the viewer session gate run together in
%% separate processes. The guild host runs the real guild callbacks on a guild state map
%% and its real broadcaster; it does not start a full guild process because that loads the
%% member list NIF, which no guild game activity path touches. Assertions read what each
%% viewer's socket receives.

-define(OWNER, 20).
-define(G1, 42).
-define(G2, 43).
-define(VIEW_ROLE, 1000).
-define(OTHER_ROLE, 2000).
-define(EPOCH, 7).
-define(ROLLOUT_KEY, gateway_rollout_config).
-define(GATE_KEY, {gateway_rollout_config, game_activity_gate}).
-define(DM_FLAG, dm_presence_mutual_context).

t7_everyone_reaches_subscribers_dm_partner_and_second_guild_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        ?assertEqual([{?G1, <<"alpha">>}], games(10, W)),
        ?assertEqual([{?G1, <<"alpha">>}], games(40, W)),
        ?assertEqual([{?G2, <<"alpha">>}], games(30, W)),
        ?assertEqual([], games(50, W)),
        ?assertEqual([{?G2, null}], games(60, W)),
        ?assertEqual([], [D || {_, D} <- wire(10, W), maps:is_key(game_activity_stamp, D)]),
        play(<<"alpha">>, W),
        ?assertEqual([], all_games(W))
    end).

t7_fence_ack_then_old_game_output_is_zero_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        {ok, Ack} = control(policy, fence_request(<<"close">>, <<"2">>), W),
        play(<<"alpha">>, W),
        play(<<"beta">>, W),
        {ok, _} = control(policy, apply_request(<<"close">>, <<"2">>, Ack), W),
        play(<<"gamma">>, W),
        After = all_games(W),
        lists:foreach(
            fun(Viewer) -> ?assertEqual([{?G1, null}], proplists:get_value(Viewer, After)) end,
            [10, 40]
        ),
        ?assertEqual([{?G2, null}], proplists:get_value(30, After)),
        ?assertEqual([], [G || {_, Gs} <- After, {_, G} <- Gs, G =/= null])
    end).

t7_fence_waits_queued_full_game_before_ack_test_() ->
    world_test(?FUNCTION_NAME, fun(W) -> queued_game_barrier(policy, W) end).

t7_pair_fence_waits_queued_full_game_before_ack_test_() ->
    world_test(?FUNCTION_NAME, fun(W) -> queued_game_barrier(pair, W) end).

queued_game_barrier(Kind, W) ->
    play(<<"alpha">>, W),
    _ = all_games(W),
    B = maps:get(broadcaster_pid, host_state(?G1, W)),
    ok = sys:suspend(B),
    try
        gen_server:cast(
            owner(W),
            {presence_update, #{
                session_id => <<"producer">>,
                status => online,
                game_activity => #{<<"game_id">> => <<"beta">>, <<"started_at">> => started(W)}
            }}
        ),
        _ = sys:get_state(owner(W)),
        _ = host_state(?G1, W),
        Request =
            case Kind of
                policy ->
                    fence_request(<<"queued-close">>, <<"2">>);
                pair ->
                    #{viewer_id => 10, phase => <<"fence">>, request_id => <<"queued-pair">>}
            end,
        Ref = async_control(Kind, Request, W),
        assert_control_waits(Ref),
        ok = sys:resume(B),
        ?assertMatch({ok, _}, control_reply(Ref)),
        assert_no_queued_full_game(B),
        flush_receivers(W),
        ?assertEqual([{?G1, <<"beta">>}, {?G1, null}], games(10, W)),
        case Kind of
            policy ->
                ?assertEqual([{?G1, <<"beta">>}, {?G1, null}], games(40, W)),
                ?assertEqual([{?G2, <<"beta">>}, {?G2, null}], games(30, W));
            pair ->
                ?assertEqual([{?G1, <<"beta">>}], games(40, W)),
                ?assertEqual([{?G2, <<"beta">>}], games(30, W))
        end
    after
        _ = sys:resume(B)
    end.

assert_no_queued_full_game(B) ->
    {messages, Pending} = process_info(B, messages),
    ?assertEqual([], [
        P
     || {'$gen_cast', {event_broadcast, presence_update, P, _}} <- Pending,
        maps:get(<<"game_activity">>, P, null) =/= null
    ]).

t7_owner_blocks_viewer_then_unblocks_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        pair(10, true, W),
        ?assertEqual([{?G1, null}], games(10, W)),
        play(<<"beta">>, W),
        ?assertEqual([], games(10, W)),
        ?assertEqual([{?G2, <<"beta">>}], games(30, W)),
        _ = all_games(W),
        pair(10, false, W),
        ?assertEqual({?G1, <<"beta">>}, lists:last(games(10, W))),
        ?assertEqual([], games(50, W))
    end).

t7_viewer_block_and_guild_leave_null_at_session_gate_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        session_apply(40, fun(S) -> S#{relationships => #{?OWNER => 2}} end, W),
        session_apply(
            10,
            fun(S) ->
                {noreply, Left} = session_guilds:handle_guild_leave(?G1, S),
                Left
            end,
            W
        ),
        _ = all_games(W),
        play(<<"beta">>, W),
        ?assertEqual([{?G1, null}], games(40, W)),
        ?assertEqual([{?G2, <<"beta">>}], games(30, W)),
        %% A presence for a guild the session no longer holds waits in the pending buffer;
        %% whenever it is flushed, the gate clears the game.
        ?assertEqual([], games(10, W)),
        session_apply(10, fun session_dispatch_presence:flush_all_pending_presences/1, W),
        settle(W),
        ?assertEqual([{?G1, null}], games(10, W))
    end).

t7_owner_leaves_guild_member_remove_first_test_() ->
    world_test(?FUNCTION_NAME, fun(W) -> owner_leaves(member_remove_first, W) end).

t7_owner_leaves_guild_presence_leave_first_test_() ->
    world_test(?FUNCTION_NAME, fun(W) -> owner_leaves(presence_leave_first, W) end).

t7_owner_left_guild_fence_before_member_remove_hides_old_game_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        host_cast(?G2, {update_member_subscriptions, sid(30), []}, W),
        _ = all_games(W),
        leave_g2(W),
        {ok, _} = control(policy, fence_request(<<"close">>, <<"2">>), W),
        host_cast(?G2, {update_member_subscriptions, sid(30), [?OWNER]}, W),
        ?assertEqual([], [G || {_, G} <- games(30, W), G =/= null])
    end).

t7_owner_left_guild_delayed_null_fence_waits_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(false, W, fun(Link) ->
            Ref = async_control(policy, fence_request(<<"delayed">>, <<"2">>), W),
            assert_control_waits(Ref),
            Link ! release,
            ?assertMatch({ok, _}, control_reply(Ref)),
            host_cast(?G2, {update_member_subscriptions, sid(30), [?OWNER]}, W),
            ?assertEqual([], [G || {_, G} <- games(30, W), G =/= null])
        end)
    end).

t7_owner_left_guild_delayed_prior_null_fence_waits_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(true, W, fun(Link) ->
            Ref = async_control(policy, fence_request(<<"prior-null">>, <<"2">>), W),
            assert_control_waits(Ref),
            Link ! release,
            ?assertMatch({ok, _}, control_reply(Ref)),
            host_cast(?G2, {update_member_subscriptions, sid(30), [?OWNER]}, W),
            ?assertEqual([], [G || {_, G} <- games(30, W), G =/= null])
        end)
    end).

t7_owner_left_guild_policy_and_pair_wait_same_revoke_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(false, W, fun(Link) ->
            Policy = async_control(policy, fence_request(<<"policy">>, <<"2">>), W),
            Pair = async_control(
                pair,
                #{
                    viewer_id => 30, phase => <<"fence">>, request_id => <<"pair-delayed">>
                },
                W
            ),
            assert_control_waits(Policy),
            assert_control_waits(Pair),
            Link ! release,
            ?assertMatch({ok, _}, control_reply(Policy)),
            ?assertMatch({ok, _}, control_reply(Pair))
        end)
    end).

t7_owner_left_guild_timeout_then_late_ack_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(false, W, fun(Link) ->
            Started = erlang:monotonic_time(millisecond),
            Ref = async_control(policy, fence_request(<<"timeout">>, <<"2">>), W),
            ?assertEqual({error, guild_timeout}, control_reply(Ref)),
            Elapsed = erlang:monotonic_time(millisecond) - Started,
            ?assert(Elapsed >= 1500 andalso Elapsed < 3500),
            Retry = async_control(
                pair,
                #{
                    viewer_id => 30, phase => <<"fence">>, request_id => <<"late-ack">>
                },
                W
            ),
            assert_control_waits(Retry),
            Link ! release,
            ?assertMatch({ok, _}, control_reply(Retry))
        end)
    end).

t7_owner_left_guild_down_releases_fence_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(false, W, fun(Link) ->
            Ref = async_control(policy, fence_request(<<"down">>, <<"2">>), W),
            assert_control_waits(Ref),
            exit(host(?G2, W), kill),
            ?assertMatch({ok, _}, control_reply(Ref)),
            #{game_activity_state := Game} = sys:get_state(owner(W)),
            ?assertEqual(#{}, maps:get(guild_leaves, Game)),
            ?assertEqual(0, gen_server:reqids_size(maps:get(guild_leave_requests, Game))),
            {monitors, Monitors} = process_info(owner(W), monitors),
            ?assertNot(lists:member({process, Link}, Monitors))
        end)
    end).

t7_owner_left_guild_rejoin_waits_revoke_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        with_delayed_leave(false, W, fun(Link) ->
            ok = gen_server:call(owner(W), {join_guild, ?G2}),
            play(<<"beta">>, W),
            ?assertEqual([], games(30, W)),
            Link ! release,
            settle(W),
            host_cast(?G2, {update_member_subscriptions, sid(30), [?OWNER]}, W),
            ?assertEqual({?G2, <<"beta">>}, lists:last(games(30, W)))
        end)
    end).

with_delayed_leave(PriorNull, W, Fun) ->
    play(<<"alpha">>, W),
    host_cast(?G2, {update_member_subscriptions, sid(30), []}, W),
    _ = all_games(W),
    Test = self(),
    Host = host(?G2, W),
    Link = spawn(fun() -> delayed_owner_link(Test, Host) end),
    _ = sys:replace_state(owner(W), fun(#{game_activity_state := Game} = S) ->
        Targets = maps:get(guild_targets, Game),
        {Host, Ref} = maps:get(?G2, Targets),
        S#{game_activity_state => Game#{guild_targets => Targets#{?G2 => {Link, Ref}}}}
    end),
    try
        case PriorNull of
            true ->
                gen_server:cast(
                    owner(W),
                    {presence_update, #{
                        session_id => <<"producer">>, game_activity => null
                    }}
                ),
                _ = sys:get_state(owner(W)),
                await_held(Link);
            false ->
                ok
        end,
        ok = gen_server:call(owner(W), {leave_guild, ?G2}),
        case PriorNull of
            false -> await_held(Link);
            true -> ok
        end,
        Fun(Link)
    after
        Link ! release,
        exit(Link, kill)
    end.

await_held(Link) ->
    receive
        {held_leave, Link} -> ok
    after 1000 -> error(missing_leave_revoke)
    end.

delayed_owner_link(Test, Host) ->
    receive
        {'$gen_cast', {game_activity_publish, _, _, null, _, _}} = Message ->
            Test ! {held_leave, self()},
            delayed_owner_link_hold(Host, [Message]);
        {'$gen_call', _, {game_activity_revoke, _, _}} = Message ->
            Test ! {held_leave, self()},
            delayed_owner_link_hold(Host, [Message]);
        Message ->
            Host ! Message,
            delayed_owner_link(Test, Host)
    end.

delayed_owner_link_hold(Host, Messages) ->
    receive
        release ->
            [Host ! M || M <- lists:reverse(Messages)],
            forward_owner_link(Host);
        Message ->
            delayed_owner_link_hold(Host, [Message | Messages])
    end.

forward_owner_link(Host) ->
    receive
        Message ->
            Host ! Message,
            forward_owner_link(Host)
    end.

async_control(Kind, Request, W) ->
    Test = self(),
    Ref = make_ref(),
    spawn(fun() ->
        Reply = gen_server:call(owner(W), {game_activity_control, Kind, Request}, 6000),
        Test ! {control_reply, Ref, Reply}
    end),
    Ref.

assert_control_waits(Ref) ->
    ?assertEqual(
        pending,
        receive
            {control_reply, Ref, Reply} -> Reply
        after 300 -> pending
        end
    ).

control_reply(Ref) ->
    receive
        {control_reply, Ref, Reply} -> Reply
    after 6000 -> error(missing_control_reply)
    end.

owner_leaves(Order, W) ->
    play(<<"alpha">>, W),
    _ = all_games(W),
    _ = host_log(?G2, W),
    Steps =
        case Order of
            member_remove_first -> [fun remove_owner_g2/1, fun leave_g2/1];
            presence_leave_first -> [fun leave_g2/1, fun remove_owner_g2/1]
        end,
    lists:foreach(fun(Step) -> Step(W) end, Steps),
    settle(W),
    ?assertEqual([{?G2, null}], games(30, W)),
    play(<<"beta">>, W),
    {ok, _} = control(policy, fence_request(<<"later">>, <<"2">>), W),
    ?assertEqual([], games(30, W)),
    ?assertEqual([{?G1, <<"beta">>}, {?G1, null}], games(10, W)),
    G2Messages = [M || M <- host_log(?G2, W), is_game_message(M)],
    ?assertMatch([{'$gen_call', _, {game_activity_revoke, ?OWNER, _}}], G2Messages).

t7_narrowing_and_unsubscribe_null_only_lost_interest_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        host_apply(?G1, fun(S) -> subscribe(sid(40), S) end, W),
        play(<<"alpha">>, W),
        _ = all_games(W),
        host_cast(?G1, {update_member_subscriptions, sid(40), []}, W),
        ?assertEqual([], games(40, W)),
        host_apply(
            ?G1,
            fun(S) ->
                Sessions = maps:get(sessions, S),
                Session = maps:get(sid(10), Sessions),
                Narrowed = S#{
                    sessions => Sessions#{
                        sid(10) => Session#{viewable_channels => #{600 => true}}
                    }
                },
                guild_maintenance:maybe_prune_invalid_member_subscriptions(
                    guild_role_update, Narrowed
                )
            end,
            W
        ),
        ?assertEqual([{?G1, null}], games(10, W)),
        ?assertEqual([], games(40, W))
    end).

t7_dm_eligibility_drop_nulls_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        host_apply(
            ?G1,
            fun(S0) ->
                S1 = with_member(member(?OWNER, [?OTHER_ROLE]), S0),
                guild_dm_partners:maybe_reevaluate(
                    guild_member_update, #{<<"user">> => #{<<"id">> => <<"20">>}}, S0, S1
                )
            end,
            W
        ),
        ?assertEqual([{?G1, null}], games(40, W))
    end).

t7_invisible_owner_nulls_everywhere_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        gen_server:cast(
            owner(W), {presence_update, #{session_id => <<"producer">>, status => invisible}}
        ),
        settle(W),
        Games = all_games(W),
        ?assertEqual([{?G1, null}], proplists:get_value(10, Games)),
        ?assertEqual([{?G2, null}], proplists:get_value(30, Games))
    end).

t7_owner_crash_nulls_everywhere_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        exit(owner(W), kill),
        settle(W),
        Games = all_games(W),
        ?assertEqual([{?G1, null}], proplists:get_value(10, Games)),
        ?assertEqual([{?G1, null}], proplists:get_value(40, Games)),
        ?assertEqual([{?G2, null}], proplists:get_value(30, Games))
    end).

t7_rollout_close_nulls_and_stale_entry_never_emitted_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        close_rollout(),
        gen_server:cast(owner(W), {game_activity_rollout, closed}),
        settle(W),
        Games = all_games(W),
        ?assertEqual([{?G1, null}], proplists:get_value(10, Games)),
        ?assertEqual([{?G2, null}], proplists:get_value(30, Games)),
        play(<<"beta">>, W),
        ?assertEqual([], all_games(W))
    end).

t7_guild_restart_republishes_current_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        Restarted = restart_host(?G1, W),
        receive
        after 2300 -> ok
        end,
        settle(W#{hosts => (maps:get(hosts, W))#{?G1 => Restarted}}),
        ?assertEqual([{?G1, <<"alpha">>}], games(10, W)),
        exit(Restarted, kill)
    end).

t7_replay_after_block_redacts_guild_scope_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        session_apply(
            10,
            fun(S) ->
                Socket = maps:get(socket_pid, S),
                Blocked = S#{relationships => #{?OWNER => 2}},
                {reply, {ok, Inline, _}, Resumed} = session_lifecycle:handle_resume(
                    0, Socket, Blocked
                ),
                [Socket ! {dispatch, E, D, Q} || #{event := E, data := D, seq := Q} <- Inline],
                Resumed
            end,
            W
        ),
        ?assertEqual([{?G1, null}], games(10, W))
    end).

t7_resubscribe_after_unsubscribe_keeps_game_test_() ->
    world_test(?FUNCTION_NAME, fun(W) ->
        play(<<"alpha">>, W),
        _ = all_games(W),
        Broadcaster = maps:get(broadcaster_pid, host_state(?G1, W)),
        ok = sys:suspend(Broadcaster),
        host_cast(?G1, {update_member_subscriptions, sid(10), []}, W),
        host_cast(?G1, {update_member_subscriptions, sid(10), [?OWNER]}, W),
        ok = sys:resume(Broadcaster),
        settle(W),
        Last = lists:last(games(10, W)),
        ?assertEqual({?G1, <<"alpha">>}, Last)
    end).

%% World

world_test(Name, Fun) ->
    {atom_to_list(Name), {timeout, 20, fun() -> with_world(Fun) end}}.

with_world(Fun) ->
    Test = self(),
    open_rollout(),
    ok = start_presence_services(),
    ok = presence_cache:put(?OWNER, presence(?OWNER)),
    _ = sys:get_state(presence_cache),
    Previous = application:get_env(fluxer_gateway, ?DM_FLAG),
    application:set_env(fluxer_gateway, ?DM_FLAG, true),
    meck:new(presence_broadcast, [passthrough, no_link]),
    meck:new(presence_broadcast_subscriptions, [passthrough, no_link]),
    meck:expect(
        presence_broadcast_subscriptions, ensure_initial_global_subscriptions, fun(S) -> S end
    ),
    meck:expect(presence_broadcast, publish_global_presence, fun(_, S) -> S end),
    meck:expect(
        presence_broadcast_subscriptions, send_cached_presences_to_session, fun(_, _) -> ok end
    ),
    meck:new(guild_manager, [non_strict, no_link]),
    Viewers = maps:from_list([{V, viewer(V, Test)} || V <- [10, 30, 40, 50, 60]]),
    G1 = start_host(?G1, [10, 40, 50], [10, 50], Viewers, Test),
    G2 = start_host(?G2, [30, 60], [30, 60], Viewers, Test),
    Hosts = #{?G1 => G1, ?G2 => G2},
    set_lookup(Hosts),
    W0 = #{viewers => Viewers, hosts => Hosts},
    [
        session_join(V, Host, W0)
     || {V, Host} <- [{10, G1}, {40, G1}, {50, G1}, {30, G2}, {60, G2}]
    ],
    gen_server:cast(G1, {update_dm_partners, sid(40), [?OWNER]}),
    Owner = start_owner(),
    W = W0#{owner => Owner, started => erlang:system_time(millisecond) - 60000},
    settle(W),
    _ = drain_wire(),
    try
        Fun(W)
    after
        exit(Owner, kill),
        [exit(P, kill) || P <- maps:values(Hosts)],
        [exit(P, kill) || #{session := S, socket := K} <- maps:values(Viewers), P <- [S, K]],
        meck:unload([presence_broadcast, presence_broadcast_subscriptions, guild_manager]),
        restore_flag(Previous),
        close_rollout(),
        _ = drain_wire()
    end.

start_owner() ->
    {ok, Owner} = gen_server:start(
        presence,
        #{
            user_id => ?OWNER,
            user_data => #{<<"id">> => <<"20">>, <<"username">> => <<"owner">>},
            guild_ids => [?G1, ?G2],
            friend_ids => [],
            status => online
        },
        []
    ),
    Producer = spawn(fun idle/0),
    {ok, _} = gen_server:call(
        Owner,
        {session_connect, #{
            session_id => <<"producer">>,
            session_pid => Producer,
            status => online,
            afk => false,
            mobile => false,
            socket_pid => undefined,
            game_activity_request_nonce => <<"start">>,
            game_activity_policy => #{
                policy_revision => <<"1">>,
                visibility => <<"everyone">>,
                eligible_16_plus => true,
                effective_profile_audience => <<"friends">>
            }
        }}
    ),
    gen_server:cast(Owner, {game_activity_blocked, [50]}),
    %% A fresh owner starts with an empty change budget; the tests do not wait 10 s for it.
    _ = sys:replace_state(Owner, fun(#{game_activity_state := Game} = S) ->
        S#{game_activity_state => Game#{tokens => 2}}
    end),
    Owner.

play(GameId, W) ->
    Request = #{
        session_id => <<"producer">>,
        status => online,
        game_activity => #{<<"game_id">> => GameId, <<"started_at">> => started(W)}
    },
    gen_server:cast(owner(W), {presence_update, Request}),
    settle(W).

control(Kind, Request, W) ->
    Broadcasters = [
        maps:get(broadcaster_pid, host_state(G, W), undefined)
     || G <- [?G1, ?G2], is_process_alive(host(G, W))
    ],
    Reply = gen_server:call(owner(W), {game_activity_control, Kind, Request}, 6000),
    case maps:get(phase, Request, undefined) of
        <<"fence">> ->
            [assert_no_queued_full_game(B) || B <- Broadcasters, is_pid(B)],
            flush_receivers(W);
        _ ->
            ok
    end,
    Reply.

fence_request(Id, Revision) ->
    #{phase => <<"fence">>, owner_epoch => null, request_id => Id, policy_revision => Revision}.

apply_request(Id, Revision, Ack) ->
    #{
        phase => <<"apply">>,
        owner_epoch => maps:get(<<"owner_epoch">>, Ack),
        request_id => Id,
        policy_revision => Revision,
        visibility => <<"friends">>,
        eligible_16_plus => true,
        effective_profile_audience => <<"friends">>
    }.

pair(Viewer, Blocked, W) ->
    Id = <<"pair-", (integer_to_binary(Viewer))/binary>>,
    {ok, Ack} = control(
        pair, #{viewer_id => Viewer, phase => <<"fence">>, request_id => Id}, W
    ),
    {ok, _} = control(
        pair,
        #{
            viewer_id => Viewer,
            phase => <<"apply">>,
            request_id => Id,
            owner_epoch => maps:get(<<"owner_epoch">>, Ack),
            pair_generation => maps:get(<<"pair_generation">>, Ack),
            blocked => Blocked
        },
        W
    ),
    settle(W).

remove_owner_g2(W) ->
    host_apply(
        ?G2,
        fun(S) ->
            guild_state:update_state(
                guild_member_remove, #{<<"user">> => #{<<"id">> => <<"20">>}}, S
            )
        end,
        W
    ).

leave_g2(W) ->
    gen_server:cast(owner(W), {leave_guild, ?G2}),
    settle(W).

is_game_message({'$gen_cast', {game_activity_publish, _, _, _, _, _}}) -> true;
is_game_message({'$gen_call', _, {game_activity_revoke, _, _}}) -> true;
is_game_message({'$gen_call', _, {game_activity_exclude, _, _}}) -> true;
is_game_message(_) -> false.

owner(#{owner := Owner}) -> Owner.

started(#{started := Started}) -> Started.

%% Guild host: the real guild callbacks over a guild state map.

start_host(GuildId, Members, Subscribers, Viewers, Test) ->
    State = guild_state(GuildId, Members, Subscribers, Viewers),
    spawn(fun() -> host_loop(GuildId, Test, State) end).

restart_host(GuildId, #{hosts := Hosts, viewers := Viewers} = W) ->
    exit(maps:get(GuildId, Hosts), kill),
    Host = start_host(GuildId, [10, 40, 50], [10, 50], Viewers, self()),
    set_lookup(Hosts#{GuildId => Host}),
    [
        session_apply(
            V,
            fun(S) -> S#{guilds => (maps:get(guilds, S))#{GuildId => {Host, make_ref()}}} end,
            W
        )
     || V <- [10, 40, 50]
    ],
    Host.

host_loop(GuildId, Test, State) ->
    receive
        {'$gen_call', From, {test_apply, Fun}} ->
            Next = Fun(State),
            gen_server:reply(From, ok),
            host_loop(GuildId, Test, Next);
        {'$gen_call', From, test_state} ->
            gen_server:reply(From, State),
            host_loop(GuildId, Test, State);
        {'$gen_call', From, Request} = Message ->
            Test ! {host, GuildId, Message},
            host_loop(GuildId, Test, host_reply(From, guild:handle_call(Request, From, State)));
        {'$gen_cast', Request} = Message ->
            Test ! {host, GuildId, Message},
            host_loop(GuildId, Test, host_state(guild:handle_cast(Request, State)));
        Info ->
            host_loop(GuildId, Test, host_state(guild:handle_info(Info, State)))
    end.

host_reply(From, {reply, Reply, State}) ->
    gen_server:reply(From, Reply),
    State;
host_reply(_From, Result) ->
    host_state(Result).

host_state({noreply, State}) -> State;
host_state({noreply, State, _}) -> State;
host_state({reply, _, State}) -> State.

host_apply(GuildId, Fun, W) ->
    ok = gen_server:call(host(GuildId, W), {test_apply, Fun}),
    settle(W).

host_cast(GuildId, Message, W) ->
    gen_server:cast(host(GuildId, W), Message),
    settle(W).

host_state(GuildId, W) ->
    gen_server:call(host(GuildId, W), test_state).

host(GuildId, #{hosts := Hosts}) -> maps:get(GuildId, Hosts).

host_log(GuildId, _W) ->
    receive_all(fun
        ({host, G, M}) when G =:= GuildId -> {true, M};
        (_) -> false
    end).

guild_state(GuildId, Members, Subscribers, Viewers) ->
    Channels = [channel(500, ?VIEW_ROLE), channel(600, ?OTHER_ROLE)],
    MemberMap = maps:from_list(
        [{7, member(7, [])}, {?OWNER, member(?OWNER, [?VIEW_ROLE])}] ++
            [{U, member(U, [?VIEW_ROLE])} || U <- Members]
    ),
    Sessions = maps:from_list([
        {sid(U), #{
            session_id => sid(U),
            user_id => U,
            pid => maps:get(session, maps:get(U, Viewers)),
            viewable_channels => #{500 => true},
            bot => false
        }}
     || U <- Members
    ]),
    Subs = lists:foldl(
        fun(U, Acc) -> guild_subscriptions:subscribe(sid(U), ?OWNER, Acc) end,
        guild_subscriptions:init_state(),
        Subscribers
    ),
    #{
        id => GuildId,
        disable_guild_count_cache_updates => true,
        disable_permission_cache_updates => true,
        virtual_channel_access => #{},
        data => #{
            <<"guild">> => #{<<"owner_id">> => <<"7">>},
            <<"roles">> => [role(GuildId), role(?VIEW_ROLE), role(?OTHER_ROLE)],
            <<"members">> => MemberMap,
            <<"channels">> => Channels,
            <<"channel_index">> => guild_data_index:build_id_index(Channels)
        },
        sessions => Sessions,
        member_subscriptions => Subs,
        member_presence => ets:new(game_e2e_presence, [set, public]),
        member_list_subscriptions => guild_member_list_subs:new(),
        dm_partners => #{}
    }.

subscribe(SessionId, State) ->
    State#{
        member_subscriptions => guild_subscriptions:subscribe(
            SessionId, ?OWNER, maps:get(member_subscriptions, State)
        )
    }.

with_member(Member, #{data := Data} = State) ->
    #{<<"user">> := #{<<"id">> := RawId}} = Member,
    Members = maps:get(<<"members">>, Data),
    State#{data => Data#{<<"members">> => Members#{binary_to_integer(RawId) => Member}}}.

set_lookup(Hosts) ->
    meck:expect(guild_manager, lookup, fun(GuildId, _Timeout) ->
        case maps:find(GuildId, Hosts) of
            {ok, Pid} -> {ok, Pid};
            error -> {error, not_found}
        end
    end).

%% Viewer: the real session dispatch path; its socket forwards what the client receives.

viewer(UserId, Test) ->
    Socket = spawn(fun() -> socket_loop(UserId, Test) end),
    Session = spawn(fun() -> session_loop(session_state(UserId, Socket)) end),
    #{session => Session, socket => Socket}.

session_state(UserId, Socket) ->
    #{
        id => sid(UserId),
        user_id => UserId,
        bot => false,
        seq => 0,
        ack_seq => 0,
        buffer => [],
        buffer_bytes => 0,
        status => online,
        afk => false,
        mobile => false,
        socket_pid => Socket,
        presence_pid => undefined,
        presence_mref => undefined,
        socket_mref => undefined,
        resume_timer => undefined,
        offline_timer => undefined,
        relationships => relationships(UserId),
        channels => #{},
        guilds => #{},
        suppress_presence_updates => false,
        pending_presences => []
    }.

relationships(60) -> #{?OWNER => 2};
relationships(_) -> #{}.

session_loop(State) ->
    receive
        {'$gen_cast', {dispatch, Event, Data}} ->
            {noreply, Next} = session_dispatch:handle_dispatch(Event, Data, State),
            session_loop(Next);
        {'$gen_call', From, {test_apply, Fun}} ->
            Next = Fun(State),
            gen_server:reply(From, ok),
            session_loop(Next);
        {'$gen_call', From, sync} ->
            gen_server:reply(From, ok),
            session_loop(State);
        _ ->
            session_loop(State)
    end.

session_join(UserId, Host, W) ->
    session_apply(
        UserId,
        fun(S) ->
            S#{guilds => (maps:get(guilds, S))#{guild_of(Host, W) => {Host, make_ref()}}}
        end,
        W
    ).

guild_of(Host, #{hosts := Hosts}) ->
    hd([G || {G, P} <- maps:to_list(Hosts), P =:= Host]).

session_apply(UserId, Fun, #{viewers := Viewers}) ->
    ok = gen_server:call(maps:get(session, maps:get(UserId, Viewers)), {test_apply, Fun}).

socket_loop(UserId, Test) ->
    receive
        {dispatch, Event, Data, _Seq} ->
            Test ! {wire, UserId, Event, Data},
            socket_loop(UserId, Test);
        {'$gen_call', From, sync} ->
            gen_server:reply(From, ok),
            socket_loop(UserId, Test);
        _ ->
            socket_loop(UserId, Test)
    end.

%% Settling: every hop is a FIFO process, so syncing them in delivery order flushes it.

settle(W) ->
    settle_once(W),
    settle_once(W).

settle_once(#{viewers := Viewers, hosts := Hosts} = W) ->
    receive
    after 60 -> ok
    end,
    sync_owner(W),
    Broadcasters = [
        B
     || Host <- maps:values(Hosts),
        is_process_alive(Host),
        B <- [maps:get(broadcaster_pid, gen_server:call(Host, test_state), undefined)],
        is_pid(B)
    ],
    [_ = sys:get_state(B) || B <- Broadcasters, is_process_alive(B)],
    [ok = gen_server:call(S, sync) || #{session := S} <- maps:values(Viewers)],
    [ok = gen_server:call(K, sync) || #{socket := K} <- maps:values(Viewers)],
    ok.

%% The barrier promises sends, so only the receiver mailboxes may still need processing.
flush_receivers(#{viewers := Viewers}) ->
    [ok = gen_server:call(S, sync) || #{session := S} <- maps:values(Viewers)],
    [ok = gen_server:call(K, sync) || #{socket := K} <- maps:values(Viewers)],
    ok.

sync_owner(#{owner := Owner}) ->
    case is_process_alive(Owner) of
        true -> _ = sys:get_state(Owner);
        false -> ok
    end;
sync_owner(_W) ->
    ok.

%% Reading the wire

games(UserId, _W) ->
    [
        {
            binary_to_integer(maps:get(<<"guild_id">>, D)),
            game_id(maps:get(<<"game_activity">>, D))
        }
     || {presence_update, D} <- wire_of(UserId),
        maps:is_key(<<"guild_id">>, D),
        maps:is_key(<<"game_activity">>, D)
    ].

all_games(W) ->
    Games = [{V, games(V, W)} || V <- [10, 30, 40, 50, 60]],
    [{V, G} || {V, G} <- Games, G =/= []].

wire(UserId, _W) ->
    wire_of(UserId).

wire_of(UserId) ->
    receive_all(fun
        ({wire, U, Event, Data}) when U =:= UserId -> {true, {Event, Data}};
        (_) -> false
    end).

game_id(null) -> null;
game_id(#{<<"game_id">> := GameId}) -> GameId.

receive_all(Match) ->
    {Kept, Matched} = receive_all(Match, [], []),
    [self() ! M || M <- Kept],
    Matched.

receive_all(Match, Kept, Matched) ->
    receive
        Message ->
            case Match(Message) of
                {true, Value} -> receive_all(Match, Kept, [Value | Matched]);
                false -> receive_all(Match, [Message | Kept], Matched)
            end
    after 0 -> {lists:reverse(Kept), lists:reverse(Matched)}
    end.

drain_wire() ->
    receive_all(fun
        ({wire, _, _, _}) -> {true, x};
        ({host, _, _}) -> {true, x};
        (_) -> false
    end).

%% Fixtures

sid(UserId) -> <<"s", (integer_to_binary(UserId))/binary>>.

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

open_rollout() ->
    persistent_term:put(?ROLLOUT_KEY, #{
        <<"game_activity_enabled">> => true, <<"game_activity_epoch">> => ?EPOCH
    }),
    persistent_term:put(?GATE_KEY, #{
        validated_at => erlang:monotonic_time(millisecond), epoch => ?EPOCH, generation => 1
    }).

close_rollout() ->
    _ = persistent_term:erase(?ROLLOUT_KEY),
    _ = persistent_term:erase(?GATE_KEY),
    ok.

restore_flag(undefined) -> application:unset_env(fluxer_gateway, ?DM_FLAG);
restore_flag({ok, Value}) -> application:set_env(fluxer_gateway, ?DM_FLAG, Value).

start_presence_services() ->
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

idle() ->
    receive
        stop -> ok
    after 60000 -> ok
    end.
