%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(utils).
-typing([eqwalizer]).

-export([
    binary_to_integer_safe/1,
    generate_session_id/0,
    hash_token/1,
    parse_status/1,
    check_user_data_differs/2,
    parse_iso8601_to_unix_ms/1
]).

-spec binary_to_integer_safe(binary() | integer() | term()) -> integer() | undefined.
binary_to_integer_safe(Int) when is_integer(Int) ->
    Int;
binary_to_integer_safe(Bin) when is_binary(Bin) ->
    type_conv:to_integer(Bin);
binary_to_integer_safe(_) ->
    undefined.

-spec generate_session_id() -> binary().
generate_session_id() ->
    Bytes = crypto:strong_rand_bytes(constants:random_session_bytes()),
    binary:encode_hex(Bytes).

-spec hash_token(binary()) -> binary().
hash_token(Token) ->
    crypto:hash(sha256, Token).

-spec parse_status(binary() | atom() | term()) -> atom().
parse_status(Status) when is_binary(Status) ->
    case constants:status_type_atom(Status) of
        Parsed when is_atom(Parsed) -> Parsed;
        _ -> online
    end;
parse_status(Status) when is_atom(Status) ->
    Status;
parse_status(_) ->
    online.

-define(GREGORIAN_SECONDS_TO_UNIX_EPOCH, 62167219200).

-spec parse_iso8601_to_unix_ms(binary() | term()) -> integer() | undefined.
parse_iso8601_to_unix_ms(Binary) when is_binary(Binary) ->
    Pattern =
        <<"^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?Z$">>,
    CaptureOpts = [{capture, [1, 2, 3, 4, 5, 6, 7], list}],
    case re:run(Binary, Pattern, CaptureOpts) of
        {match, [YS, MS, DS, HS, MiS, SS, FS]} ->
            convert_iso8601_parts(YS, MS, DS, HS, MiS, SS, FS);
        _ ->
            undefined
    end;
parse_iso8601_to_unix_ms(_) ->
    undefined.

-spec convert_iso8601_parts(list(), list(), list(), list(), list(), list(), list()) ->
    integer() | undefined.
convert_iso8601_parts(YearBin, MonthBin, DayBin, HourBin, MinuteBin, SecondBin, FractionBin) ->
    Y = type_conv:to_integer(YearBin),
    M = type_conv:to_integer(MonthBin),
    D = type_conv:to_integer(DayBin),
    H = type_conv:to_integer(HourBin),
    Min = type_conv:to_integer(MinuteBin),
    S = type_conv:to_integer(SecondBin),
    FractionMs = fractional_ms(FractionBin),
    datetime_to_unix_ms(Y, M, D, H, Min, S, FractionMs).

-spec datetime_to_unix_ms(term(), term(), term(), term(), term(), term(), non_neg_integer()) ->
    integer() | undefined.
datetime_to_unix_ms(Y, M, D, H, Min, S, FractionMs) when
    is_integer(Y),
    is_integer(M),
    is_integer(D),
    is_integer(H),
    is_integer(Min),
    is_integer(S)
->
    try calendar:datetime_to_gregorian_seconds({{Y, M, D}, {H, Min, S}}) of
        Gregorian ->
            UnixSeconds = Gregorian - ?GREGORIAN_SECONDS_TO_UNIX_EPOCH,
            UnixSeconds * 1000 + FractionMs
    catch
        error:badarg -> undefined
    end;
datetime_to_unix_ms(_, _, _, _, _, _, _) ->
    undefined.

-spec fractional_ms(list()) -> non_neg_integer().
fractional_ms([]) ->
    0;
fractional_ms(Fraction) when is_list(Fraction) ->
    Normalized =
        case length(Fraction) of
            Len when Len >= 3 -> lists:sublist(Fraction, 3);
            Len when Len > 0 -> Fraction ++ lists:duplicate(3 - Len, $0);
            _ -> "000"
        end,
    try list_to_integer(Normalized) of
        Value -> Value
    catch
        error:badarg -> 0
    end;
fractional_ms(_) ->
    0.

-spec check_user_data_differs(map(), map()) -> boolean().
check_user_data_differs(CurrentUserData, NewUserData) ->
    NormalizedCurrentUserData = user_utils:normalize_user(CurrentUserData),
    NormalizedNewUserData = user_utils:normalize_user(NewUserData),
    CheckedFields = user_utils:partial_user_fields(),
    lists:any(
        fun(Field) ->
            user_field_differs(Field, NormalizedCurrentUserData, NormalizedNewUserData)
        end,
        CheckedFields
    ).

