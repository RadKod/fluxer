%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_rate_limit_tests).
-include_lib("eunit/include/eunit.hrl").

five_updates_then_null_clears_test() ->
    State = exhaust_presence(),
    {ok, _} = send(#{<<"status">> => <<"online">>, <<"game_activity">> => null}, State),
    ?assertEqual({game_activity_clear}, receive_cast()).

null_does_not_bypass_status_limit_test() ->
    State = exhaust_presence(),
    {ok, _} = send(
        #{
            <<"status">> => <<"dnd">>,
            <<"afk">> => true,
            <<"custom_status">> => #{<<"text">> => <<"changed">>},
            <<"game_activity">> => null
        },
        State
    ),
    ?assertEqual({game_activity_clear}, receive_cast()),
    ?assertEqual(none, receive_cast()).

malformed_null_cannot_clear_test() ->
    State = exhaust_presence(),
    _ = send(#{<<"game_activity">> => null}, State),
    ?assertEqual(none, receive_cast()).

repeated_null_is_noop_test() ->
    State = exhaust_presence(),
    Data = #{<<"status">> => <<"online">>, <<"game_activity">> => null},
    {ok, State1} = send(Data, State),
    ?assertEqual({game_activity_clear}, receive_cast()),
    {ok, _} = send(Data, State1),
    ?assertEqual(none, receive_cast()).

general_limit_still_blocks_clear_test() ->
    State = exhaust_presence(),
    Now = erlang:system_time(millisecond),
    Full = State#{rate_limit_state => #{events => lists:duplicate(600, Now)}},
    {Frames, _} = send(#{<<"status">> => <<"online">>, <<"game_activity">> => null}, Full),
    ?assertMatch([{close, _, _}], Frames),
    ?assertEqual(none, receive_cast()).

normal_presence_and_voice_unchanged_test() ->
    State = exhaust_presence(),
    {ok, _} = send(#{<<"status">> => <<"dnd">>}, State),
    ?assertEqual(none, receive_cast()),
    ?assertMatch(
        {ok, _}, gateway_handler_rate_limit:check_rate_limit(State, voice_state_update)
    ).

exhaust_presence() ->
    os:unsetenv("FLUXER_DISABLE_RATE_LIMITS"),
    State = (gateway_handler:new_state())#{session_pid => self()},
    lists:foldl(
        fun(_, S) ->
            {ok, Next} = send(#{<<"status">> => <<"online">>}, S),
            ?assertMatch({presence_update, _}, receive_cast()),
            Next
        end,
        State,
        lists:seq(1, 5)
    ).

send(Data, State) ->
    Payload = iolist_to_binary(json:encode(#{<<"op">> => 3, <<"d">> => Data})),
    gateway_handler:websocket_handle({text, Payload}, State).

receive_cast() ->
    receive
        {'$gen_cast', Message} -> Message
    after 10 -> none
    end.
