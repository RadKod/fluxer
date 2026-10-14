%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(fluxer_gateway_app_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

start_keeps_generational_gc_as_vm_default_test() ->
    ?assertEqual([10], vm_fullsweep_after_values()).

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

vm_fullsweep_after_values() ->
    {fluxer_gateway_app, Beam, _Path} = code:get_object_code(fluxer_gateway_app),
    {ok, {fluxer_gateway_app, [{abstract_code, {raw_abstract_v1, Forms}}]}} =
        beam_lib:chunks(Beam, [abstract_code]),
    collect_fullsweep_after(Forms, []).

collect_fullsweep_after([Form | Rest], Acc) ->
    collect_fullsweep_after(Rest, collect_fullsweep_after(Form, Acc));
collect_fullsweep_after(
    {call, _, {remote, _, {atom, _, erlang}, {atom, _, system_flag}}, [
        {atom, _, fullsweep_after}, {integer, _, Value}
    ]},
    Acc
) ->
    Acc ++ [Value];
collect_fullsweep_after(Form, Acc) when is_tuple(Form) ->
    collect_fullsweep_after(tuple_to_list(Form), Acc);
collect_fullsweep_after(_Form, Acc) ->
    Acc.
