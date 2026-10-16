%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_push_engagement_tests).

-include_lib("eunit/include/eunit.hrl").

-define(GUILD_ID, 7000).
-define(CHANNEL_ID, 7100).
-define(USER, 10).
-define(AUTHOR, 20).
-define(MSG, 7200).
-define(GRACE_MS, 200).

desktop_active() ->
    #{status => online, afk => false, mobile => false}.

phone_backgrounded() ->
    #{status => online, afk => true, mobile => true}.

desktop_invisible() ->
    #{status => invisible, afk => false, mobile => false}.

user_data() ->
    #{<<"id">> => integer_to_binary(?USER), <<"username">> => <<"reader">>}.

published_presence(PresenceSessions) ->
    presence_payload:build(
        user_data(),
        presence_status:get_current_status(PresenceSessions),
        presence_status:get_flattened_mobile(PresenceSessions),
        presence_status:get_flattened_afk(PresenceSessions),
        null
    ).

guild_state(SessionPids) ->
    #{
        id => ?GUILD_ID,
        data => #{
            <<"guild">> => #{
                <<"id">> => ?GUILD_ID,
                <<"name">> => <<"Guild">>,
                <<"owner_id">> => ?USER,
                <<"default_message_notifications">> => 0
            },
            <<"members">> => #{?USER => #{<<"user">> => user_data(), <<"roles">> => []}},
            <<"channels">> => [#{<<"id">> => ?CHANNEL_ID, <<"name">> => <<"general">>}],
            <<"channel_index">> => #{
                ?CHANNEL_ID => #{<<"id">> => ?CHANNEL_ID, <<"name">> => <<"general">>}
            },
            <<"roles">> => [],
            <<"role_index">> => #{}
        },
        sessions => maps:map(
            fun(Sid, Pid) -> #{session_id => Sid, user_id => ?USER, pid => Pid} end,
            SessionPids
        ),
        member_presence => ets:new(test_member_presence, [set, public]),
        presence_subscriptions => #{?USER => 1},
        member_list_subscriptions => guild_member_list_subs:new()
    }.

apply_presence(PresenceSessions, State) ->
    {noreply, NewState} = guild_presence:handle_bus_presence(
        ?USER, published_presence(PresenceSessions), State
    ),
    NewState.

report_push_holds(PresenceSessions, State) ->
    maps:fold(fun report_push_hold/3, State, PresenceSessions).

report_push_hold(SessionId, PresenceSession, State) ->
    ok = session_lifecycle:send_guild_push_hold(
        {self(), make_ref()}, PresenceSession#{id => SessionId}
    ),
    receive
        {'$gen_cast', Msg} ->
            {noreply, NewState} = guild:handle_cast(Msg, State),
            NewState
    after 1000 -> error(no_push_hold_reported)
    end.

apply_session_presence(PresenceSessions, State) ->
    report_push_holds(PresenceSessions, apply_presence(PresenceSessions, State)).

guild_message() ->
    #{
        <<"id">> => integer_to_binary(?MSG),
        <<"channel_id">> => integer_to_binary(?CHANNEL_ID),
        <<"author">> => #{<<"id">> => integer_to_binary(?AUTHOR)},
        <<"content">> => <<"hi">>
    }.

dm_message() ->
    #{
        <<"id">> => integer_to_binary(?MSG),
        <<"channel_id">> => <<"5">>,
        <<"channel_type">> => 1,
        <<"author">> => #{<<"id">> => integer_to_binary(?AUTHOR)},
        <<"content">> => <<"hi">>
    }.

desktop_away() ->
    #{status => online, afk => true, mobile => false}.

desktop_offline() ->
    #{status => offline, afk => false, mobile => false}.

fake_guild(State) ->
    spawn(fun() -> fake_guild_loop(State) end).

fake_guild_loop(State) ->
    receive
        {'$gen_call', From, Request} ->
            {reply, Reply, State} = guild:handle_call(Request, From, State),
            gen_server:reply(From, Reply),
            fake_guild_loop(State);
        {set_state, NewState} ->
            fake_guild_loop(NewState);
        stop ->
            ok
    end.

send_held_message(State) ->
    Guild = fake_guild(State),
    ok = guild_dispatch_push:collect_and_send_push_notifications(
        guild_message(), ?GUILD_ID, State#{guild_pid => Guild}
    ),
    Guild.

idle_session() ->
    spawn(fun() ->
        receive
            stop -> ok
        end
    end).

