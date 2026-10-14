%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_ip_connections).
-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").
-endif.

-typing([eqwalizer]).

-export([
    acquire/1,
    release/1,
    note_disconnect/1,
    note_identified/0,
    admit_identify/0,
    node_connection_count/0,
    node_connection_limit/0,
    node_hard_limit/0
]).

-define(CONNECTION_TABLE, gateway_ip_connections).
-define(OWNER_TABLE, gateway_ip_connection_owners).
-define(UNIDENTIFIED_TABLE, gateway_unidentified_connections).
-define(MAX_CONNECTIONS_PER_IP, 256).
-define(OWNER_SWEEP_INTERVAL_MS, 60000).

-spec acquire(term()) ->
    ok | {error, too_many_connections | at_capacity | unidentified_at_capacity}.
acquire(PeerIP) when is_binary(PeerIP), PeerIP =/= <<"unknown">> ->
    case gateway_handler_rate_limit:rate_limits_disabled() of
        true ->
            ok;
        false ->
            ensure_tables(),
            do_acquire(PeerIP)
    end;
acquire(_) ->
    ok.

-spec release(term()) -> ok.
release(PeerIP) when is_binary(PeerIP), PeerIP =/= <<"unknown">> ->
    release_owner({self(), limit_key(PeerIP)});
release(_) ->
    ok.

-spec note_disconnect(gateway_handler:state()) -> ok.
note_disconnect(State) ->
    release(maps:get(peer_ip, State, undefined)).

%% The socket sent Identify or Resume: it leaves the unidentified budget.
-spec note_identified() -> ok.
note_identified() ->
    forget_unidentified(self()).

%% The soft limit stops new sessions (Identify). Resume never comes here, so it gets in up to the
%% hard limit. Off while FLUXER_DISABLE_RATE_LIMITS is on, like acquire/1. Sessions count as well
%% as sockets: a closed socket's session stays for Resume and still holds its memory.
-spec admit_identify() -> ok | {error, identify_at_capacity}.
admit_identify() ->
    case gateway_handler_rate_limit:rate_limits_disabled() of
        true -> ok;
        false -> admit_identify(node_connection_limit())
    end.

-spec admit_identify(integer()) -> ok | {error, identify_at_capacity}.
admit_identify(Soft) ->
    case Soft > 0 andalso node_load() > Soft of
        true -> reject(identify_at_capacity, identify_at_capacity);
        false -> ok
    end.

%% Gateway rollout overrides the environment soft limit when positive.
-spec node_connection_limit() -> integer().
node_connection_limit() ->
    case gateway_rollout_config:max_connections() of
        Override when Override > 0 -> Override;
        _ ->
            case fluxer_gateway_env:get(max_connections) of
                Limit when is_integer(Limit) -> Limit;
                _ -> 0
            end
    end.

%% Hard limit = soft limit + 5% (at least one). The gap is left for sessions that come back with
%% Resume after a network drop.
-spec node_hard_limit() -> non_neg_integer().
node_hard_limit() ->
    case node_connection_limit() of
        Soft when Soft > 0 -> Soft + max(1, Soft div 20);
        _ -> 0
    end.

%% TEMPORARY: with one gateway node handling every role, the sessions counted here are the ones
%% this node's session shards own. With FLUXER_GATEWAY_CLUSTER_ENABLED and more than one gateway
%% node, a session's owner can be another node. Trigger: a second gateway node. Then move the
%% check to the owner shard where it starts the session (handle_start_call answering
%% {error, at_capacity}, which the socket already holds and retries).
-spec node_load() -> non_neg_integer().
node_load() ->
    max(node_connection_count(), gateway_connection_metrics:session_count()).

%% WebSockets holding a slot on this node: one owner row per connection.
-spec node_connection_count() -> non_neg_integer().
node_connection_count() ->
    case ets:info(?OWNER_TABLE, size) of
        Size when is_integer(Size) -> Size;
        _ -> 0
    end.

-spec do_acquire(binary()) ->
    ok | {error, too_many_connections | at_capacity | unidentified_at_capacity}.
do_acquire(PeerIP) ->
    Key = limit_key(PeerIP),
    try ets:update_counter(?CONNECTION_TABLE, Key, {2, 1}, {Key, 0}) of
        Count when Count > ?MAX_CONNECTIONS_PER_IP ->
            _ = ets:update_counter(?CONNECTION_TABLE, Key, {2, -1, 0, 0}),
            reject({too_many_connections, family(PeerIP)}, too_many_connections);
        _ ->
            acquire_ipv6_48(PeerIP, Key)
    catch
        error:badarg -> ok
    end.

%% With FLUXER_GATEWAY_MAX_CONNECTIONS_PER_IPV6_48 above zero, each IPv6 /48 also shares one count
%% (one allocation often holds 65,536 /64s). The owner row keeps the bucket, so release frees
%% exactly what acquire took.
-spec acquire_ipv6_48(binary(), binary()) ->
    ok | {error, too_many_connections | at_capacity | unidentified_at_capacity}.