-spec user_field_differs(binary(), map(), map()) -> boolean().
user_field_differs(Field, CurrentUserData, NewUserData) ->
    case maps:is_key(Field, NewUserData) of
        false ->
            false;
        true ->
            CurrentValue = maps:get(Field, CurrentUserData, missing_field_value(Field)),
            NewValue = maps:get(Field, NewUserData, undefined),
            CurrentValue =/= NewValue
    end.

%% Micup: user data stored before a cosmetic field existed wears nothing, so an explicit null
%% for it is not a change and does not cost a large guild a GUILD_MEMBER_UPDATE.
-spec missing_field_value(binary()) -> null | undefined.
missing_field_value(<<"avatar_decoration_data">>) -> null;
missing_field_value(<<"avatar_ultra_data">>) -> null;
missing_field_value(<<"nameplate_data">>) -> null;
missing_field_value(<<"name_style">>) -> null;
missing_field_value(_Field) -> undefined.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

check_user_data_differs_ultra_predates_test() ->
    Predates = #{<<"id">> => <<"42">>},
    NoUltra = #{<<"id">> => <<"42">>, <<"avatar_ultra_data">> => null},
    UltraData = #{<<"asset">> => <<"a_7c8d9e0f">>, <<"item_id">> => <<"3003">>},
    Ultra = #{<<"id">> => <<"42">>, <<"avatar_ultra_data">> => UltraData},
    ?assertNot(check_user_data_differs(Predates, NoUltra)),
    ?assert(check_user_data_differs(Predates, Ultra)),
    ?assert(check_user_data_differs(Ultra, NoUltra)).

check_user_data_differs_cosmetics_test() ->
    Ring = #{<<"asset">> => <<"a_1a2b3c4d">>, <<"item_id">> => <<"1001">>},
    NewRing = #{<<"asset">> => <<"5e6f7a8b">>, <<"item_id">> => <<"1001">>},
    Plate = #{<<"asset">> => <<"5e6f7a8b">>, <<"item_id">> => <<"2002">>},
    Worn = #{
        <<"id">> => <<"42">>,
        <<"avatar_decoration_data">> => Ring,
        <<"nameplate_data">> => null
    },
    NewImage = Worn#{<<"avatar_decoration_data">> => NewRing},
    TakenOff = Worn#{<<"avatar_decoration_data">> => null},
    NameplateOn = Worn#{<<"nameplate_data">> => Plate},
    Predates = #{<<"id">> => <<"42">>},
    ?assert(check_user_data_differs(Worn, NewImage)),
    ?assert(check_user_data_differs(Worn, TakenOff)),
    ?assert(check_user_data_differs(Worn, NameplateOn)),
    ?assertNot(check_user_data_differs(Worn, Worn)),
    ?assertNot(check_user_data_differs(Predates, TakenOff)),
    ?assertNot(check_user_data_differs(Worn, Predates)),
    ?assert(check_user_data_differs(Predates, NewImage)).

check_user_data_differs_name_style_test() ->
    Solid = #{<<"font_id">> => 3, <<"colors">> => [16#ff5e68]},
    Gradient = #{<<"font_id">> => 3, <<"colors">> => [16#ff5e68, 16#7b5cff]},
    Predates = #{<<"id">> => <<"42">>},
    Unstyled = #{<<"id">> => <<"42">>, <<"name_style">> => null},
    Styled = #{<<"id">> => <<"42">>, <<"name_style">> => Solid},
    ?assertNot(check_user_data_differs(Predates, Unstyled)),
    ?assert(check_user_data_differs(Predates, Styled)),
    ?assert(check_user_data_differs(Styled, Unstyled)),
    ?assert(check_user_data_differs(Styled, Styled#{<<"name_style">> => Gradient})),
    ?assertNot(check_user_data_differs(Styled, Styled)),
    ?assertNot(check_user_data_differs(Styled, Predates)).

check_user_data_differs_missing_field_test() ->
    Current = #{<<"id">> => <<"123">>, <<"username">> => <<"test">>},
    New = #{<<"id">> => <<"123">>},
    ?assertEqual(false, check_user_data_differs(Current, New)).

check_user_data_differs_normalizes_equivalent_user_ids_test() ->
    Current = #{<<"id">> => 123, <<"username">> => <<"test">>},
    New = #{<<"id">> => <<"123">>, <<"username">> => <<"test">>},
    ?assertEqual(false, check_user_data_differs(Current, New)).

-endif.