with_push_spy(Fun) ->
    Self = self(),
    Previous = application:get_env(fluxer_gateway, guild_push_offline_grace_recheck_ms),
    ok = application:set_env(fluxer_gateway, guild_push_offline_grace_recheck_ms, ?GRACE_MS),
    %% sanalyer: these tests pin the offline grace alone; with the unread grace
    %% off no hold outlives the test and leaks a push into a later one.
    PreviousUnread = application:get_env(fluxer_gateway, push_unread_grace_ms),
    ok = application:set_env(fluxer_gateway, push_unread_grace_ms, 0),
    ok = meck:new(push, [passthrough, no_link]),
    try
        ok = meck:expect(push, handle_message_create, fun(Params) ->
            Self ! {pushed, maps:get(user_ids, Params)},
            ok
        end),
        Fun()
    after
        meck:unload(push),
        case Previous of
            {ok, Value} ->
                application:set_env(fluxer_gateway, guild_push_offline_grace_recheck_ms, Value);
            undefined ->
                application:unset_env(fluxer_gateway, guild_push_offline_grace_recheck_ms)
        end,
        case PreviousUnread of
            {ok, Unread} -> application:set_env(fluxer_gateway, push_unread_grace_ms, Unread);
            undefined -> application:unset_env(fluxer_gateway, push_unread_grace_ms)
        end
    end.

immediate_pushes() ->
    receive
        {pushed, UserIds} -> [UserIds | immediate_pushes()]
    after 0 -> []
    end.

push_within(Ms) ->
    receive
        {pushed, UserIds} -> UserIds
    after Ms -> none
    end.

desktop_plus_backgrounded_phone_still_publishes_online_mobile_not_afk_test() ->
    PresenceSessions = #{
        <<"desktop">> => desktop_active(), <<"phone">> => phone_backgrounded()
    },
    Payload = published_presence(PresenceSessions),
    ?assertEqual(<<"online">>, maps:get(<<"status">>, Payload)),
    ?assertEqual(true, maps:get(<<"mobile">>, Payload)),
    ?assertEqual(false, maps:get(<<"afk">>, Payload)),
    ?assertEqual(
        {ok, Payload},
        presence_broadcast:current_visible_presence(#{
            sessions => PresenceSessions, user_data => user_data(), custom_status => null
        })
    ).