acquire_ipv6_48(PeerIP, Key) ->
    case ipv6_48_bucket(PeerIP) of
        none -> admit(Key, none);
        {Bucket, Limit} -> admit_ipv6_48(Key, Bucket, increment(Bucket) > Limit)
    end.

-spec admit_ipv6_48(binary(), binary(), boolean()) ->
    ok | {error, too_many_connections | at_capacity | unidentified_at_capacity}.
admit_ipv6_48(Key, Bucket, true) ->
    ok = decrement(Bucket),
    ok = decrement(Key),
    reject(too_many_connections_ipv6_48, too_many_connections);
admit_ipv6_48(Key, Bucket, false) ->
    admit(Key, Bucket).

%% The slot is taken (owner row) before the node total is checked, so concurrent accepts cannot
%% pass the hard limit.
-spec admit(binary(), binary() | none) -> ok | {error, at_capacity | unidentified_at_capacity}.
admit(Key, Bucket) ->
    ok = track_owner(Key, Bucket),
    Hard = node_hard_limit(),
    case Hard > 0 andalso node_connection_count() > Hard of
        true ->
            ok = release_owner({self(), Key}),
            reject(at_capacity, at_capacity);
        false ->
            admit_unidentified(Key, max_unidentified_connections())
    end.

%% With FLUXER_GATEWAY_MAX_UNIDENTIFIED_CONNECTIONS above zero, sockets that have not sent Identify
%% or Resume yet share their own budget, so they alone cannot fill the node limit. One row per
%% socket, taken like the slot: note_identified/0 and release_owner/1 remove it, so the owner
%% sweep also clears it for a killed socket.
-spec admit_unidentified(binary(), integer()) -> ok | {error, unidentified_at_capacity}.
admit_unidentified(Key, Budget) when Budget > 0 ->
    ok = track_unidentified(),
    case unidentified_count() > Budget of
        true ->
            ok = release_owner({self(), Key}),
            reject(unidentified_at_capacity, unidentified_at_capacity);
        false ->
            ok
    end;
admit_unidentified(_Key, _Budget) ->
    ok.

-spec max_unidentified_connections() -> integer().
max_unidentified_connections() ->
    case fluxer_gateway_env:get(max_unidentified_connections) of
        Budget when is_integer(Budget) -> Budget;
        _ -> 0
    end.

-spec unidentified_count() -> non_neg_integer().
unidentified_count() ->
    case ets:info(?UNIDENTIFIED_TABLE, size) of
        Size when is_integer(Size) -> Size;
        _ -> 0
    end.

-spec track_unidentified() -> ok.
track_unidentified() ->
    try
        _ = ets:insert(?UNIDENTIFIED_TABLE, {self()}),
        ok
    catch
        error:badarg -> ok
    end.

-spec forget_unidentified(pid()) -> ok.
forget_unidentified(Pid) ->
    try
        _ = ets:delete(?UNIDENTIFIED_TABLE, Pid),
        ok
    catch
        error:badarg -> ok
    end.

-spec reject(gateway_connection_metrics:reason(), Error) -> {error, Error} when
    Error ::
        too_many_connections | at_capacity | unidentified_at_capacity | identify_at_capacity.
reject(Reason, Error) ->
    ok = gateway_connection_metrics:record_rejection(Reason),
    {error, Error}.

