%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(username_voice_error_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

selection_error_wire_contract_test() ->
    ?assertEqual(
        {error, permission_denied, username_selection_required},
        gateway_errors:error(username_selection_required)
    ),
    ?assertEqual(
        <<"USERNAME_SELECTION_REQUIRED">>,
        gateway_errors:error_code(username_selection_required)
    ).

selection_error_direct_nested_and_iodata_test() ->
    Direct = json:encode(#{<<"code">> => <<"USERNAME_SELECTION_REQUIRED">>}),
    Nested = json:encode(#{<<"error">> => #{<<"code">> => <<"USERNAME_SELECTION_REQUIRED">>}}),
    lists:foreach(
        fun(Body) ->
            ?assertEqual(username_selection_required, gateway_errors:voice_token_error(Body))
        end,
        [Direct, Nested, [Direct]]
    ).

selection_error_does_not_replace_unclaimed_or_unknown_errors_test() ->
    Body = json:encode(#{<<"code">> => <<"UNCLAIMED_ACCOUNT_CANNOT_JOIN_VOICE_CHANNELS">>}),
    ?assertEqual(voice_unclaimed_account, gateway_errors:voice_token_error(Body)),
    lists:foreach(
        fun(Invalid) ->
            ?assertEqual(voice_token_failed, gateway_errors:voice_token_error(Invalid))
        end,
        [<<"not json">>, <<"{}">>, undefined, 42, [bad_iodata]]
    ).

guild_token_preserves_selection_error_test() ->
    with_selection_rpc(fun() ->
        ?assertEqual(
            {error, username_selection_required},
            guild_voice_connection_token:request_voice_token(999, 100, 10, #{})
        )
    end).

dm_token_preserves_selection_error_without_creating_voice_state_test() ->
    with_selection_rpc(fun() ->
        State = #{dm_voice_states => #{}},
        Req = #{
            user_id => 10,
            channel_id => 100,
            latitude => undefined,
            longitude => undefined,
            state => State
        },
        ?assertEqual(
            {reply, {error, permission_denied, username_selection_required}, State},
            dm_voice_token:get_dm_voice_token_and_create_state(Req)
        )
    end).

dm_get_token_sends_selection_error_to_session_test() ->
    with_selection_rpc(fun() ->
        ?assertEqual(
            error,
            dm_voice_token:get_voice_token(100, 10, <<"session">>, self(), undefined, undefined)
        ),
        receive
            {voice_error, username_selection_required} -> ok
        after 100 -> ?assert(false, missing_username_selection_error)
        end
    end).

with_selection_rpc(Fun) ->
    meck:new(rpc_client, [passthrough, no_link, non_strict]),
    Body = json:encode(#{<<"code">> => <<"USERNAME_SELECTION_REQUIRED">>}),
    meck:expect(rpc_client, call, fun(_Request) -> {error, {rpc_error, 403, Body}} end),
    try
        Fun()
    after
        meck:unload(rpc_client)
    end.
