%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(user_utils).
-typing([eqwalizer]).

-export([normalize_user/1, partial_user_fields/0, merge_user/2]).

-spec partial_user_fields() -> [binary()].
partial_user_fields() ->
    [
        <<"id">>,
        <<"username">>,
        <<"discriminator">>,
        <<"identity_version">>,
        <<"global_name">>,
        <<"avatar">>,
        <<"avatar_color">>,
        <<"bot">>,
        <<"system">>,
        <<"flags">>,
        <<"mention_flags">>,
        <<"avatar_decoration_data">>,
        <<"avatar_ultra_data">>,
        <<"nameplate_data">>,
        <<"name_style">>
    ].

%% Micup: late profile events may update cosmetics, but must not roll back identity.
-spec merge_user(map(), map()) -> map().
merge_user(Current, Incoming) ->
    CurrentVersion = identity_version(Current),
    IncomingVersion = identity_version(Incoming),
    case {CurrentVersion, IncomingVersion} of
        {CurrentGen, IncomingGen} when
            is_integer(CurrentGen),
            is_integer(IncomingGen),
            IncomingVersion < CurrentVersion
        ->
            maps:merge(Current, maps:without(identity_fields(), Incoming));
        {CurrentGen, undefined} when is_integer(CurrentGen), CurrentGen > 0 ->
            maps:merge(Current, maps:without(identity_fields(), Incoming));
        _ ->
            maps:merge(Current, Incoming)
    end.

-spec identity_fields() -> [binary()].
identity_fields() ->
    [<<"username">>, <<"discriminator">>, <<"username_state">>, <<"identity_version">>].

-spec identity_version(map()) -> non_neg_integer() | undefined.
identity_version(User) ->
    case maps:get(<<"identity_version">>, User, undefined) of
        Version when is_binary(Version), byte_size(Version) > 0 ->
            decimal_identity_version(Version, 0);
        _ ->
            undefined
    end.

-spec decimal_identity_version(binary(), non_neg_integer()) -> non_neg_integer() | undefined.
decimal_identity_version(<<>>, Acc) ->
    Acc;
decimal_identity_version(<<Digit, Rest/binary>>, Acc) when Digit >= $0, Digit =< $9 ->
    decimal_identity_version(Rest, Acc * 10 + Digit - $0);
decimal_identity_version(_, _Acc) ->
    undefined.

-spec normalize_user(map() | term()) -> map().
normalize_user(User) when is_map(User) ->
    lists:foldl(
        fun(Key, Acc) -> add_normalized_field(Key, User, Acc) end,
        #{},
        partial_user_fields()
    );
normalize_user(_) ->
    #{}.

-spec normalize_field(binary(), term()) -> term() | undefined.
normalize_field(<<"id">>, Value) ->
    snowflake_id:parse(Value);
normalize_field(<<"avatar_color">>, null) ->
    null;
normalize_field(<<"avatar_color">>, Value) ->
    guild_data_normalize_schema:int(Value);
normalize_field(<<"flags">>, Value) ->
    bitset:parse(Value);
normalize_field(<<"mention_flags">>, Value) ->
    bitset:parse(Value);
normalize_field(_Key, Value) ->
    Value.

-spec add_normalized_field(binary(), map(), map()) -> map().
add_normalized_field(Key, User, Acc) ->
    case maps:get(Key, User, undefined) of
        undefined -> Acc;
        Value -> maybe_add_normalized_field(Key, normalize_field(Key, Value), Acc)
    end.

-spec maybe_add_normalized_field(binary(), term(), map()) -> map().
maybe_add_normalized_field(_Key, undefined, Acc) ->
    Acc;
maybe_add_normalized_field(Key, Normalized, Acc) ->
    Acc#{Key => Normalized}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