%% Anything that is not a plain IPv6 address, IPv4-mapped included, counts as IPv4.
-spec family(binary()) -> gateway_connection_metrics:family().
family(PeerIP) ->
    case inet:parse_ipv6strict_address(binary_to_list(PeerIP)) of
        {ok, {0, 0, 0, 0, 0, 16#ffff, _, _}} -> ipv4;
        {ok, _} -> ipv6;
        {error, _} -> ipv4
    end.

%% With FLUXER_GATEWAY_COUNT_IPV6_BY_64, IPv6 addresses in one /64 count as one address for the
%% per-IP limit (a subscriber usually gets the whole /64). Set it at startup only: changing it at
%% runtime moves the keys of open connections.
-spec limit_key(binary()) -> binary().
limit_key(PeerIP) ->
    case fluxer_gateway_env:get(count_ipv6_by_64) of
        true -> prefix_or_address(ipv6_prefix(PeerIP, 64), PeerIP);
        _ -> PeerIP
    end.

-spec prefix_or_address(binary() | none, binary()) -> binary().
prefix_or_address(none, PeerIP) -> PeerIP;
prefix_or_address(Prefix, _PeerIP) -> Prefix.

-spec ipv6_48_bucket(binary()) -> {binary(), pos_integer()} | none.
ipv6_48_bucket(PeerIP) ->
    case fluxer_gateway_env:get(max_connections_per_ipv6_48) of
        Limit when is_integer(Limit), Limit > 0 -> bucket_limit(ipv6_prefix(PeerIP, 48), Limit);
        _ -> none
    end.

-spec bucket_limit(binary() | none, pos_integer()) -> {binary(), pos_integer()} | none.
bucket_limit(none, _Limit) -> none;
bucket_limit(Bucket, Limit) -> {Bucket, Limit}.

%% 2001:db8:1:2::7 gives <<"2001:db8:1:2::/64">> or <<"2001:db8:1::/48">>. IPv4 and IPv6
%% addresses whose prefix is all zero (::ffff:a.b.c.d, ::1) have none and keep their own count.
-spec ipv6_prefix(binary(), 48 | 64) -> binary() | none.
ipv6_prefix(PeerIP, Bits) ->
    case inet:parse_ipv6strict_address(binary_to_list(PeerIP)) of
        {ok, {A, B, C, D, _, _, _, _}} -> prefix_key({A, B, C, prefix_fourth(D, Bits)}, Bits);
        _ -> none
    end.

-spec prefix_fourth(0..65535, 48 | 64) -> 0..65535.
prefix_fourth(D, 64) -> D;
prefix_fourth(_D, 48) -> 0.

-spec prefix_key({0..65535, 0..65535, 0..65535, 0..65535}, 48 | 64) -> binary() | none.
prefix_key({0, 0, 0, 0}, _Bits) ->
    none;
prefix_key({A, B, C, D}, Bits) ->
    case inet:ntoa({A, B, C, D, 0, 0, 0, 0}) of
        Text when is_list(Text) -> iolist_to_binary([Text, "/", integer_to_list(Bits)]);
        {error, einval} -> none
    end.

-spec increment(binary()) -> integer().
increment(Key) ->
    try ets:update_counter(?CONNECTION_TABLE, Key, {2, 1}, {Key, 0}) of
        Count when is_integer(Count) -> Count
    catch
        error:badarg -> 0
    end.

-spec track_owner(binary(), binary() | none) -> ok.
track_owner(Key, Bucket) ->
    try
        _ = ets:insert(?OWNER_TABLE, {{self(), Key}, Bucket}),
        ok
    catch
        error:badarg -> ok
    end.

-spec take_owner({pid(), binary()}) -> {true, binary() | none} | false.
take_owner(Owner) ->
    try ets:take(?OWNER_TABLE, Owner) of
        [{_, Bucket}] -> {true, Bucket};
        _ -> false
    catch
        error:badarg -> false
    end.

-spec release_owner({pid(), binary()}) -> ok.
release_owner({Pid, Key} = Owner) ->
    ok = forget_unidentified(Pid),
    case take_owner(Owner) of
        {true, Bucket} ->
            ok = decrement(Key),
            decrement(Bucket);
        false ->
            ok
    end.

-spec decrement(binary() | none) -> ok.
decrement(none) ->
    ok;
decrement(PeerIP) ->
    try update_connection_count(PeerIP) of
        ok -> ok
    catch
        error:badarg -> ok
    end.

-spec update_connection_count(binary()) -> ok.
update_connection_count(PeerIP) ->
    case ets:update_counter(?CONNECTION_TABLE, PeerIP, {2, -1, 0, 0}) of
        0 -> forget_if_zero(PeerIP);
        _ -> ok
    end.

%% Deletes the row only while it still reads 0: another socket may have taken the key again
%% between the decrement and the delete.
-spec forget_if_zero(binary()) -> ok.
forget_if_zero(Key) ->
    _ = ets:select_delete(?CONNECTION_TABLE, [{{Key, 0}, [], [true]}]),
    ok.

-spec ensure_tables() -> ok.
ensure_tables() ->
    ensure_table(?CONNECTION_TABLE),
    ensure_table(?UNIDENTIFIED_TABLE),
    ensure_owner_table().

-spec ensure_table(atom()) -> ok.
ensure_table(Table) ->
    case ets:whereis(Table) of
        undefined ->
            _ = create_table(Table),
            ok;
        _ ->
            ok
    end.

-spec ensure_owner_table() -> ok.
ensure_owner_table() ->
    case ets:whereis(?OWNER_TABLE) of
        undefined -> create_owner_table();
        _ -> ok
    end.

-spec create_owner_table() -> ok.
create_owner_table() ->
    case create_table(?OWNER_TABLE) of
        created -> schedule_owner_sweep();
        exists -> ok
    end.

-spec create_table(atom()) -> created | exists.
create_table(Table) ->
    try
        _ = ets:new(Table, table_options()),
        created
    catch
        error:badarg -> exists
    end.

-spec table_options() -> list().
table_options() ->
    [named_table, public, set, {write_concurrency, true}, {read_concurrency, true}] ++
        guild_ets_utils:heir_options().

-spec schedule_owner_sweep() -> ok.
schedule_owner_sweep() ->
    case ets:whereis(?OWNER_TABLE) of
        undefined -> ok;
        Tid -> spawn_owner_sweep(Tid)
    end.

-spec spawn_owner_sweep(ets:table()) -> ok.
spawn_owner_sweep(Tid) ->
    _ = spawn(fun() -> owner_sweep_loop(Tid) end),
    ok.

-spec owner_sweep_loop(ets:table()) -> ok.
owner_sweep_loop(Table) ->
    ok = gateway_retry_timer:wait(?OWNER_SWEEP_INTERVAL_MS),
    case reclaim_dead_owners(Table) of
        ok -> owner_sweep_loop(Table);
        gone -> ok
    end.

-spec reclaim_dead_owners(ets:table()) -> ok | gone.
reclaim_dead_owners(Table) ->
    try ets:select(Table, [{{'$1', '_'}, [], ['$1']}]) of
        Owners -> lists:foreach(fun reclaim_owner/1, Owners)
    catch
        error:badarg -> gone
    end.

-spec reclaim_owner({pid(), binary()}) -> ok.
reclaim_owner({Pid, _Key} = Owner) ->
    case is_process_alive(Pid) of
        true -> ok;
        false -> release_owner(Owner)
    end.

-ifdef(TEST).

with_rate_limits_enabled(Fun) ->
    OldValue = os:getenv("FLUXER_DISABLE_RATE_LIMITS"),
    os:unsetenv("FLUXER_DISABLE_RATE_LIMITS"),
    try
        Fun()
    after
        restore_env("FLUXER_DISABLE_RATE_LIMITS", OldValue)
    end.

restore_env(Key, false) ->
    os:unsetenv(Key);
restore_env(Key, Value) ->
    os:putenv(Key, Value).

connection_cap_blocks_over_limit_test() ->
    with_rate_limits_enabled(fun() ->
        IP = <<"198.51.100.20">>,
        reset_connections(IP),
        assert_connection_cap_allows_limit(IP),
        ?assertEqual({error, too_many_connections}, acquire(IP)),
        ok = release(IP),
        ?assertEqual(ok, acquire(IP)),
        reset_connections(IP)
    end).

assert_connection_cap_allows_limit(IP) ->
    lists:foreach(
        fun(_) -> ?assertEqual(ok, acquire(IP)) end,
        lists:seq(1, ?MAX_CONNECTIONS_PER_IP)
    ).

connection_release_decrements_test() ->
    with_rate_limits_enabled(fun() ->
        IP = <<"198.51.100.30">>,
        reset_connections(IP),
        ok = acquire(IP),
        ok = release(IP),
        ?assertEqual([], ets:lookup(?CONNECTION_TABLE, IP))
    end).

killed_connection_owner_releases_ip_count_test() ->
    with_rate_limits_enabled(fun() ->
        with_fast_owner_sweep(fun assert_killed_connection_count_is_released/0)
    end).

assert_killed_connection_count_is_released() ->
    with_heir_owner(fun assert_killed_connection_count_drops/0).

assert_killed_connection_count_drops() ->
    IP = <<"198.51.100.80">>,
    Holder = start_connection_holder(IP),
    ?assertEqual(1, connection_count(IP)),
    kill_connection_holder(Holder),
    ?assert(await_connection_count(IP, 0, 300)).

released_connection_is_not_released_twice_test() ->
    with_rate_limits_enabled(fun() ->
        with_fast_owner_sweep(fun assert_released_connection_is_not_double_released/0)
    end).

assert_released_connection_is_not_double_released() ->
    with_heir_owner(fun assert_released_connection_keeps_peer_count/0).

assert_released_connection_keeps_peer_count() ->
    IP = <<"198.51.100.90">>,
    Holder = start_connection_holder(IP),
    Releaser = start_connection_holder(IP),
    ?assertEqual(2, connection_count(IP)),
    release_connection_holder(Releaser),
    ?assert(await_connection_count(IP, 1, 300)),
    timer:sleep(100),
    ?assertEqual(1, connection_count(IP)),
    stop_connection_holder(Holder).

with_fast_owner_sweep(Fun) ->
    meck:new(gateway_retry_timer, [passthrough]),
    meck:expect(gateway_retry_timer, wait, fun(_) -> timer:sleep(5) end),
    try
        Fun()
    after
        meck:unload(gateway_retry_timer)
    end.

with_heir_owner(Fun) ->
    drop_table(?CONNECTION_TABLE),
    drop_table(?OWNER_TABLE),
    drop_table(?UNIDENTIFIED_TABLE),
    {ok, _} = guild_ets_owner:start_link(),
    try
        Fun()
    after
        gen_server:stop(guild_ets_owner)
    end.

drop_table(Table) ->
    case ets:whereis(Table) of
        undefined ->
            ok;
        _ ->
            ets:delete(Table),
            ok
    end.

start_connection_holder(IP) ->
    Parent = self(),
    Pid = spawn(fun() -> hold_connection(Parent, IP) end),
    receive
        {connection_acquired, Pid} -> Pid
    after 1000 -> error(connection_holder_timeout)
    end.

hold_connection(Parent, IP) ->
    ok = acquire(IP),
    Parent ! {connection_acquired, self()},
    hold_acquired(Parent, IP).

hold_acquired(Parent, IP) ->
    receive
        identify ->
            ok = gateway_ip_connections:note_identified(),
            Parent ! {identified, self()},
            hold_acquired(Parent, IP);
        release ->
            release(IP);
        stop ->
            ok
    after 30000 -> ok
    end.

identify_connection_holder(Pid) ->
    Pid ! identify,
    receive
        {identified, Pid} -> ok
    after 1000 -> error(connection_holder_identify_timeout)
    end.

kill_connection_holder(Pid) ->
    exit(Pid, kill),
    await_connection_holder_down(Pid).

release_connection_holder(Pid) ->
    Pid ! release,
    await_connection_holder_down(Pid).

stop_connection_holder(Pid) ->
    Pid ! stop,
    await_connection_holder_down(Pid).

await_connection_holder_down(Pid) ->
    Ref = erlang:monitor(process, Pid),
    receive
        {'DOWN', Ref, process, Pid, _Reason} -> ok
    after 1000 -> error(connection_holder_down_timeout)
    end.

connection_count(IP) ->
    try ets:lookup(?CONNECTION_TABLE, IP) of
        [{_, Count}] -> Count;
        [] -> 0
    catch
        error:badarg -> 0
    end.

await_connection_count(IP, Expected, 0) ->
    connection_count(IP) =:= Expected;
await_connection_count(IP, Expected, Attempts) ->
    case connection_count(IP) =:= Expected of
        true ->
            true;
        false ->
            timer:sleep(10),
            await_connection_count(IP, Expected, Attempts - 1)
    end.

reset_connections(IP) ->
    _ = take_owner({self(), IP}),
    drop_connection_row(IP).

drop_connection_row(IP) ->
    case ets:whereis(?CONNECTION_TABLE) of
        undefined ->
            ok;
        _ ->
            ets:delete(?CONNECTION_TABLE, IP),
            ok
    end.

with_env_key(Key, Value, Fun) ->
    Previous = fluxer_gateway_env:get(Key),
    _ = fluxer_gateway_env:patch(#{Key => Value}),
    try
        Fun()
    after
        _ = fluxer_gateway_env:patch(#{Key => Previous})
    end.

with_node_limit(Limit, Fun) -> with_env_key(max_connections, Limit, Fun).

with_rollout_limit(Limit, Fun) ->
    Previous = persistent_term:get(gateway_rollout_config, undefined),
    persistent_term:put(gateway_rollout_config, #{<<"max_connections">> => Limit}),
    try
        Fun()
    after
        case Previous of
            undefined -> persistent_term:erase(gateway_rollout_config);
            _ -> persistent_term:put(gateway_rollout_config, Previous)
        end
    end.

node_rollout_limit_overrides_and_zero_uses_env_test() ->
    with_node_limit(40, fun() ->
        with_rollout_limit(18, fun() ->
            ?assertEqual(18, node_connection_limit()),
            ?assertEqual(19, node_hard_limit())
        end),
        with_rollout_limit(0, fun() -> ?assertEqual(40, node_connection_limit()) end)
    end).

lowering_rollout_limit_keeps_existing_connections_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_node_limit(0, fun() ->
                A = start_connection_holder(<<"198.51.100.151">>),
                B = start_connection_holder(<<"198.51.100.152">>),
                try
                    with_rollout_limit(1, fun() ->
                        ?assertEqual(2, node_connection_count()),
                        ?assert(lists:all(fun erlang:is_process_alive/1, [A, B])),
                        ?assertEqual({error, at_capacity}, acquire(<<"198.51.100.153">>)),
                        ?assertEqual(2, node_connection_count())
                    end)
                after
                    stop_connection_holder(A),
                    stop_connection_holder(B)
                end
            end)
        end)
    end).

with_ipv6_by_64(Fun) -> with_env_key(count_ipv6_by_64, true, Fun).

with_ipv6_48_limit(Limit, Fun) -> with_env_key(max_connections_per_ipv6_48, Limit, Fun).

ip_n(N) -> iolist_to_binary(io_lib:format("203.0.113.~b", [N rem 250])).

v6(Prefix, N) -> iolist_to_binary(io_lib:format("~s::~.16b", [Prefix, N])).

await_node_count(Expected, 0) ->
    node_connection_count() =:= Expected;
await_node_count(Expected, Attempts) ->
    case node_connection_count() =:= Expected of
        true ->
            true;
        false ->
            timer:sleep(10),
            await_node_count(Expected, Attempts - 1)
    end.

node_hard_limit_adds_five_percent_test() ->
    Cases = [{2500, 2625}, {3, 4}, {1, 2}, {40, 42}, {0, 0}, {-5, 0}],
    lists:foreach(
        fun({Soft, Hard}) ->
            with_node_limit(Soft, fun() -> ?assertEqual(Hard, node_hard_limit()) end)
        end,
        Cases
    ).

node_capacity_hard_limit_rejects_new_socket_only_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            %% soft 2, hard 3
            with_node_limit(2, fun assert_hard_limit_rejects_new_socket_only/0)
        end)
    end).

assert_hard_limit_rejects_new_socket_only() ->
    gateway_connection_metrics:reset_for_tests(),
    A = start_connection_holder(<<"198.51.100.101">>),
    B = start_connection_holder(<<"198.51.100.102">>),
    C = start_connection_holder(<<"198.51.100.103">>),
    ?assertEqual({error, at_capacity}, acquire(<<"198.51.100.104">>)),
    ?assertEqual(3, node_connection_count()),
    ?assertEqual(0, connection_count(<<"198.51.100.104">>)),
    ?assert(lists:all(fun erlang:is_process_alive/1, [A, B, C])),
    ?assertEqual(1, maps:get(at_capacity, gateway_connection_metrics:snapshot())),
    release_connection_holder(C),
    ?assert(await_node_count(2, 300)),
    ?assertEqual(ok, acquire(<<"198.51.100.104">>)),
    ok = release(<<"198.51.100.104">>),
    lists:foreach(fun stop_connection_holder/1, [A, B]).

admit_identify_uses_soft_limit_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_node_limit(2, fun assert_admit_identify_uses_soft_limit/0)
        end)
    end).

