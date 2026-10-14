%% SPDX-License-Identifier: AGPL-3.0-or-later

%% Who may scrape /_metrics: loopback (127.0.0.0/8, ::1) always, plus the networks listed in
%% FLUXER_METRICS_ALLOWED_CIDRS (comma separated, parsed once at config load; an invalid entry
%% stops the gateway). Same rules as the Node and Rust services.
-module(gateway_metrics_access).
-typing([eqwalizer]).

-export([parse_allowed_cidrs/1, is_peer_allowed/2]).
-export_type([network/0]).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").
-endif.

-type network() :: {inet:ip_address(), 0..128}.

-spec parse_allowed_cidrs(binary() | undefined) -> [network()].
parse_allowed_cidrs(undefined) ->
    [];
parse_allowed_cidrs(Bin) when is_binary(Bin) ->
    Entries = [string:trim(Part) || Part <- string:split(binary_to_list(Bin), ",", all)],
    [parse_cidr(Entry) || Entry <- Entries, Entry =/= ""].

-spec is_peer_allowed(inet:ip_address(), [network()]) -> boolean().
is_peer_allowed({127, _, _, _}, _Networks) ->
    true;
is_peer_allowed({0, 0, 0, 0, 0, 0, 0, 1}, _Networks) ->
    true;
is_peer_allowed({0, 0, 0, 0, 0, 16#ffff, Hi, Lo}, Networks) ->
    is_peer_allowed({Hi bsr 8, Hi band 255, Lo bsr 8, Lo band 255}, Networks);
is_peer_allowed(Ip, Networks) ->
    lists:any(fun({Network, Prefix}) -> in_network(Ip, Network, Prefix) end, Networks).

-spec parse_cidr(string()) -> network().
parse_cidr(Entry) ->
    case string:split(Entry, "/") of
        [Address] -> network(Entry, Address, undefined);
        [Address, Prefix] -> network(Entry, Address, Prefix)
    end.

-spec network(string(), string(), string() | undefined) -> network().
network(Entry, Address, Prefix) ->
    case inet:parse_strict_address(Address) of
        {ok, {_, _, _, _} = Ip} -> {Ip, prefix(Entry, Prefix, 32)};
        {ok, Ip} -> {Ip, prefix(Entry, Prefix, 128)};
        {error, _} -> erlang:error({invalid_metrics_allowed_cidr, Entry})
    end.

-spec prefix(string(), string() | undefined, 32 | 128) -> 0..128.
prefix(_Entry, undefined, Bits) ->
    Bits;
prefix(Entry, Prefix, Bits) ->
    case is_prefix_length(Prefix) andalso list_to_integer(Prefix) =< Bits of
        true -> list_to_integer(Prefix);
        false -> erlang:error({invalid_metrics_allowed_cidr, Entry})
    end.

%% One to three ASCII digits, as the Node and Rust parsers want; list_to_integer takes "+24".
-spec is_prefix_length(string()) -> boolean().
is_prefix_length(Prefix) ->
    Prefix =/= [] andalso length(Prefix) =< 3 andalso lists:all(fun is_digit/1, Prefix).

-spec is_digit(char()) -> boolean().
is_digit(Char) ->
    Char >= $0 andalso Char =< $9.

-spec in_network(inet:ip_address(), inet:ip_address(), 0..128) -> boolean().
in_network({_, _, _, _} = Ip, {_, _, _, _} = Network, Prefix) ->
    same_prefix(ip_to_integer(Ip), ip_to_integer(Network), 32 - Prefix);
in_network({_, _, _, _, _, _, _, _} = Ip, {_, _, _, _, _, _, _, _} = Network, Prefix) ->
    same_prefix(ip_to_integer(Ip), ip_to_integer(Network), 128 - Prefix);
in_network(_Ip, _Network, _Prefix) ->
    false.

-spec same_prefix(non_neg_integer(), non_neg_integer(), integer()) -> boolean().
same_prefix(Left, Right, HostBits) ->
    (Left bxor Right) bsr HostBits =:= 0.

-spec ip_to_integer(inet:ip_address()) -> non_neg_integer().
ip_to_integer({A, B, C, D}) ->
    (A bsl 24) bor (B bsl 16) bor (C bsl 8) bor D;
ip_to_integer(Ip) ->
    lists:foldl(fun(Part, Acc) -> (Acc bsl 16) bor Part end, 0, tuple_to_list(Ip)).

-ifdef(TEST).

loopback_peers_are_always_allowed_test() ->
    ?assert(is_peer_allowed({127, 0, 0, 1}, [])),
    ?assert(is_peer_allowed({127, 0, 0, 2}, [])),
    ?assert(is_peer_allowed({0, 0, 0, 0, 0, 0, 0, 1}, [])),
    ?assert(is_peer_allowed({0, 0, 0, 0, 0, 16#ffff, 16#7f00, 1}, [])),
    ?assert(is_peer_allowed({0, 0, 0, 0, 0, 16#ffff, 16#7f00, 2}, [])).

only_commas_separate_entries_test() ->
    Networks = parse_allowed_cidrs(<<" 10.77.0.0/24 , ,fd00:77::/64 ">>),
    ?assert(is_peer_allowed({10, 77, 0, 3}, Networks)),
    ?assert(is_peer_allowed({16#fd00, 16#77, 0, 0, 0, 0, 0, 5}, Networks)).

%% The same entries the Node and Rust parsers refuse.
entries_the_other_parsers_refuse_are_refused_test() ->
    lists:foreach(
        fun(Value) ->
            ?assertError({invalid_metrics_allowed_cidr, _}, parse_allowed_cidrs(Value))
        end,
        [<<"10.0.0.0/24 10.1.0.0/24">>, <<"10.0.0.0/+24">>, <<"10.0.0.0/0024">>]
    ).

empty_list_allows_only_loopback_test() ->
    ?assertNot(is_peer_allowed({10, 77, 0, 3}, [])),
    ?assertNot(is_peer_allowed({8, 8, 8, 8}, [])),
    ?assertNot(is_peer_allowed({16#fe80, 0, 0, 0, 0, 0, 0, 1}, [])).

peers_inside_allowed_networks_are_allowed_test() ->
    Networks = parse_allowed_cidrs(<<"10.77.0.0/24,fd00:77::/64">>),
    ?assert(is_peer_allowed({10, 77, 0, 3}, Networks)),
    ?assert(is_peer_allowed({0, 0, 0, 0, 0, 16#ffff, 16#0a4d, 3}, Networks)),
    ?assert(is_peer_allowed({16#fd00, 16#77, 0, 0, 0, 0, 0, 5}, Networks)),
    ?assertNot(is_peer_allowed({10, 77, 1, 3}, Networks)),
    ?assertNot(is_peer_allowed({16#fd00, 16#78, 0, 0, 0, 0, 0, 5}, Networks)).

zero_length_prefix_allows_every_peer_of_its_family_test() ->
    AnyIpv4 = parse_allowed_cidrs(<<"0.0.0.0/0">>),
    ?assert(is_peer_allowed({8, 8, 8, 8}, AnyIpv4)),
    ?assertNot(is_peer_allowed({16#2001, 16#db8, 0, 0, 0, 0, 0, 1}, AnyIpv4)).

-endif.