merge_user_preserves_newer_identity_and_merges_profile_test() ->
    Current = #{
        <<"username">> => <<"new">>,
        <<"discriminator">> => <<"0000">>,
        <<"username_state">> => <<"selected">>,
        <<"identity_version">> => <<"8">>
    },
    Incoming = #{
        <<"username">> => <<"old">>,
        <<"discriminator">> => <<"1234">>,
        <<"username_state">> => <<"legacy">>,
        <<"identity_version">> => <<"7">>,
        <<"avatar">> => <<"new-avatar">>
    },
    ?assertEqual(Current#{<<"avatar">> => <<"new-avatar">>}, merge_user(Current, Incoming)).

merge_user_rejects_unversioned_identity_after_selection_test() ->
    Current = #{<<"username">> => <<"new">>, <<"identity_version">> => <<"8">>},
    Incoming = #{<<"username">> => <<"old">>, <<"global_name">> => <<"New display">>},
    ?assertEqual(
        Current#{<<"global_name">> => <<"New display">>}, merge_user(Current, Incoming)
    ).

merge_user_accepts_newer_and_equal_versions_test() ->
    Current = #{<<"username">> => <<"old">>, <<"identity_version">> => <<"7">>},
    lists:foreach(
        fun(Version) ->
            Incoming = #{<<"username">> => <<"new">>, <<"identity_version">> => Version},
            ?assertEqual(Incoming, merge_user(Current, Incoming))
        end,
        [<<"7">>, <<"8">>]
    ).

merge_user_keeps_legacy_updates_test() ->
    ?assertEqual(
        #{<<"username">> => <<"new">>},
        merge_user(#{<<"username">> => <<"old">>}, #{<<"username">> => <<"new">>})
    ).

normalize_user_excludes_private_username_status_test() ->
    User = #{
        <<"id">> => <<"123">>,
        <<"identity_version">> => <<"8">>,
        <<"username_state">> => <<"selected">>,
        <<"username_change_available_at">> => 123,
        <<"username_free_change_available">> => true
    },
    ?assertEqual(#{<<"id">> => 123, <<"identity_version">> => <<"8">>}, normalize_user(User)).

merge_user_compares_arbitrary_precision_decimal_versions_test() ->
    Current = #{
        <<"username">> => <<"new">>, <<"identity_version">> => <<"9223372036854775808">>
    },
    Incoming = #{
        <<"username">> => <<"old">>,
        <<"identity_version">> => <<"9223372036854775807">>,
        <<"avatar">> => null
    },
    ?assertEqual(Current#{<<"avatar">> => null}, merge_user(Current, Incoming)).

merge_user_treats_invalid_versions_as_unversioned_test() ->
    Current = #{<<"username">> => <<"new">>, <<"identity_version">> => <<"8">>},
    lists:foreach(
        fun(Version) ->
            Incoming = #{
                <<"username">> => <<"old">>,
                <<"identity_version">> => Version,
                <<"avatar">> => null
            },
            ?assertEqual(Current#{<<"avatar">> => null}, merge_user(Current, Incoming))
        end,
        [null, <<"-1">>, <<"+9">>, <<"9x">>, <<>>]
    ).

normalize_user_valid_test() ->
    User = #{
        <<"id">> => <<"123">>,
        <<"username">> => <<"testuser">>,
        <<"discriminator">> => <<"0001">>,
        <<"email">> => <<"test@example.com">>
    },
    Result = normalize_user(User),
    ?assertEqual(123, maps:get(<<"id">>, Result)),
    ?assertEqual(<<"testuser">>, maps:get(<<"username">>, Result)),
    ?assertEqual(<<"0001">>, maps:get(<<"discriminator">>, Result)),
    ?assertEqual(error, maps:find(<<"email">>, Result)).

normalize_user_keeps_cosmetics_from_vectors_test() ->
    lists:foreach(
        fun(Vector) ->
            Partial = maps:get(<<"partial">>, Vector),
            Result = normalize_user(Partial),
            lists:foreach(
                fun(Field) ->
                    ?assertEqual(maps:get(Field, Partial), maps:get(Field, Result))
                end,
                [
                    <<"avatar_decoration_data">>,
                    <<"avatar_ultra_data">>,
                    <<"nameplate_data">>,
                    <<"name_style">>
                ]
            )
        end,
        read_cosmetic_vectors()
    ).

normalize_user_keeps_name_style_test() ->
    Style = #{<<"font_id">> => 6, <<"colors">> => [16#ffffff, 16#7b5cff]},
    User = #{<<"id">> => <<"42">>, <<"name_style">> => Style},
    ?assertEqual(Style, maps:get(<<"name_style">>, normalize_user(User))),
    ?assertEqual(
        null, maps:get(<<"name_style">>, normalize_user(User#{<<"name_style">> => null}))
    ).

check_user_data_differs_on_cosmetics_from_vectors_test() ->
    [Both, NameplateOnly, None, HalfWritten, UltraAndFrame, UltraHalfWritten | _] = [
        maps:get(<<"partial">>, Vector)
     || Vector <- read_cosmetic_vectors()
    ],
    FrameOnly = UltraAndFrame#{<<"avatar_ultra_data">> => null},
    ?assert(utils:check_user_data_differs(Both, NameplateOnly)),
    ?assert(utils:check_user_data_differs(NameplateOnly, None)),
    ?assertNot(utils:check_user_data_differs(None, HalfWritten)),
    ?assertNot(utils:check_user_data_differs(Both, Both)),
    ?assert(utils:check_user_data_differs(FrameOnly, UltraAndFrame)),
    ?assert(utils:check_user_data_differs(UltraAndFrame, FrameOnly)),
    ?assertNot(utils:check_user_data_differs(None, UltraHalfWritten)).

%% Shared with the API mapper and the users service (fluxer_users api_partial_includes_cosmetics).
read_cosmetic_vectors() ->
    Path = "../fluxer_common/src/testdata/partial_user_cosmetic_vectors.json",
    {ok, Contents} = file:read_file(Path),
    [_ | _] = Vectors = json:decode(Contents),
    Vectors.

-endif.