assert_admit_identify_uses_soft_limit() ->
    gateway_connection_metrics:reset_for_tests(),
    A = start_connection_holder(<<"198.51.100.105">>),
    B = start_connection_holder(<<"198.51.100.106">>),
    ?assertEqual(ok, admit_identify()),
    C = start_connection_holder(<<"198.51.100.107">>),
    ?assertEqual({error, identify_at_capacity}, admit_identify()),
    ?assertEqual(1, maps:get(identify_at_capacity, gateway_connection_metrics:snapshot())),
    release_connection_holder(C),
    ?assert(await_node_count(2, 300)),
    ?assertEqual(ok, admit_identify()),
    lists:foreach(fun stop_connection_holder/1, [A, B]).

node_capacity_zero_is_unlimited_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_node_limit(0, fun() ->
                Holders = [start_connection_holder(ip_n(N)) || N <- lists:seq(1, 300)],
                ?assertEqual(300, node_connection_count()),
                ?assertEqual(ok, admit_identify()),
                lists:foreach(fun stop_connection_holder/1, Holders)
            end)
        end)
    end).

node_capacity_frees_killed_owner_test() ->
    with_rate_limits_enabled(fun() ->
        with_fast_owner_sweep(fun() ->
            with_heir_owner(fun() ->
                %% soft 1, hard 2
                with_node_limit(1, fun assert_killed_owner_frees_node_slot/0)
            end)
        end)
    end).