guild_message_is_held_through_grace_for_a_user_active_on_desktop_with_a_backgrounded_phone_test() ->
    Desktop = idle_session(),
    Phone = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop, <<"phone">> => Phone}),
    try
        with_push_spy(fun() ->
            State = apply_session_presence(
                #{<<"desktop">> => desktop_active(), <<"phone">> => phone_backgrounded()},
                State0
            ),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            ?assertEqual(none, push_within(?GRACE_MS * 3)),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_is_held_through_grace_for_a_user_active_on_desktop_only_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_push_spy(fun() ->
            State = apply_presence(#{<<"desktop">> => desktop_active()}, State0),
            ok = guild_dispatch_push:collect_and_send_push_notifications(
                guild_message(), ?GUILD_ID, State
            ),
            ?assertEqual([], immediate_pushes()),
            Desktop ! stop,
            ?assertEqual([?USER], push_within(?GRACE_MS * 10))
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

invisible_desktop_is_published_as_offline_test() ->
    Payload = published_presence(#{<<"desktop">> => desktop_invisible()}),
    ?assertEqual(<<"offline">>, maps:get(<<"status">>, Payload)),
    ?assertEqual(
        not_found,
        presence_broadcast:current_visible_presence(#{
            sessions => #{<<"desktop">> => desktop_invisible()},
            user_data => user_data(),
            custom_status => null
        })
    ).

guild_message_to_a_user_on_desktop_with_a_backgrounded_phone_is_released_when_the_desktop_ends_test() ->
    Desktop = idle_session(),
    Phone = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop, <<"phone">> => Phone}),
    try
        with_push_spy(fun() ->
            State = apply_session_presence(
                #{<<"desktop">> => desktop_active(), <<"phone">> => phone_backgrounded()},
                State0
            ),
            ok = guild_dispatch_push:collect_and_send_push_notifications(
                guild_message(), ?GUILD_ID, State
            ),
            ?assertEqual([], immediate_pushes()),
            Desktop ! stop,
            ?assertEqual([?USER], push_within(?GRACE_MS * 10))
        end)
    after
        Desktop ! stop,
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_is_pushed_immediately_to_a_user_on_a_backgrounded_phone_only_test() ->
    Phone = idle_session(),
    State0 = guild_state(#{<<"phone">> => Phone}),
    try
        with_push_spy(fun() ->
            State = apply_session_presence(#{<<"phone">> => phone_backgrounded()}, State0),
            ok = guild_dispatch_push:collect_and_send_push_notifications(
                guild_message(), ?GUILD_ID, State
            ),
            ?assertEqual([[?USER]], immediate_pushes())
        end)
    after
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_is_held_through_grace_for_a_user_active_on_an_invisible_desktop_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_push_spy(fun() ->
            Online = apply_session_presence(#{<<"desktop">> => desktop_active()}, State0),
            State = apply_session_presence(#{<<"desktop">> => desktop_invisible()}, Online),
            ?assertMatch(
                #{<<"status">> := <<"offline">>},
                guild_state_member:lookup_presence(maps:get(member_presence, State), ?USER)
            ),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            ?assertEqual(none, push_within(?GRACE_MS * 3)),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

dm_path_buffers_the_push_for_an_active_invisible_desktop_test() ->
    with_push_spy(fun() ->
        State = presence_update:handle_message_create_event(dm_message(), #{
            user_id => ?USER,
            sessions => #{<<"desktop">> => desktop_invisible()},
            push_buffer => []
        }),
        ?assertEqual(1, length(maps:get(push_buffer, State))),
        ?assertEqual([], immediate_pushes())
    end).

dm_path_buffers_the_push_for_an_active_desktop_with_a_backgrounded_phone_test() ->
    with_push_spy(fun() ->
        State = presence_update:handle_message_create_event(dm_message(), #{
            user_id => ?USER,
            sessions => #{
                <<"desktop">> => desktop_active(), <<"phone">> => phone_backgrounded()
            },
            push_buffer => []
        }),
        ?assertEqual(1, length(maps:get(push_buffer, State))),
        ?assertEqual([], immediate_pushes())
    end).

session_reports_a_push_hold_change_to_its_guilds_test() ->
    Base = #{
        id => <<"desktop">>,
        status => online,
        afk => false,
        mobile => false,
        presence_pid => undefined,
        guilds => #{?GUILD_ID => {self(), make_ref()}}
    },
    {noreply, Afk} = session_lifecycle:handle_presence_update_cast(#{afk => true}, Base),
    ?assertEqual(
        [{set_session_push_hold, <<"desktop">>, false}], received_casts()
    ),
    {noreply, _Idle} = session_lifecycle:handle_presence_update_cast(#{status => idle}, Afk),
    ?assertEqual([], received_casts()),
    {noreply, _Back} = session_lifecycle:handle_presence_update_cast(
        #{afk => false, status => invisible}, Afk
    ),
    ?assertEqual(
        [{set_session_push_hold, <<"desktop">>, true}], received_casts()
    ).

a_foreground_phone_never_holds_guild_pushes_test() ->
    ?assertEqual(
        [{set_session_push_hold, <<"phone">>, false}],
        reported_push_hold(#{id => <<"phone">>, status => online, afk => false, mobile => true})
    ).

a_dnd_desktop_holds_guild_pushes_test() ->
    ?assertEqual(
        [{set_session_push_hold, <<"desktop">>, true}],
        reported_push_hold(#{id => <<"desktop">>, status => dnd, afk => false, mobile => false})
    ).

a_bot_session_never_reports_a_push_hold_test() ->
    ?assertEqual(
        [],
        reported_push_hold(#{
            id => <<"bot">>, status => online, afk => false, mobile => false, bot => true
        })
    ).

a_desktop_back_from_afk_on_dnd_holds_guild_pushes_again_test() ->
    Base = #{
        id => <<"desktop">>,
        status => online,
        afk => true,
        mobile => false,
        presence_pid => undefined,
        guilds => #{?GUILD_ID => {self(), make_ref()}}
    },
    {noreply, _Dnd} = session_lifecycle:handle_presence_update_cast(
        #{afk => false, status => dnd}, Base
    ),
    ?assertEqual([{set_session_push_hold, <<"desktop">>, true}], received_casts()).

only_sessions_that_reported_no_hold_are_released_at_grace_test() ->
    State = #{
        sessions => #{
            <<"released">> => #{push_hold => false},
            <<"holding">> => #{push_hold => true},
            <<"never_reported">> => #{}
        }
    },
    ?assertEqual(
        [<<"released">>],
        guild_sessions:released_push_holds(
            [<<"released">>, <<"holding">>, <<"never_reported">>, <<"gone">>], State
        )
    ).

reported_push_hold(Session) ->
    ok = session_lifecycle:send_guild_push_hold({self(), make_ref()}, Session),
    received_casts().

received_casts() ->
    receive
        {'$gen_cast', Msg} -> [Msg | received_casts()]
    after 0 -> []
    end.

guild_message_to_a_user_on_desktop_with_a_backgrounded_phone_is_released_when_the_desktop_stops_holding_test() ->
    Desktop = idle_session(),
    Phone = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop, <<"phone">> => Phone}),
    try
        with_push_spy(fun() ->
            State = apply_session_presence(
                #{<<"desktop">> => desktop_active(), <<"phone">> => phone_backgrounded()},
                State0
            ),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            Guild ! {set_state, report_push_hold(<<"desktop">>, desktop_offline(), State)},
            ?assertEqual([?USER], push_within(?GRACE_MS * 10)),
            ?assert(is_process_alive(Desktop)),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_to_a_user_on_an_invisible_desktop_is_released_when_the_desktop_goes_afk_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_push_spy(fun() ->
            State = apply_session_presence(#{<<"desktop">> => desktop_invisible()}, State0),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            Guild ! {set_state, report_push_hold(<<"desktop">>, desktop_away(), State)},
            ?assertEqual([?USER], push_within(?GRACE_MS * 10)),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

manually_idle_desktop_does_not_hold_guild_pushes_test() ->
    Base = #{
        id => <<"desktop">>,
        status => online,
        afk => false,
        mobile => false,
        presence_pid => undefined,
        guilds => #{?GUILD_ID => {self(), make_ref()}}
    },
    {noreply, _Idle} = session_lifecycle:handle_presence_update_cast(#{status => idle}, Base),
    ?assertEqual([{set_session_push_hold, <<"desktop">>, false}], received_casts()).

%% sanalyer: unread grace. A desktop that stays active no longer swallows the
%% push for good: after the unread grace the push goes out if the read state
%% still shows the message unread.

-define(UNREAD_GRACE_MS, 600).

phone_foreground() ->
    #{status => online, afk => false, mobile => true}.

with_unread_grace(ReadMessageId, Fun) ->
    with_unread_grace(ReadMessageId, #{}, Fun).

with_unread_grace(ReadMessageId, Env, Fun) ->
    Self = self(),
    Settings = maps:merge(
        #{
            guild_push_offline_grace_recheck_ms => ?GRACE_MS,
            push_unread_grace_ms => ?UNREAD_GRACE_MS
        },
        Env
    ),
    Previous = maps:map(fun(Key, _) -> application:get_env(fluxer_gateway, Key) end, Settings),
    maps:foreach(
        fun(Key, Value) -> application:set_env(fluxer_gateway, Key, Value) end, Settings
    ),
    Modules = [push, fluxer_gateway_env, gateway_node_router, rpc_client],
    lists:foreach(fun(Module) -> ok = meck:new(Module, [passthrough, no_link]) end, Modules),
    try
        ok = meck:expect(push, handle_message_create, fun(Params) ->
            Self ! {pushed, maps:get(user_ids, Params)},
            ok
        end),
        ok = meck:expect(fluxer_gateway_env, get, fun
            (push_enabled) -> true;
            (Key) -> meck:passthrough([Key])
        end),
        %% Pushes released by push:publish_still_unread/1 reach the owner lookup.
        ok = meck:expect(gateway_node_router, owner_node_result, fun(UserId, push) ->
            Self ! {pushed, [UserId]},
            {error, test}
        end),
        ok = meck:expect(rpc_client, call, fun(Request, _Timeout) ->
            Self ! {read_state, maps:get(<<"type">>, Request)},
            {ok, #{<<"last_message_id">> => integer_to_binary(ReadMessageId)}}
        end),
        Fun()
    after
        lists:foreach(fun meck:unload/1, lists:reverse(Modules)),
        maps:foreach(
            fun
                (Key, {ok, Value}) -> application:set_env(fluxer_gateway, Key, Value);
                (Key, undefined) -> application:unset_env(fluxer_gateway, Key)
            end,
            Previous
        )
    end.

read_state_requests() ->
    receive
        {read_state, Type} -> [Type | read_state_requests()]
    after 0 -> []
    end.

guild_message_is_pushed_right_away_when_every_desktop_session_is_afk_test() ->
    Desktop = idle_session(),
    Phone = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop, <<"phone">> => Phone}),
    try
        with_unread_grace(0, fun() ->
            State = apply_session_presence(
                #{<<"desktop">> => desktop_away(), <<"phone">> => phone_foreground()},
                State0
            ),
            ok = guild_dispatch_push:collect_and_send_push_notifications(
                guild_message(), ?GUILD_ID, State
            ),
            ?assertEqual([[?USER]], immediate_pushes())
        end)
    after
        Desktop ! stop,
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_is_pushed_right_away_to_a_user_on_a_foreground_phone_only_test() ->
    Phone = idle_session(),
    State0 = guild_state(#{<<"phone">> => Phone}),
    try
        with_unread_grace(0, fun() ->
            State = apply_session_presence(#{<<"phone">> => phone_foreground()}, State0),
            ok = guild_dispatch_push:collect_and_send_push_notifications(
                guild_message(), ?GUILD_ID, State
            ),
            ?assertEqual([[?USER]], immediate_pushes())
        end)
    after
        Phone ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_unread_on_an_active_desktop_is_pushed_after_the_unread_grace_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_unread_grace(?MSG - 1, fun() ->
            State = apply_session_presence(#{<<"desktop">> => desktop_active()}, State0),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            %% Still held after the offline grace: the desktop is active.
            ?assertEqual(none, push_within(?GRACE_MS * 2)),
            ?assertEqual([?USER], push_within(?UNREAD_GRACE_MS * 3)),
            ?assertEqual([<<"get_read_state">>], read_state_requests()),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_message_read_on_the_desktop_inside_the_unread_grace_is_dropped_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_unread_grace(?MSG, fun() ->
            State = apply_session_presence(#{<<"desktop">> => desktop_active()}, State0),
            Guild = send_held_message(State),
            ?assertEqual([], immediate_pushes()),
            ?assertEqual(none, push_within(?UNREAD_GRACE_MS * 3)),
            ?assertEqual([<<"get_read_state">>], read_state_requests()),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

guild_unread_grace_holds_past_the_cap_fall_back_to_dropping_test() ->
    Desktop = idle_session(),
    State0 = guild_state(#{<<"desktop">> => Desktop}),
    try
        with_unread_grace(0, #{guild_push_unread_grace_max_holds => 0}, fun() ->
            State = apply_session_presence(#{<<"desktop">> => desktop_active()}, State0),
            Guild = send_held_message(State),
            ?assertEqual(none, push_within(?UNREAD_GRACE_MS * 3)),
            ?assertEqual([], read_state_requests()),
            ?assertMatch(
                #{unread_grace_overflow := N} when N > 0, guild_dispatch_push:push_counters()
            ),
            Guild ! stop
        end)
    after
        Desktop ! stop,
        ets:delete(maps:get(member_presence, State0))
    end.

dm_path_pushes_right_away_when_every_desktop_session_is_afk_test() ->
    with_unread_grace(0, fun() ->
        State = presence_update:handle_message_create_event(dm_message(), #{
            user_id => ?USER,
            sessions => #{
                <<"desktop">> => desktop_away(), <<"phone">> => phone_foreground()
            },
            push_buffer => []
        }),
        ?assertEqual([], maps:get(push_buffer, State)),
        ?assertEqual([[?USER]], immediate_pushes())
    end).

dm_path_pushes_right_away_to_a_user_on_a_foreground_phone_only_test() ->
    with_unread_grace(0, fun() ->
        State = presence_update:handle_message_create_event(dm_message(), #{
            user_id => ?USER,
            sessions => #{<<"phone">> => phone_foreground()},
            push_buffer => []
        }),
        ?assertEqual([], maps:get(push_buffer, State)),
        ?assertEqual([[?USER]], immediate_pushes())
    end).

dm_path_arms_one_unread_grace_timer_for_a_burst_test() ->
    with_unread_grace(0, fun() ->
        Base = #{
            user_id => ?USER,
            sessions => #{<<"desktop">> => desktop_active()},
            push_buffer => []
        },
        State1 = presence_update:handle_message_create_event(dm_message(), Base),
        Timer = maps:get(push_unread_grace_timer, State1),
        Second = (dm_message())#{<<"id">> => integer_to_binary(?MSG + 1)},
        State2 = presence_update:handle_message_create_event(Second, State1),
        ?assertEqual(Timer, maps:get(push_unread_grace_timer, State2)),
        ?assertEqual(2, length(maps:get(push_buffer, State2))),
        ?assertEqual([], immediate_pushes()),
        _ = erlang:cancel_timer(Timer)
    end).
