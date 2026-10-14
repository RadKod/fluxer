%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(fluxer_gateway_app_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

%% The connection counters exist before the listener takes a WebSocket, on every node role.
init_subsystems_creates_connection_counters_test() ->
    ?assertEqual(
        [{gateway_connection_metrics, init}],
        [
            Call
         || {Module, _} = Call <- init_subsystems_calls(), Module =:= gateway_connection_metrics
        ]
    ).

init_subsystems_calls() ->
    {fluxer_gateway_app, Beam, _Path} = code:get_object_code(fluxer_gateway_app),
    {ok, {fluxer_gateway_app, [{abstract_code, {raw_abstract_v1, Forms}}]}} =
        beam_lib:chunks(Beam, [abstract_code]),
    [Body] = [Clauses || {function, _, init_subsystems, 0, Clauses} <- Forms],
    collect_remote_calls(Body, []).

collect_remote_calls({call, _, {remote, _, {atom, _, Module}, {atom, _, Name}}, []}, Acc) ->
    Acc ++ [{Module, Name}];
collect_remote_calls(Form, Acc) when is_tuple(Form) ->
    collect_remote_calls(tuple_to_list(Form), Acc);
collect_remote_calls([Form | Rest], Acc) ->
    collect_remote_calls(Rest, collect_remote_calls(Form, Acc));
collect_remote_calls(_Form, Acc) ->
    Acc.
