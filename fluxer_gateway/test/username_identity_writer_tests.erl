%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(username_identity_writer_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

legacy_zero_version_accepts_unversioned_rename_through_actual_writers_test() ->
    Zero = (identity(<<"legacy">>, <<"0">>))#{<<"discriminator">> => <<"1234">>},
    Rename = maps:remove(<<"identity_version">>, Zero#{
        <<"username">> => <<"renamed">>,
        <<"discriminator">> => <<"5678">>
    }),
    Presence = presence_update:handle_user_update_event(
        Rename,
        #{user_id => 100, user_data => Zero, last_published_presence => undefined}
    ),
    ?assertEqual(<<"renamed">>, maps:get(<<"username">>, maps:get(user_data, Presence))),
    State0 = guild_state(),
    State = State0#{
        data => guild_data_index_members:put_member(
            #{<<"user">> => Zero, <<"roles">> => []}, #{}
        )
    },
    try
        Renamed = guild_user_data:handle_user_data_update(100, Rename, State),
        [#{<<"member">> := Member}] = guild_member_list_read:hydrate_engine_items(
            [{member, 100}], Renamed
        ),
        User = maps:get(<<"user">>, Member),
        ?assertEqual(<<"renamed">>, maps:get(<<"username">>, User)),
        ?assertEqual(<<"5678">>, maps:get(<<"discriminator">>, User)),
        ?assertEqual(<<"0">>, maps:get(<<"identity_version">>, User))
    after
        drain_member_dispatches(),
        guild_member_list_subs:destroy(maps:get(member_list_subscriptions, State0))
    end.

guild_user_data_writers_keep_identity_for_new_session_test() ->
    Writers = [
        fun(User, State) -> guild_user_data:handle_user_data_update(100, User, State) end,
        fun(User, State) ->
            guild_user_data:maybe_update_cached_user_data(
                message_create, #{<<"author">> => User}, State
            )
        end,
        fun(User, State) ->
            guild_user_data:maybe_update_cached_user_data(
                message_update, #{<<"author">> => User}, State
            )
        end
    ],
    lists:foreach(fun assert_guild_writer/1, Writers).

guild_presence_writer_keeps_identity_for_new_session_test() ->
    assert_guild_writer(fun(User, State) ->
        {noreply, Updated} = guild_presence:handle_bus_presence(
            100, #{<<"user">> => User, <<"user_update">> => true}, State
        ),
        Updated
    end).