assert_killed_owner_frees_node_slot() ->
    H1 = start_connection_holder(<<"198.51.100.110">>),
    H2 = start_connection_holder(<<"198.51.100.111">>),
    ?assertEqual({error, at_capacity}, acquire(<<"198.51.100.112">>)),
    kill_connection_holder(H1),
    ?assert(await_node_count(1, 300)),
    ?assertEqual(ok, acquire(<<"198.51.100.112">>)),
    ok = release(<<"198.51.100.112">>),
    stop_connection_holder(H2).

node_capacity_off_when_rate_limits_disabled_test() ->
    Old = os:getenv("FLUXER_DISABLE_RATE_LIMITS"),
    os:putenv("FLUXER_DISABLE_RATE_LIMITS", "true"),
    try
        with_node_limit(1, fun() ->
            ?assertEqual(ok, acquire(<<"198.51.100.120">>)),
            ?assertEqual(ok, acquire(<<"198.51.100.121">>)),
            ?assertEqual(ok, acquire(<<"198.51.100.122">>)),
            ?assertEqual(ok, admit_identify())
        end)
    after
        restore_env("FLUXER_DISABLE_RATE_LIMITS", Old)
    end.

ip_limit_rejection_counts_address_family_test() ->
    with_rate_limits_enabled(fun() ->
        gateway_connection_metrics:reset_for_tests(),
        Keys = [<<"198.51.100.21">>, <<"2001:db8:c:1::1">>],
        [reset_connections(K) || K <- Keys],
        [assert_connection_cap_allows_limit(K) || K <- Keys],
        [?assertEqual({error, too_many_connections}, acquire(K)) || K <- Keys ++ Keys],
        Snapshot = gateway_connection_metrics:snapshot(),
        ?assertEqual(2, maps:get({too_many_connections, ipv4}, Snapshot)),
        ?assertEqual(2, maps:get({too_many_connections, ipv6}, Snapshot)),
        [reset_connections(K) || K <- Keys]
    end).

