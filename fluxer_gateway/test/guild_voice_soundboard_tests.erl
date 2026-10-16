%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_voice_soundboard_tests).
-include_lib("eunit/include/eunit.hrl").

missing_actor_is_rejected_test() ->
    {reply, Reply, _} = guild_voice_server:handle_call(
        {play_soundboard_sound, request()},
        {self(), make_ref()},
        #{guild_id => 1, voice_states => #{}, soundboard_channels => #{}}
    ),
    ?assertEqual(#{success => false, error => <<"invalid_voice_state">>}, Reply).

soundboard_test_() ->
    {foreach, fun setup/0, fun cleanup/1, [
        fun channel_only_fanout/0,
        fun invalid_actor/0,
        fun recipient_lookup_does_not_block_owner/0,
        {timeout, 10, fun recipient_lookup_task_expires/0},
        fun local_rate_precedes_actor_validation/0,
        fun owner_rate_limit/0,
        fun cold_owner_blocks_refill_bypass/0,
        fun confirmed_reconnect_changes_epoch/0,
        fun pending_restore_emits_epoch/0,
        fun lifecycle_and_epoch/0,
        fun rate_refill_and_cleanup/0
    ]}.

setup() ->
    meck:new(session_manager, [non_strict, no_link]),
    meck:new(gateway_dispatch_relay, [non_strict, no_link]),
    meck:new(voice_state_counts_cache, [non_strict, no_link]),
    meck:new(guild_voice_broadcast, [non_strict, no_link]),
    meck:new(guild_voice_disconnect, [non_strict, no_link]),
    meck:new(guild_voice_connection_pending, [non_strict, no_link]),
    meck:new(rpc_client, [non_strict, no_link]),
    meck:expect(rpc_client, call, fun(_, _) ->
        erlang:error(unexpected_shared_limit_call)
    end),
    meck:expect(guild_voice_connection_pending, pending_voice_connections, fun(S) ->
        maps:get(pending_voice_connections, S, #{})
    end),
    meck:expect(guild_voice_disconnect, recently_disconnected_voice_states, fun(S) ->
        maps:get(recently_disconnected_voice_states, S, #{})
    end),
    meck:expect(guild_voice_broadcast, broadcast_voice_state_update, fun(VS, _, _) ->
        self() ! {voice_update, VS},
        ok
    end),
    meck:expect(voice_state_counts_cache, upsert_voice_state, fun(_) -> ok end),
    meck:expect(voice_state_counts_cache, remove_connection, fun(_) -> ok end),
    ok.

cleanup(_) -> meck:unload().

channel_only_fanout() ->
    with_guild(all_permissions(), fun(Guild) ->
        State = fixture(Guild),
        {reply, Reply, _} = play(request(), State),
        ?assertEqual(#{success => true}, Reply),
        Events = receive_dispatches(2),
        ?assertEqual(2, length(Events)),
        Recipients = lists:sort([
            maps:get(<<"recipient_connection_id">>, D)
         || {dispatch, [_], guild_soundboard_sound_play, D, 1} <- Events
        ]),
        ?assertEqual([<<"actor">>, <<"listener">>], Recipients),
        Lookups = drain(lookup),
        ?assertEqual(2, length(Lookups)),
        await_dispatch_tasks(Lookups),
        ?assertEqual([], drain(enumerated))
    end).

recipient_lookup_does_not_block_owner() ->
    Test = self(),
    with_guild(all_permissions(), fun(Guild) ->
        State = fixture(Guild),
        meck:expect(session_manager, lookup, fun
            (<<"actor-session">>) ->
                Test ! {lookup_blocked, self()},
                receive
                    continue -> {error, not_found}
                after 1000 -> {error, not_found}
                end;
            (_) ->
                {ok, Test}
        end),
        Started = erlang:monotonic_time(millisecond),
        {reply, Reply, _} = play(request(), State),
        ?assertEqual(#{success => true}, Reply),
        ?assert(erlang:monotonic_time(millisecond) - Started < 500),
        Worker =
            receive
                {lookup_blocked, Pid} ->
                    Pid ! continue,
                    Pid
            after 1000 ->
                ?assert(false)
            end,
        ?assertEqual(1, length(receive_dispatches(1))),
        await_dispatch_task(Worker)
    end).

local_rate_precedes_actor_validation() ->
    S = fixture(self()),
    {reply, #{success := false, error := <<"invalid_voice_state">>}, S1} =
        play((request())#{session_id => <<"stale">>}, S),
    {reply, #{success := false, error := <<"invalid_voice_state">>}, S1b} =
        play((request())#{session_id => <<"stale">>}, S1),
    {reply, #{success := false, error := <<"invalid_voice_state">>}, S1c} =
        play((request())#{session_id => <<"stale">>}, S1b),
    {reply, #{success := false, error := <<"invalid_voice_state">>}, S2} =
        play((request())#{session_id => <<"stale">>}, S1c),
    {reply, Reply, _} = play(request(), S2),
    ?assertEqual(#{success => false, error => <<"rate_limited">>}, Reply),
    ?assertEqual([], drain(lookup)),
    ?assertEqual([], drain(dispatch)).

recipient_lookup_task_expires() ->
    Test = self(),
    State = fixture(self()),
    meck:expect(session_manager, lookup, fun(_) ->
        Test ! {lookup_blocked, self()},
        receive
            continue -> {error, not_found}
        end
    end),
    {reply, #{success := true}, _} = play(request(), State),
    receive
        {lookup_blocked, Worker} ->
            Monitor = erlang:monitor(process, Worker),
            receive
                {'DOWN', Monitor, process, Worker, killed} -> ok
            after 6000 ->
                exit(Worker, kill),
                ?assert(false)
            end
    after 1000 ->
        ?assert(false)
    end,
    ?assertEqual([], drain(dispatch)).

invalid_actor() ->
    with_guild(all_permissions(), fun(Guild) ->
        S = fixture(Guild),
        lists:foreach(
            fun(R) ->
                {reply, Reply, _} = play(R, S),
                ?assertEqual(false, maps:get(success, Reply))
            end,
            [
                (request())#{guild_id => 2},
                (request())#{channel_id => 11},
                (request())#{session_id => <<"stale">>},
                (request())#{user_id => 999}
            ]
        ),
        lists:foreach(
            fun(Flag) ->
                VS = maps:get(voice_states, S),
                Actor = maps:get(<<"actor">>, VS),
                Muted = S#{voice_states => VS#{<<"actor">> => Actor#{Flag => true}}},
                {reply, Reply, _} = play(request(), Muted),
                ?assertEqual(false, maps:get(success, Reply))
            end,
            [<<"mute">>, <<"deaf">>, <<"self_deaf">>, <<"suppress">>]
        ),
        ?assertEqual([], drain(dispatch)),
        ?assertEqual([], drain(shared_limit))
    end).

owner_rate_limit() ->
    with_guild(all_permissions(), fun(Guild) ->
        {reply, #{success := true}, S1} = play(request(), fixture(Guild)),
        {reply, #{success := true}, S1b} = play(request(), S1),
        {reply, #{success := true}, S1c} = play(request(), S1b),
        {reply, #{success := true}, S2} = play(request(), S1c),
        {reply, Reply, _} = play(request(), S2),
        ?assertEqual(#{success => false, error => <<"rate_limited">>}, Reply),
        Replaced = guild_voice_server_state:merge_guild_state(
            #{voice_states => maps:get(voice_states, S2)}, S2
        ),
        {reply, SameReply, _} = play(request(), Replaced),
        ?assertEqual(Reply, SameReply),
        ?assertEqual(4, length(receive_dispatches(4))),
        await_dispatch_tasks(drain(lookup))
    end).

cold_owner_blocks_refill_bypass() ->
    with_guild(all_permissions(), fun(Guild) ->
        State = (fixture(Guild))#{
            soundboard_ready_at => erlang:monotonic_time(millisecond) + 5000
        },
        {reply, Reply, _} = play(request(), State),
        ?assertEqual(#{success => false, error => <<"rate_limited">>}, Reply),
        ?assertEqual([], drain(dispatch))
    end).

confirmed_reconnect_changes_epoch() ->
    VS = voice(20, <<"actor-session">>),
    State = #{
        voice_states => #{},
        pending_voice_connections => #{},
        recently_disconnected_voice_states => #{
            <<"actor">> => #{
                voice_state => VS,
                disconnected_at => erlang:system_time(millisecond)
            }
        }
    },
    {reply, #{success := true}, New} =
        guild_voice_connection_confirm:confirm_voice_connection_from_livekit(
            #{connection_id => <<"actor">>}, State
        ),
    Restored = maps:get(<<"actor">>, maps:get(voice_states, New)),
    ?assertEqual(2, maps:get(<<"soundboard_epoch">>, Restored)),
    ?assertEqual([{voice_update, Restored}], drain(voice_update)).

pending_restore_emits_epoch() ->
    meck:unload(guild_voice_connection_pending),
    meck:new(guild_voice_connection_util, [non_strict, no_link]),
    meck:expect(guild_voice_connection_util, clear_virtual_access_flags, fun(_, S) -> S end),
    VS = maps:remove(<<"soundboard_epoch">>, voice(20, <<"actor-session">>)),
    Pending = #{
        user_id => 20,
        channel_id => 10,
        voice_state => VS,
        expires_at => erlang:system_time(millisecond) + 5000
    },
    State = #{voice_states => #{}, pending_voice_connections => #{<<"actor">> => Pending}},
    {ok, Voices, _} = guild_voice_connection_pending:maybe_restore_pending_connection(
        <<"actor">>, 10, 20, #{}, State
    ),
    Restored = maps:get(<<"actor">>, Voices),
    ?assertEqual(1, maps:get(<<"soundboard_epoch">>, Restored, 0)),
    ?assertEqual([{voice_update, Restored}], drain(voice_update)).

lifecycle_and_epoch() ->
    S0 = fixture(self()),
    VS = maps:get(voice_states, S0),
    Actor = maps:get(<<"actor">>, VS),
    Moved = guild_voice_soundboard:with_epoch(Actor#{<<"channel_id">> => <<"11">>}, Actor),
    ?assert(maps:get(<<"soundboard_epoch">>, Moved) > maps:get(<<"soundboard_epoch">>, Actor)),
    S1 = guild_voice_server_state:apply_guild_state(
        #{voice_states => VS#{<<"actor">> => Moved}}, S0
    ),
    ?assertNot(maps:is_key(<<"actor">>, maps:get(<<"10">>, maps:get(soundboard_channels, S1)))),
    ?assert(maps:is_key(<<"actor">>, maps:get(<<"11">>, maps:get(soundboard_channels, S1)))),
    Back = guild_voice_soundboard:with_epoch(Moved#{<<"channel_id">> => <<"10">>}, Moved),
    ?assert(maps:get(<<"soundboard_epoch">>, Back) > maps:get(<<"soundboard_epoch">>, Moved)),
    S2 = guild_voice_server_state:apply_guild_state(#{voice_states => #{}}, S1),
    ?assertEqual(#{}, maps:get(soundboard_channels, S2)).

rate_refill_and_cleanup() ->
    S = fixture(self()),
    %% sanalyer: kullanıcı başına 4 patlama (5 sn'de 4 dolar), kanal başına 4 patlama (5 sn'de 8 dolar).
    {ok, S1} = guild_voice_soundboard:take_rate(20, <<"10">>, 10000, S),
    {ok, S2} = guild_voice_soundboard:take_rate(20, <<"10">>, 10000, S1),
    {ok, S3} = guild_voice_soundboard:take_rate(20, <<"10">>, 10000, S2),
    {ok, S4} = guild_voice_soundboard:take_rate(20, <<"10">>, 10000, S3),
    {error, _} = guild_voice_soundboard:take_rate(20, <<"10">>, 10000, S4),
    {ok, _} = guild_voice_soundboard:take_rate(20, <<"10">>, 12500, S4),
    {error, _} = guild_voice_soundboard:take_rate(21, <<"10">>, 10000, S4),
    {ok, _} = guild_voice_soundboard:take_rate(21, <<"10">>, 12500, S4),
    Clean = guild_voice_soundboard:sweep(16000, S4),
    ?assertEqual(#{}, maps:get(soundboard_rates, Clean)).

fixture(Guild) ->
    Test = self(),
    meck:expect(session_manager, lookup, fun(Session) ->
        Test ! {lookup, Session, self()},
        {ok, Test}
    end),
    meck:expect(gateway_dispatch_relay, dispatch_many, fun(Pids, Event, Data, GuildId) ->
        Test ! {dispatch, Pids, Event, Data, GuildId},
        ok
    end),
    Voices = #{
        <<"actor">> => voice(20, <<"actor-session">>),
        <<"listener">> => voice(21, <<"listener-session">>),
        <<"deaf">> => (voice(22, <<"deaf-session">>))#{<<"self_deaf">> => true}
    },
    guild_voice_soundboard:rebuild(#{
        guild_id => 1,
        guild_pid => Guild,
        member_count => 1000000,
        sessions => forbidden_to_enumerate,
        voice_states => Voices
    }).

voice(User, Session) ->
    #{
        <<"guild_id">> => <<"1">>,
        <<"channel_id">> => <<"10">>,
        <<"user_id">> => integer_to_binary(User),
        <<"session_id">> => Session,
        <<"soundboard_epoch">> => 1
    }.

play(Request, State) ->
    guild_voice_server:handle_call(
        {play_soundboard_sound, Request}, {self(), make_ref()}, State
    ).

all_permissions() -> 1024 bor 1048576 bor 2097152.

with_guild(Permissions, Fun) ->
    Test = self(),
    Guild = spawn(fun() -> guild_loop(Permissions, Test) end),
    try
        Fun(Guild)
    after
        Guild ! stop
    end.

guild_loop(Permissions, Test) ->
    receive
        {'$gen_call', From, {get_user_permissions, _}} ->
            Test ! {enumerated, true},
            gen_server:reply(From, #{permissions => Permissions}),
            guild_loop(Permissions, Test);
        {'$gen_call', From, _} ->
            Test ! {enumerated, true},
            gen_server:reply(From, #{}),
            guild_loop(Permissions, Test);
        stop ->
            ok
    end.

receive_dispatches(0) ->
    [];
receive_dispatches(Count) ->
    receive
        {dispatch, _, _, _, _} = Event -> [Event | receive_dispatches(Count - 1)]
    after 1000 ->
        ?assert(false)
    end.

await_dispatch_tasks(Lookups) ->
    Workers = lists:usort([Pid || {lookup, _, Pid} <- Lookups]),
    lists:foreach(fun await_dispatch_task/1, Workers).

await_dispatch_task(Worker) ->
    Monitor = erlang:monitor(process, Worker),
    receive
        {'DOWN', Monitor, process, Worker, Reason} ->
            ?assert(Reason =:= normal orelse Reason =:= noproc)
    after 1000 ->
        exit(Worker, kill),
        ?assert(false)
    end.

drain(Tag) ->
    receive
        Message when element(1, Message) =:= Tag -> [Message | drain(Tag)]
    after 0 -> []
    end.

request() ->
    #{
        guild_id => 1,
        channel_id => 10,
        user_id => 20,
        connection_id => <<"actor">>,
        session_id => <<"actor-session">>,
        sound_id => <<"30">>,
        event_id => <<"event">>,
        asset_version => <<"hash">>,
        volume => 1.0
    }.