presence_cache_direct_writer_keeps_identity_for_fresh_bulk_read_test() ->
    Index = 901,
    Table = presence_cache_shard:table_name(Index),
    _ = ets:new(Table, [named_table, public, set]),
    try
        New = #{<<"status">> => <<"online">>, <<"user">> => identity(<<"new">>, <<"8">>)},
        Old = #{
            <<"status">> => <<"idle">>,
            <<"user">> =>
                (identity(<<"old">>, <<"7">>))#{<<"avatar">> => <<"updated">>}
        },
        ok = presence_cache_shard:write_put(Index, 100, New),
        ok = presence_cache_shard:write_put(Index, 100, Old),
        {reply, #{100 := Cached}, _} = presence_cache_shard:handle_call(
            {bulk_get_map, [100]}, {self(), make_ref()}, #{table => Table, shard_index => Index}
        ),
        assert_identity(maps:get(<<"user">>, Cached)),
        ?assertEqual(<<"idle">>, maps:get(<<"status">>, Cached)),
        ?assertEqual(<<"updated">>, maps:get(<<"avatar">>, maps:get(<<"user">>, Cached))),
        lists:foreach(
            fun(Status) ->
                ok = presence_cache_shard:write_put(Index, 100, New),
                ok = presence_cache_shard:write_put(Index, 100, #{<<"status">> => Status}),
                ?assertEqual([], ets:lookup(Table, 100))
            end,
            [<<"offline">>, <<"invisible">>]
        )
    after
        ets:delete(Table)
    end.

presence_dispatch_keeps_identity_and_private_status_test() ->
    New = identity(<<"new">>, <<"8">>),
    Old = (identity(<<"old">>, <<"7">>))#{
        <<"avatar">> => <<"updated">>,
        <<"username_state">> => <<"legacy">>
    },
    State0 = #{
        user_id => 100,
        user_data => #{},
        sessions => #{<<"active">> => #{pid => self()}},
        last_published_presence => undefined
    },
    {reply, ok, State8} = presence:handle_call(
        {dispatch, user_update, New#{<<"username_state">> => <<"selected">>}},
        {self(), make_ref()},
        State0
    ),
    receive
        {'$gen_cast', {dispatch, user_update, _}} -> ok
    after 1000 -> ?assert(false)
    end,
    {noreply, State7} = presence:handle_cast({dispatch, user_update, Old}, State8),
    receive
        {'$gen_cast', {dispatch, user_update, User}} ->
            assert_identity(User),
            ?assertEqual(<<"selected">>, maps:get(<<"username_state">>, User)),
            ?assertEqual(<<"updated">>, maps:get(<<"avatar">>, User))
    after 1000 -> ?assert(false)
    end,
    assert_identity(maps:get(user_data, State7)).

assert_guild_writer(Writer) ->
    State0 = guild_state(),
    try
        assert_guild_writer(Writer, State0)
    after
        guild_member_list_subs:destroy(maps:get(member_list_subscriptions, State0))
    end.

assert_guild_writer(Writer, State0) ->
    State8 = Writer(identity(<<"new">>, <<"8">>), State0),
    drain_member_dispatches(),
    Late = (identity(<<"old">>, <<"7">>))#{
        <<"avatar">> => <<"updated">>,
        <<"discriminator">> => <<"1234">>
    },
    State7 = Writer(Late, State8),
    assert_member_dispatches(),
    [#{<<"member">> := Member}] = guild_member_list_read:hydrate_engine_items(
        [{member, 100}], State7
    ),
    User = maps:get(<<"user">>, Member),
    assert_identity(User),
    ?assertEqual(<<"updated">>, maps:get(<<"avatar">>, User)),
    FreshState = State7#{sessions => #{<<"fresh">> => #{pid => self()}}},
    _ = guild_presence:send_presence_lookup_to_session(
        100, <<"fresh">>, {ok, #{<<"status">> => <<"online">>}}, FreshState
    ),
    receive
        {'$gen_cast', {dispatch, presence_update, Payload}} ->
            assert_identity(maps:get(<<"user">>, Payload))
    after 1000 -> ?assert(false)
    end.

assert_identity(User) ->
    ?assertEqual(<<"new">>, maps:get(<<"username">>, User)),
    ?assertEqual(<<"0000">>, maps:get(<<"discriminator">>, User)),
    ?assertEqual(<<"8">>, maps:get(<<"identity_version">>, User)),
    ?assertNot(maps:is_key(<<"username_change_available_at">>, User)).

identity(Name, Version) ->
    #{
        <<"id">> => <<"100">>,
        <<"username">> => Name,
        <<"discriminator">> => <<"0000">>,
        <<"identity_version">> => Version
    }.

guild_state() ->
    #{
        id => 42,
        data => guild_data_index_members:put_member(
            #{<<"user">> => identity(<<"legacy">>, <<"6">>), <<"roles">> => []}, #{}
        ),
        sessions => #{},
        member_list_subscriptions => guild_member_list_subs:new()
    }.

drain_member_dispatches() ->
    receive
        {'$gen_cast', {dispatch, #{event := guild_member_update}}} ->
            drain_member_dispatches()
    after 0 -> ok
    end.

assert_member_dispatches() ->
    receive
        {'$gen_cast', {dispatch, #{event := guild_member_update, data := Member}}} ->
            assert_identity(maps:get(<<"user">>, Member)),
            assert_member_dispatches()
    after 0 -> ok
    end.