ipv6_full_address_by_default_test() ->
    with_rate_limits_enabled(fun() ->
        with_env_key(count_ipv6_by_64, false, fun() ->
            Keys = [<<"2001:db8:1:2::1">>, <<"2001:db8:1:2::2">>, <<"2001:db8:1:2::/64">>],
            [reset_connections(K) || K <- Keys],
            ok = acquire(<<"2001:db8:1:2::1">>),
            ok = acquire(<<"2001:db8:1:2::2">>),
            ?assertEqual(1, connection_count(<<"2001:db8:1:2::1">>)),
            ?assertEqual(0, connection_count(<<"2001:db8:1:2::/64">>)),
            [reset_connections(K) || K <- Keys]
        end)
    end).

ipv6_addresses_share_limit_per_64_when_enabled_test() ->
    with_rate_limits_enabled(fun() ->
        with_ipv6_by_64(fun() ->
            Key = <<"2001:db8:1:2::/64">>,
            reset_connections(Key),
            lists:foreach(
                fun(N) -> ?assertEqual(ok, acquire(v6(<<"2001:db8:1:2">>, N))) end,
                lists:seq(1, ?MAX_CONNECTIONS_PER_IP)
            ),
            ?assertEqual(
                {error, too_many_connections}, acquire(<<"2001:db8:1:2:ffff:ffff:ffff:ffff">>)
            ),
            ?assertEqual(?MAX_CONNECTIONS_PER_IP, connection_count(Key)),
            ?assertEqual(ok, acquire(<<"2001:db8:1:3::1">>)),
            reset_connections(Key),
            reset_connections(<<"2001:db8:1:3::/64">>)
        end)
    end).

