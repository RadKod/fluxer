%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(guild_voice_soundboard).
-typing([eqwalizer]).

-export([play/2, rebuild/1, sync/2, with_epoch/2, take_rate/4, sweep/2]).

-spec play(map(), map()) -> {reply, map(), map()}.
play(Request, State) ->
    Now = erlang:monotonic_time(millisecond),
    Channel = integer_to_binary(maps:get(channel_id, Request)),
    case take_rate(maps:get(user_id, Request), Channel, Now, State) of
        {error, S} ->
            reject(<<"rate_limited">>, S);
        {ok, S} ->
            case Now < maps:get(soundboard_ready_at, S, Now) of
                true ->
                    reject(<<"rate_limited">>, S);
                false ->
                    ConnectionId = maps:get(connection_id, Request),
                    VoiceState = maps:get(ConnectionId, maps:get(voice_states, S, #{}), #{}),
                    case valid_actor(Request, VoiceState, S) of
                        false ->
                            reject(<<"invalid_voice_state">>, S);
                        true ->
                            dispatch(Request, Channel, S),
                            {reply, #{success => true}, S}
                    end
            end
    end.

-spec valid_actor(map(), map(), map()) -> boolean().
valid_actor(R, VS, State) ->
    maps:get(guild_id, R) =:= maps:get(guild_id, State) andalso
        maps:get(<<"guild_id">>, VS, undefined) =:= integer_to_binary(maps:get(guild_id, R)) andalso
        maps:get(<<"channel_id">>, VS, undefined) =:= integer_to_binary(maps:get(channel_id, R)) andalso
        maps:get(<<"user_id">>, VS, undefined) =:= integer_to_binary(maps:get(user_id, R)) andalso
        maps:get(<<"session_id">>, VS, undefined) =:= maps:get(session_id, R) andalso
        eligible(VS).

-spec eligible(map()) -> boolean().
eligible(VS) ->
    is_binary(maps:get(<<"session_id">>, VS, undefined)) andalso
        lists:all(
            fun(Key) -> maps:get(Key, VS, false) =:= false end,
            %% sanalyer: kendi mikrofonunu kapatan da ses çalabilir ve duyabilir; sesler dinleyicide karışır.
            [<<"mute">>, <<"deaf">>, <<"self_deaf">>, <<"suppress">>]
        ).

-spec reject(binary(), map()) -> {reply, map(), map()}.
reject(Error, State) -> {reply, #{success => false, error => Error}, State}.

-spec dispatch(map(), binary(), map()) -> ok.
dispatch(R, Channel, State) ->
    GuildId = maps:get(guild_id, State),
    Event = #{
        <<"guild_id">> => integer_to_binary(GuildId),
        <<"channel_id">> => Channel,
        <<"actor_id">> => integer_to_binary(maps:get(user_id, R)),
        <<"session_id">> => maps:get(session_id, R),
        <<"sound_id">> => maps:get(sound_id, R),
        <<"event_id">> => maps:get(event_id, R),
        <<"asset_version">> => maps:get(asset_version, R),
        <<"volume">> => maps:get(volume, R),
        <<"server_time">> => erlang:system_time(millisecond)
    },
    Connections = maps:get(Channel, maps:get(soundboard_channels, State, #{}), #{}),
    Voices = maps:get(voice_states, State, #{}),
    Recipients = maps:fold(
        fun(ConnectionId, _, Acc) ->
            VS = maps:get(ConnectionId, Voices, #{}),
            case maps:get(<<"channel_id">>, VS, undefined) =:= Channel andalso eligible(VS) of
                true ->
                    [
                        {ConnectionId,
                            maps:with([<<"session_id">>, <<"soundboard_epoch">>], VS)}
                        | Acc
                    ];
                false ->
                    Acc
            end
        end,
        [],
        Connections
    ),
    %% Session resolution must not block the voice owner or retain the guild state.
    _ = spawn(fun() ->
        %% Late best-effort plays are dropped rather than accumulating stalled tasks.
        {ok, Timer} = timer:kill_after(5000),
        try
            lists:foreach(
                fun({ConnectionId, VS}) ->
                    dispatch_session(ConnectionId, VS, Event, GuildId)
                end,
                Recipients
            )
        after
            _ = timer:cancel(Timer)
        end
    end),
    ok.

-spec dispatch_session(binary(), map(), map(), integer()) -> ok.
dispatch_session(ConnectionId, VS, Event, GuildId) ->
    case lookup_session(maps:get(<<"session_id">>, VS)) of
        {ok, Pid} ->
            gateway_dispatch_relay:dispatch_many(
                [Pid],
                guild_soundboard_sound_play,
                Event#{
                    <<"recipient_connection_id">> => ConnectionId,
                    <<"recipient_soundboard_epoch">> => maps:get(<<"soundboard_epoch">>, VS, 0)
                },
                GuildId
            ),
            ok;
        {error, not_found} ->
            ok
    end.

-spec lookup_session(binary()) -> {ok, pid()} | {error, not_found}.
lookup_session(SessionId) ->
    try session_manager:lookup(SessionId) of
        {ok, Pid} when is_pid(Pid) -> {ok, Pid};
        _ -> {error, not_found}
    catch
        exit:_ -> {error, not_found}
    end.

-spec with_epoch(map(), map()) -> map().
with_epoch(VS, Previous) ->
    Epoch = maps:get(<<"soundboard_epoch">>, Previous, 0),
    Changed =
        maps:get(<<"channel_id">>, VS, undefined) =/=
            maps:get(<<"channel_id">>, Previous, undefined),
    VS#{
        <<"soundboard_epoch">> => Epoch +
            case Changed of
                true -> 1;
                false -> 0
            end
    }.

-spec rebuild(map()) -> map().
rebuild(State) ->
    Channels = maps:fold(fun add_connection/3, #{}, maps:get(voice_states, State, #{})),
    State#{soundboard_channels => Channels}.

%% Share the existing count-cache reconciliation pass; play never scans the guild map.
-spec sync(map(), map()) -> map().
sync(Old, New) ->
    OldVoices = maps:get(voice_states, Old, #{}),
    NewVoices = maps:get(voice_states, New, #{}),
    Channels = maps:get(soundboard_channels, Old, #{}),
    case OldVoices =:= NewVoices of
        true ->
            New#{soundboard_channels => Channels};
        false ->
            Removed = maps:fold(
                fun(Id, VS, Acc) ->
                    case maps:is_key(Id, NewVoices) of
                        true ->
                            Acc;
                        false ->
                            _ = voice_state_counts_cache:remove_connection(Id),
                            remove_connection(Id, VS, Acc)
                    end
                end,
                Channels,
                OldVoices
            ),
            Updated = maps:fold(
                fun(Id, VS, Acc) ->
                    _ = voice_state_counts_cache:upsert_voice_state(VS),
                    case maps:get(Id, OldVoices, undefined) of
                        VS ->
                            Acc;
                        Previous when is_map(Previous) ->
                            add_connection(Id, VS, remove_connection(Id, Previous, Acc));
                        _ ->
                            add_connection(Id, VS, Acc)
                    end
                end,
                Removed,
                NewVoices
            ),
            New#{soundboard_channels => Updated}
    end.

-spec add_connection(binary(), map(), map()) -> map().
add_connection(Id, VS, Channels) ->
    case maps:get(<<"channel_id">>, VS, undefined) of
        Channel when is_binary(Channel) ->
            Entries = maps:get(Channel, Channels, #{}),
            Channels#{Channel => Entries#{Id => true}};
        _ ->
            Channels
    end.

-spec remove_connection(binary(), map(), map()) -> map().
remove_connection(Id, VS, Channels) ->
    Channel = maps:get(<<"channel_id">>, VS, undefined),
    Entries = maps:remove(Id, maps:get(Channel, Channels, #{})),
    case map_size(Entries) of
        0 -> maps:remove(Channel, Channels);
        _ -> Channels#{Channel => Entries}
    end.

-spec take_rate(integer(), binary(), integer(), map()) -> {ok | error, map()}.
take_rate(User, Channel, Now, State) ->
    Rates = maps:get(soundboard_rates, State, #{}),
    UserKey = {user, User},
    ChannelKey = {channel, Channel},
    UserTokens = refill(maps:get(UserKey, Rates, {4.0, Now}), Now, 4, 4),
    ChannelTokens = refill(maps:get(ChannelKey, Rates, {4.0, Now}), Now, 8, 4),
    case UserTokens >= 1 andalso ChannelTokens >= 1 of
        false ->
            {error, State};
        true ->
            {ok, State#{
                soundboard_rates => Rates#{
                    UserKey => {UserTokens - 1, Now}, ChannelKey => {ChannelTokens - 1, Now}
                }
            }}
    end.

-spec refill({number(), integer()}, integer(), pos_integer(), pos_integer()) -> number().
refill({Tokens, At}, Now, Rate, Burst) ->
    min(Burst, Tokens + max(0, Now - At) * Rate / 5000).

-spec sweep(integer(), map()) -> map().
sweep(Now, State) ->
    Channels = maps:get(soundboard_channels, State, #{}),
    Rates = maps:filter(
        fun
            ({channel, Channel}, {_, At}) ->
                Now - At < 5000 andalso maps:is_key(Channel, Channels);
            ({user, _}, {_, At}) ->
                Now - At < 5000
        end,
        maps:get(soundboard_rates, State, #{})
    ),
    State#{soundboard_rates => Rates}.
