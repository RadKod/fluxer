%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_rpc_voice_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

voice_channel_read_malformed_payloads_return_empty_results_test() ->
    ?assertEqual(
        #{<<"voice_states">> => []},
        gateway_rpc_voice:execute_method(<<"voice.get_voice_states_for_channel">>, #{})
    ),
    ?assertEqual(
        #{<<"voice_states">> => []},
        gateway_rpc_voice:execute_method(<<"voice.get_voice_states_for_channel">>, #{
            <<"guild_id">> => <<"1">>,
            <<"channel_id">> => null
        })
    ).

validate_voice_channel_read_params_normalizes_ids_test() ->
    ?assertEqual(
        {ok, <<"2">>, 1},
        gateway_rpc_voice:validate_voice_channel_read_params(#{
            <<"guild_id">> => <<"1">>, <<"channel_id">> => 2
        })
    ),
    ?assertEqual(
        {ok, <<"2">>, undefined},
        gateway_rpc_voice:validate_voice_channel_read_params(#{
            <<"guild_id">> => null, <<"channel_id">> => <<"2">>
        })
    ),
    ?assertEqual(
        {ok, <<"2">>, undefined},
        gateway_rpc_voice:validate_voice_channel_read_params(#{
            <<"guild_id">> => <<"0">>, <<"channel_id">> => <<"2">>
        })
    ).

normalize_voice_states_ignores_malformed_entries_test() ->
    ?assertEqual(
        [
            #{
                <<"connection_id">> => <<"conn">>,
                <<"user_id">> => <<"42">>,
                <<"channel_id">> => <<"9">>,
                <<"region_id">> => <<"local">>,
                <<"server_id">> => <<"dev-1">>
            }
        ],
        gateway_rpc_voice:normalize_voice_states([
            not_a_map,
            #{
                <<"connection_id">> => <<"conn">>,
                <<"user_id">> => 42,
                <<"channel_id">> => 9,
                region_id => <<"local">>,
                server_id => <<"dev-1">>
            },
            #{<<"connection_id">> => undefined, <<"user_id">> => 84, <<"channel_id">> => 9}
        ])
    ).

%% LiveKit's participant_left carries the token nonce of the connection that left. The
%% guild voice server needs it to tell a stale event from the connection's newer token.
disconnect_if_in_channel_forwards_token_nonce_test() ->
    Self = self(),
    VoicePid = spawn_link(fun() ->
        receive
            {'$gen_call', From, {disconnect_voice_user_if_in_channel, Req}} ->
                Self ! {voice_request, Req},
                gen:reply(From, #{success => true})
        end
    end),
    meck:new(gateway_rpc_guild_routing, [passthrough, no_link]),
    meck:new(gateway_rpc_guild_infra, [passthrough, no_link]),
    meck:expect(gateway_rpc_guild_routing, guild_owner_scope, fun(_) -> local end),
    meck:expect(gateway_rpc_guild_infra, with_voice_server, fun(_, Fun) ->
        Fun(VoicePid, Self)
    end),
    try
        ?assertEqual(
            #{<<"success">> => true},
            gateway_rpc_voice:execute_method(<<"voice.disconnect_user_if_in_channel">>, #{
                <<"guild_id">> => <<"1">>,
                <<"channel_id">> => <<"2">>,
                <<"user_id">> => <<"3">>,
                <<"connection_id">> => <<"conn">>,
                <<"token_nonce">> => <<"nonce">>
            })
        ),
        receive
            {voice_request, Req} ->
                ?assertEqual(<<"conn">>, maps:get(connection_id, Req)),
                ?assertEqual(<<"nonce">>, maps:get(token_nonce, Req, undefined))
        after 1000 -> ?assert(false)
        end
    after
        meck:unload([gateway_rpc_guild_routing, gateway_rpc_guild_infra])
    end.