ipv4_and_zero_prefix_ipv6_keep_full_address_test() ->
    with_rate_limits_enabled(fun() ->
        with_ipv6_by_64(fun() ->
            with_ipv6_48_limit(1, fun() ->
                Keys = [<<"::ffff:198.51.100.1">>, <<"198.51.100.1">>, <<"::1">>, <<"::2">>],
                [reset_connections(K) || K <- Keys],
                [?assertEqual(ok, acquire(K)) || K <- Keys],
                [?assertEqual(1, connection_count(K)) || K <- Keys],
                ?assertEqual(0, connection_count(<<"::/64">>)),
                ?assertEqual(0, connection_count(<<"::/48">>)),
                [reset_connections(K) || K <- Keys]
            end)
        end)
    end).

ipv6_release_uses_same_64_key_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_ipv6_by_64(fun() ->
                H = start_connection_holder(<<"2001:db8:5:6::1">>),
                ?assertEqual(1, connection_count(<<"2001:db8:5:6::/64">>)),
                release_connection_holder(H),
                ?assertEqual(0, connection_count(<<"2001:db8:5:6::/64">>)),
                ?assertEqual(0, node_connection_count())
            end)
        end)
    end).

ipv6_48_bucket_off_by_default_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_ipv6_48_limit(0, fun() ->
                ok = acquire(<<"2001:db8:b:1::1">>),
                ?assertEqual(1, connection_count(<<"2001:db8:b:1::1">>)),
                ?assertEqual(0, connection_count(<<"2001:db8:b::/48">>)),
                ok = release(<<"2001:db8:b:1::1">>)
            end)
        end)
    end).

ipv6_48_bucket_caps_addresses_across_64s_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_ipv6_48_limit(3, fun assert_ipv6_48_bucket_caps_addresses/0)
        end)
    end).

assert_ipv6_48_bucket_caps_addresses() ->
    gateway_connection_metrics:reset_for_tests(),
    Bucket = <<"2001:db8:7::/48">>,
    [First, Second, Third, Fourth] = [v6(<<"2001:db8:7:", N>>, 1) || N <- "1234"],
    [?assertEqual(ok, acquire(K)) || K <- [First, Second, Third]],
    ?assertEqual(3, connection_count(Bucket)),
    ?assertEqual({error, too_many_connections}, acquire(Fourth)),
    ?assertEqual(0, connection_count(Fourth)),
    ?assertEqual(3, connection_count(Bucket)),
    ?assertEqual(3, node_connection_count()),
    Snapshot = gateway_connection_metrics:snapshot(),
    ?assertEqual(1, maps:get(too_many_connections_ipv6_48, Snapshot)),
    ?assertEqual(0, maps:get({too_many_connections, ipv6}, Snapshot)),
    ?assertEqual(ok, acquire(<<"2001:db8:8::1">>)),
    ok = release(Second),
    ?assertEqual(2, connection_count(Bucket)),
    ?assertEqual(ok, acquire(Fourth)),
    [ok = release(K) || K <- [First, Third, Fourth, <<"2001:db8:8::1">>]],
    ?assertEqual(0, connection_count(Bucket)),
    ?assertEqual(0, node_connection_count()).

ipv6_48_release_uses_the_acquired_bucket_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_ipv6_48_limit(1024, fun() ->
                H = start_connection_holder(<<"2001:db8:9:1::1">>),
                ?assertEqual(1, connection_count(<<"2001:db8:9::/48">>)),
                %% Turning the bucket off while the socket is open must still free what it took.
                with_ipv6_48_limit(0, fun() -> release_connection_holder(H) end),
                ?assertEqual(0, connection_count(<<"2001:db8:9::/48">>)),
                ?assertEqual(0, connection_count(<<"2001:db8:9:1::1">>)),
                ?assertEqual(0, node_connection_count())
            end)
        end)
    end).

ipv6_48_bucket_frees_killed_owner_test() ->
    with_rate_limits_enabled(fun() ->
        with_fast_owner_sweep(fun() ->
            with_heir_owner(fun() ->
                with_ipv6_48_limit(1024, fun() ->
                    H = start_connection_holder(<<"2001:db8:a:1::1">>),
                    kill_connection_holder(H),
                    ?assert(await_connection_count(<<"2001:db8:a::/48">>, 0, 300)),
                    ?assertEqual(0, connection_count(<<"2001:db8:a:1::1">>))
                end)
            end)
        end)
    end).

