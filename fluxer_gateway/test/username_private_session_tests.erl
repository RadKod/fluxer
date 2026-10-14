%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(username_private_session_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

private_ready_status_is_retained_only_for_session_owner_test() ->
    Owner = private_user(1),
    Other = private_user(2),
    Ready = #{
        <<"user">> => Owner,
        <<"relationships">> => [
            #{<<"id">> => <<"2">>, <<"type">> => 1, <<"user">> => Other}
        ]
    },
    State = #{bot => false, user_id => 1, ready => Ready, channels => #{}},
    PublicUsers = session_ready_collect:collect_ready_users(State, []),
    [PublicOther] = PublicUsers,
    assert_private_absent(PublicOther),
    ?assertEqual(<<"8">>, maps:get(<<"identity_version">>, PublicOther)),
    PrivateReady = session_ready_collect:strip_user_from_relationships(Ready),
    ?assertEqual(Owner, maps:get(<<"user">>, PrivateReady)),
    [Relationship] = maps:get(<<"relationships">>, PrivateReady),
    ?assertNot(maps:is_key(<<"user">>, Relationship)).

private_user_update_targets_owner_while_presence_strips_status_test() ->
    User = private_user(1),
    State = #{seq => 0, socket_pid => self()},
    _ = session_ready_dispatch:dispatch_event(user_update, User, State),
    receive
        {dispatch, user_update, OwnerPayload, 1} ->
            ?assertEqual(<<"selected">>, maps:get(<<"username_state">>, OwnerPayload))
    after 100 -> ?assert(false, missing_private_user_update)
    end,
    Presence = presence_payload:build(User, online, false, false, null),
    PublicUser = maps:get(<<"user">>, Presence),
    assert_private_absent(PublicUser),
    ?assertEqual(<<"8">>, maps:get(<<"identity_version">>, PublicUser)).

private_user(Id) ->
    #{
        <<"id">> => integer_to_binary(Id),
        <<"username">> => <<"chosen">>,
        <<"identity_version">> => <<"8">>,
        <<"username_state">> => <<"selected">>,
        <<"username_change_available_at">> => 123,
        <<"username_free_change_available">> => true
    }.

assert_private_absent(User) ->
    lists:foreach(
        fun(Key) -> ?assertNot(maps:is_key(Key, User)) end,
        [
            <<"username_state">>,
            <<"username_change_available_at">>,
            <<"username_free_change_available">>
        ]
    ).
