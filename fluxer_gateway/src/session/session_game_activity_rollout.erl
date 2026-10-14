%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(session_game_activity_rollout).
-typing([eqwalizer]).
-export([payload/0, gate/0, grant_gate/1, changed/1, replay/2, allows/1]).

-spec allows(map()) -> boolean().
allows(Stamp) ->
    gateway_rollout_config:game_activity_allowed() andalso
        maps:get(rollout_epoch, Stamp, undefined) =:=
            maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0).

-spec replay([map()], map()) -> [map()].
replay(Entries, State) ->
    [
        case E of
            #{event := Event, data := Data} ->
                E#{data => session_game_activity:wire(Event, Data, State)};
            _ ->
                E
        end
     || E <- Entries
    ].

-spec payload() -> map().
payload() ->
    #{
        <<"game_activity_enabled">> => gateway_rollout_config:game_activity_allowed(),
        <<"game_activity_epoch">> => maps:get(
            <<"game_activity_epoch">>, gateway_rollout_config:get(), 0
        )
    }.

-spec gate() -> tuple().
gate() ->
    {
        gateway_rollout_config:game_activity_allowed(),
        maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0),
        gateway_rollout_config:game_activity_generation()
    }.

-spec grant_gate(map()) -> tuple().
grant_gate(State) ->
    maps:get(game_activity_rollout_gate, State, gate()).

-spec changed(map()) -> {noreply, map()}.
changed(State) ->
    Gate = gate(),
    case maps:get(game_activity_rollout_gate, State, undefined) =:= Gate of
        true ->
            {noreply, State};
        false ->
            Closed = session_game_activity:rollout(State#{game_activity_rollout_gate => Gate}),
            session_dispatch:handle_dispatch(gateway_rollout_update, payload(), Closed)
    end.