with_unidentified_budget(Budget, Fun) ->
    with_env_key(max_unidentified_connections, Budget, Fun).

unidentified_rows() ->
    case ets:whereis(gateway_unidentified_connections) of
        undefined -> 0;
        _ -> ets:info(gateway_unidentified_connections, size)
    end.

await_unidentified_rows(Expected, 0) ->
    unidentified_rows() =:= Expected;
await_unidentified_rows(Expected, Attempts) ->
    case unidentified_rows() =:= Expected of
        true ->
            true;
        false ->
            timer:sleep(10),
            await_unidentified_rows(Expected, Attempts - 1)
    end.

unidentified_budget_off_by_default_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_unidentified_budget(0, fun() ->
                Holders = [start_connection_holder(ip_n(N)) || N <- lists:seq(1, 20)],
                ?assertEqual(20, node_connection_count()),
                ?assertEqual(0, unidentified_rows()),
                lists:foreach(fun stop_connection_holder/1, Holders)
            end)
        end)
    end).

unidentified_budget_rejects_new_socket_when_full_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            with_unidentified_budget(2, fun assert_unidentified_budget_rejects_when_full/0)
        end)
    end).

assert_unidentified_budget_rejects_when_full() ->
    gateway_connection_metrics:reset_for_tests(),
    A = start_connection_holder(<<"198.51.100.130">>),
    B = start_connection_holder(<<"198.51.100.131">>),
    ?assertEqual({error, unidentified_at_capacity}, acquire(<<"198.51.100.132">>)),
    ?assertEqual(2, node_connection_count()),
    ?assertEqual(2, unidentified_rows()),
    ?assertEqual(0, connection_count(<<"198.51.100.132">>)),
    ?assertEqual(1, maps:get(unidentified_at_capacity, gateway_connection_metrics:snapshot())),
    %% A sends Identify: it leaves the budget and keeps its connection slot.
    identify_connection_holder(A),
    ?assertEqual(1, unidentified_rows()),
    ?assertEqual(2, node_connection_count()),
    ?assertEqual(ok, acquire(<<"198.51.100.132">>)),
    ok = release(<<"198.51.100.132">>),
    ?assertEqual(1, unidentified_rows()),
    release_connection_holder(B),
    ?assertEqual(0, unidentified_rows()),
    stop_connection_holder(A).

unidentified_budget_frees_killed_owner_test() ->
    with_rate_limits_enabled(fun() ->
        with_fast_owner_sweep(fun() ->
            with_heir_owner(fun() ->
                with_unidentified_budget(1, fun assert_killed_unidentified_owner_frees_budget/0)
            end)
        end)
    end).

assert_killed_unidentified_owner_frees_budget() ->
    H = start_connection_holder(<<"198.51.100.133">>),
    ?assertEqual({error, unidentified_at_capacity}, acquire(<<"198.51.100.134">>)),
    kill_connection_holder(H),
    ?assert(await_unidentified_rows(0, 300)),
    ?assertEqual(ok, acquire(<<"198.51.100.134">>)),
    ok = release(<<"198.51.100.134">>),
    ?assertEqual(0, unidentified_rows()).

admit_identify_counts_node_sessions_test() ->
    with_rate_limits_enabled(fun() ->
        with_heir_owner(fun() ->
            %% soft 2
            with_node_limit(2, fun() ->
                ok = gateway_connection_metrics:init_sessions(1),
                try
                    assert_admit_identify_counts_sessions()
                after
                    gateway_connection_metrics:reset_for_tests()
                end
            end)
        end)
    end).

assert_admit_identify_counts_sessions() ->
    A = start_connection_holder(<<"198.51.100.150">>),
    ok = gateway_connection_metrics:note_shard_sessions(0, 2),
    ?assertEqual(ok, admit_identify()),
    %% One socket, three sessions (two left behind for Resume): max(1, 3) > 2.
    ok = gateway_connection_metrics:note_shard_sessions(0, 3),
    ?assertEqual({error, identify_at_capacity}, admit_identify()),
    with_node_limit(0, fun() -> ?assertEqual(ok, admit_identify()) end),
    ok = gateway_connection_metrics:note_shard_sessions(0, 0),
    ?assertEqual(ok, admit_identify()),
    stop_connection_holder(A).

zero_count_row_is_kept_when_raised_again_test() ->
    with_heir_owner(fun() ->
        ensure_tables(),
        Key = <<"198.51.100.160">>,
        true = ets:insert(?CONNECTION_TABLE, {Key, 1}),
        ok = forget_if_zero(Key),
        ?assertEqual(1, connection_count(Key)),
        true = ets:insert(?CONNECTION_TABLE, {Key, 0}),
        ok = forget_if_zero(Key),
        ?assertEqual([], ets:lookup(?CONNECTION_TABLE, Key))
    end).

-endif.
