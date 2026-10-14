%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(gateway_rollout_config).
-typing([eqwalizer]).
-behaviour(gen_server).
-compile({no_auto_import, [get/0]}).

-export([
    start_link/0,
    get/0,
    session_rollout_percentage/0,
    session_rollout_mode/0,
    guild_rollout_percentage/0,
    voice_e2ee_scope/0,
    game_activity_allowed/0,
    game_activity_generation/0,
    gateway_dispatch_relay_shards/0,
    gateway_dispatch_relay_max_queue/0,
    rpc_request_timeout_ms/0,
    max_concurrent_session_starts/0,
    max_concurrent_guild_starts/0,
    max_connections/0,
    is_session_eligible/1,
    is_guild_eligible/1,
    subscribe_changes/1,
    unsubscribe_changes/1
]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(PERSISTENT_TERM_KEY, gateway_rollout_config).
-define(FETCH_DELAY_MS, 2000).
-define(NATS_SUBSCRIBE_RETRY_MS, 2000).
-define(NATS_SUBJECT, <<"config.gateway.rollout">>).
-define(GAME_GATE_KEY, {?MODULE, game_activity_gate}).
-define(FETCH_INTERVAL_MS, 25000).
-define(FETCH_TIMEOUT_MS, 4500).
-define(GAME_FRESHNESS_MS, 45000).

-type state() :: #{
    subscribers := [{pid(), reference()}],
    nats_subscription := term(),
    nats_monitor := reference() | undefined,
    fetch_worker => {pid(), reference(), reference(), reference()},
    fetch_periodic_timer => reference(),
    fetch_retry_timer => reference(),
    fetch_retry_attempt => non_neg_integer(),
    fetch_pending => boolean()
}.
-type store_result() :: updated | unchanged | rejected.
-spec start_link() -> gen_server:start_ret().
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec get() -> map().
get() ->
    try
        persistent_term:get(?PERSISTENT_TERM_KEY)
    catch
        error:badarg -> default_config()
    end.

-spec session_rollout_percentage() -> number().
session_rollout_percentage() ->
    maps:get(<<"session_rollout_percentage">>, get(), 100).

-spec session_rollout_mode() -> modulo | random.
session_rollout_mode() ->
    case maps:get(<<"session_rollout_mode">>, get(), <<"modulo">>) of
        <<"random">> -> random;
        _ -> modulo
    end.

-spec guild_rollout_percentage() -> number().
guild_rollout_percentage() ->
    maps:get(<<"guild_rollout_percentage">>, get(), 100).

-spec voice_e2ee_scope() -> guild_feature_only | platform_wide.
voice_e2ee_scope() ->
    case maps:get(<<"voice_e2ee_scope">>, get(), <<"guild_feature_only">>) of
        <<"platform_wide">> -> platform_wide;
        _ -> guild_feature_only
    end.

-spec game_activity_allowed() -> boolean().
game_activity_allowed() ->
    Config = get(),
    Gate = persistent_term:get(?GAME_GATE_KEY, #{}),
    case maps:get(validated_at, Gate, undefined) of
        Stamp when is_integer(Stamp) ->
            maps:get(<<"game_activity_enabled">>, Config, false) andalso
                maps:get(epoch, Gate, undefined) =:=
                    maps:get(<<"game_activity_epoch">>, Config, 0) andalso
                erlang:monotonic_time(millisecond) - Stamp < ?GAME_FRESHNESS_MS;
        _ ->
            false
    end.

-spec game_activity_generation() -> integer().
game_activity_generation() ->
    maps:get(generation, persistent_term:get(?GAME_GATE_KEY, #{}), 0).

-spec gateway_dispatch_relay_shards() -> pos_integer().
gateway_dispatch_relay_shards() ->
    max(1, maps:get(<<"gateway_dispatch_relay_shards">>, get(), 32)).

-spec gateway_dispatch_relay_max_queue() -> non_neg_integer().
gateway_dispatch_relay_max_queue() ->
    max(0, maps:get(<<"gateway_dispatch_relay_max_queue">>, get(), 50000)).

-spec rpc_request_timeout_ms() -> integer().
rpc_request_timeout_ms() ->
    maps:get(<<"rpc_request_timeout_ms">>, get(), 10000).

-spec max_concurrent_session_starts() -> integer().
max_concurrent_session_starts() ->
    maps:get(<<"max_concurrent_session_starts">>, get(), 512).

-spec max_concurrent_guild_starts() -> integer().
max_concurrent_guild_starts() ->
    maps:get(<<"max_concurrent_guild_starts">>, get(), 256).

-spec max_connections() -> non_neg_integer().
max_connections() ->
    maps:get(<<"max_connections">>, get(), 0).

-spec is_session_eligible(binary()) -> boolean().
is_session_eligible(UserId) ->
    check_eligibility(UserId, session_rollout_percentage(), session_rollout_mode()).

-spec is_guild_eligible(binary()) -> boolean().
is_guild_eligible(GuildId) ->
    check_eligibility(GuildId, guild_rollout_percentage(), modulo).

-spec subscribe_changes(pid()) -> ok.
subscribe_changes(Pid) ->
    gen_server:cast(?MODULE, {subscribe, Pid}).

-spec unsubscribe_changes(pid()) -> ok.
unsubscribe_changes(Pid) ->
    gen_server:cast(?MODULE, {unsubscribe, Pid}).

-spec init([]) -> {ok, state()}.
init([]) ->
    erlang:process_flag(fullsweep_after, 50),
    persistent_term:put(?PERSISTENT_TERM_KEY, initial_config()),
    invalidate_game_gate(),
    self() ! subscribe_nats,
    {ok, #{
        subscribers => [],
        nats_subscription => undefined,
        nats_monitor => undefined,
        fetch_periodic_timer => erlang:start_timer(
            ?FETCH_DELAY_MS, self(), fetch_periodic_config
        )
    }}.

-spec handle_call(term(), gen_server:from(), state()) -> {reply, term(), state()}.
handle_call(_Request, _From, State) ->
    {reply, ok, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast({subscribe, Pid}, #{subscribers := Subs} = State) when is_pid(Pid) ->
    case lists:keyfind(Pid, 1, Subs) of
        false ->
            MonRef = erlang:monitor(process, Pid),
            {noreply, State#{subscribers => [{Pid, MonRef} | Subs]}};
        _ ->
            {noreply, State}
    end;
handle_cast({unsubscribe, Pid}, #{subscribers := Subs} = State) when is_pid(Pid) ->
    case lists:keytake(Pid, 1, Subs) of
        {value, {Pid, MonRef}, Rest} ->
            erlang:demonitor(MonRef, [flush]),
            {noreply, State#{subscribers => Rest}};
        false ->
            {noreply, State}
    end;
handle_cast(_Msg, State) ->
    {noreply, State}.

-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info(subscribe_nats, State) ->
    {noreply, subscribe_to_nats(State)};
handle_info(fetch_initial_config, State) ->
    {noreply, start_config_fetch(ensure_periodic_fetch(State))};
handle_info(
    {timeout, Timer, fetch_periodic_config}, #{fetch_periodic_timer := Timer} = State
) ->
    {noreply,
        start_config_fetch(ensure_periodic_fetch(maps:remove(fetch_periodic_timer, State)))};
handle_info({nats_resubscribed, ?NATS_SUBJECT}, #{fetch_worker := _} = State) ->
    {noreply, State#{fetch_pending => true}};
handle_info({nats_resubscribed, ?NATS_SUBJECT}, State) ->
    {noreply, start_config_fetch(State)};
handle_info(
    {timeout, Timer, fetch_initial_config}, #{fetch_retry_timer := Timer} = State
) ->
    {noreply, start_config_fetch(State)};
handle_info(
    {rollout_fetch_result, Token, Result},
    #{fetch_worker := {_Pid, Monitor, Token, Timer}} = State
) ->
    _ = erlang:cancel_timer(Timer),
    erlang:demonitor(Monitor, [flush]),
    Applied =
        case maps:get(fetch_pending, State, false) of
            true -> unchanged;
            false -> apply_api_result(Result)
        end,
    {noreply, finish_config_fetch(Applied, maps:remove(fetch_worker, State))};
handle_info(
    {rollout_fetch_timeout, Token},
    #{fetch_worker := {Pid, Monitor, Token, Timer}} = State
) ->
    _ = erlang:cancel_timer(Timer),
    exit(Pid, kill),
    erlang:demonitor(Monitor, [flush]),
    logger:warning("Gateway rollout config authoritative fetch timed out"),
    {noreply, finish_config_fetch(rejected, maps:remove(fetch_worker, State))};
handle_info({game_activity_stale, Stamp}, State) ->
    case persistent_term:get(?GAME_GATE_KEY, #{}) of
        #{validated_at := Stamp} ->
            invalidate_game_gate(),
            notify_subscribers(State);
        _ ->
            ok
    end,
    {noreply, State};
handle_info({notify_rollout_subscribers, Subscribers}, State) ->
    notify_batch(Subscribers, 100),
    {noreply, State};
handle_info({nats_msg, ?NATS_SUBJECT, Payload, _ReplyTo}, State) when is_binary(Payload) ->
    Result = apply_nats_payload(Payload),
    maybe_notify_subscribers(Result, State),
    case Result =/= rejected andalso maps:is_key(fetch_worker, State) of
        true -> {noreply, State#{fetch_pending => true}};
        false -> {noreply, State}
    end;
handle_info({'DOWN', MonRef, process, _Pid, _Reason}, #{nats_monitor := MonRef} = State) ->
    erlang:send_after(?NATS_SUBSCRIBE_RETRY_MS, self(), subscribe_nats),
    self() ! reconcile_config,
    {noreply, State#{nats_subscription => undefined, nats_monitor => undefined}};
handle_info(reconcile_config, State) ->
    {noreply, start_config_fetch(State)};
handle_info(
    {'DOWN', Monitor, process, _Pid, Reason},
    #{fetch_worker := {_Worker, Monitor, _Token, Timer}} = State
) ->
    _ = erlang:cancel_timer(Timer),
    logger:warning("Gateway rollout config fetch worker exited", #{reason => Reason}),
    {noreply, finish_config_fetch(rejected, maps:remove(fetch_worker, State))};
handle_info({'DOWN', _MonRef, process, Pid, _Reason}, #{subscribers := Subs} = State) ->
    {noreply, State#{subscribers => lists:keydelete(Pid, 1, Subs)}};
handle_info(_Info, State) ->
    {noreply, State}.

-spec terminate(term(), state()) -> ok.
terminate(_Reason, State) ->
    cancel_fetch_retry(State),
    case maps:get(fetch_periodic_timer, State, undefined) of
        PeriodicTimer when is_reference(PeriodicTimer) ->
            _ = erlang:cancel_timer(PeriodicTimer),
            ok;
        _ ->
            ok
    end,
    case maps:get(fetch_worker, State, undefined) of
        {Pid, _Monitor, _Token, Timer} ->
            _ = erlang:cancel_timer(Timer),
            exit(Pid, kill);
        _ ->
            ok
    end,
    invalidate_game_gate(),
    ok.

-spec code_change(term(), state(), term()) -> {ok, state()}.
code_change(_OldVsn, State, _Extra) ->
    erlang:garbage_collect(),
    {ok, State}.

-spec check_eligibility(binary(), number(), modulo | random) -> boolean().
check_eligibility(_Id, Percentage, _Mode) when Percentage >= 100 ->
    true;
check_eligibility(_Id, Percentage, _Mode) when Percentage =< 0 ->
    false;
check_eligibility(Id, Percentage, modulo) ->
    erlang:phash2(Id, 100) < Percentage;
check_eligibility(_Id, Percentage, random) ->
    rand:uniform(100) =< Percentage.

-spec default_config() -> map().
default_config() ->
    #{
        <<"session_rollout_percentage">> => 100,
        <<"session_rollout_mode">> => <<"modulo">>,
        <<"guild_rollout_percentage">> => 100,
        <<"rpc_request_timeout_ms">> => 10000,
        <<"max_concurrent_session_starts">> => 512,
        <<"max_concurrent_guild_starts">> => 256,
        <<"gateway_dispatch_relay_shards">> => 32,
        <<"gateway_dispatch_relay_max_queue">> => 50000,
        <<"voice_e2ee_scope">> => <<"guild_feature_only">>,
        <<"max_connections">> => 0,
        <<"game_activity_enabled">> => false,
        <<"game_activity_epoch">> => 0
    }.

-spec initial_config() -> map().
initial_config() ->
    Existing = persistent_term:get(?PERSISTENT_TERM_KEY, undefined),
    validated_or_default(Existing).

-spec validated_or_default(term()) -> map().
validated_or_default(Config) ->
    case validate_config(Config) of
        {ok, Validated} -> Validated;
        {error, _Reason} -> default_config()
    end.

-spec validate_config(term()) -> {ok, map()} | {error, term()}.
validate_config(Config) ->
    gateway_rollout_config_validate:validate(Config, default_config()).

-spec start_config_fetch(state()) -> state().
start_config_fetch(#{fetch_worker := _} = State) ->
    State;
start_config_fetch(State) ->
    cancel_fetch_retry(State),
    Parent = self(),
    Token = make_ref(),
    {Pid, Monitor} = spawn_monitor(fun() ->
        Result = rpc_client:call(#{<<"type">> => <<"get_gateway_rollout_config">>}),
        Parent ! {rollout_fetch_result, Token, Result}
    end),
    Timer = erlang:send_after(?FETCH_TIMEOUT_MS, self(), {rollout_fetch_timeout, Token}),
    (maps:remove(fetch_retry_timer, State))#{fetch_worker => {Pid, Monitor, Token, Timer}}.

-spec ensure_periodic_fetch(state()) -> state().
ensure_periodic_fetch(#{fetch_periodic_timer := _} = State) ->
    State;
ensure_periodic_fetch(State) ->
    State#{
        fetch_periodic_timer => erlang:start_timer(
            ?FETCH_INTERVAL_MS, self(), fetch_periodic_config
        )
    }.

-spec finish_config_fetch(store_result(), state()) -> state().
finish_config_fetch(Result, State) ->
    maybe_notify_subscribers(Result, State),
    Next =
        case Result of
            rejected ->
                Attempt = maps:get(fetch_retry_attempt, State, 0),
                Delay = backoff_utils:calculate_with_jitter(Attempt),
                State#{
                    fetch_retry_timer => erlang:start_timer(
                        Delay, self(), fetch_initial_config
                    ),
                    fetch_retry_attempt => min(Attempt + 1, 32)
                };
            _ ->
                maps:without([fetch_retry_timer, fetch_retry_attempt], State)
        end,
    case maps:get(fetch_pending, Next, false) of
        true -> start_config_fetch(maps:remove(fetch_pending, Next));
        false -> Next
    end.

-spec cancel_fetch_retry(state()) -> ok.
cancel_fetch_retry(State) ->
    case maps:get(fetch_retry_timer, State, undefined) of
        undefined ->
            ok;
        Timer ->
            _ = erlang:cancel_timer(Timer),
            ok
    end.

-spec apply_api_result(term()) -> store_result().
apply_api_result(Result) ->
    case Result of
        {ok, #{<<"config">> := Config}} when is_map(Config) ->
            store_valid_config(Config, api);
        {ok, _Other} ->
            logger:warning("Gateway rollout config: unexpected API response format"),
            rejected;
        {error, Reason} ->
            logger:warning("Gateway rollout config failed to fetch from API", #{
                reason => Reason
            }),
            rejected
    end.

-spec apply_nats_payload(binary()) -> store_result().
apply_nats_payload(Payload) ->
    try json:decode(Payload) of
        #{<<"type">> := <<"gateway_rollout_config">>, <<"config">> := Config} when
            is_map(Config)
        ->
            store_valid_config(Config, nats);
        #{<<"config">> := Config} when is_map(Config) ->
            store_valid_config(Config, nats);
        Config when is_map(Config) ->
            store_valid_config(Config, nats);
        _Other ->
            logger:warning("Gateway rollout config: unexpected NATS payload format"),
            rejected
    catch
        Class:Reason ->
            logger:warning("Gateway rollout config failed to decode NATS payload", #{
                class => Class, reason => Reason
            }),
            rejected
    end.

-spec store_valid_config(map(), api | nats) -> store_result().
store_valid_config(Config, Source) ->
    case validate_config(Config) of
        {ok, Validated} ->
            OldConfig = get(),
            store_validated_config(OldConfig, Validated, Source);
        {error, Reason} ->
            logger:warning(
                "Gateway rollout config rejected invalid config: ~p",
                [Reason]
            ),
            rejected
    end.

-spec store_validated_config(map(), map(), api | nats) -> store_result().
store_validated_config(OldConfig, NewConfig, Source) ->
    OldEpoch = maps:get(<<"game_activity_epoch">>, OldConfig, 0),
    NewEpoch = maps:get(<<"game_activity_epoch">>, NewConfig, 0),
    OldEnabled = maps:get(<<"game_activity_enabled">>, OldConfig, false),
    NewEnabled = maps:get(<<"game_activity_enabled">>, NewConfig, false),
    AcceptGame =
        NewEpoch > OldEpoch orelse
            (NewEpoch =:= OldEpoch andalso NewEnabled =:= OldEnabled),
    Accepted =
        case AcceptGame of
            true ->
                NewConfig;
            false ->
                NewConfig#{
                    <<"game_activity_epoch">> => OldEpoch,
                    <<"game_activity_enabled">> => OldEnabled
                }
        end,
    case AcceptGame andalso NewEpoch =/= OldEpoch of
        true -> invalidate_game_gate();
        false -> ok
    end,
    Changed = Accepted =/= OldConfig,
    case Changed of
        true ->
            log_config_transitions(OldConfig, Accepted),
            persistent_term:put(?PERSISTENT_TERM_KEY, Accepted),
            logger:info("Gateway rollout config updated", #{source => Source});
        false ->
            ok
    end,
    GateChanged =
        case Source =:= api andalso AcceptGame of
            true -> refresh_game_gate(NewEpoch);
            false -> false
        end,
    case Changed orelse GateChanged of
        true -> updated;
        false -> unchanged
    end.

-spec invalidate_game_gate() -> ok.
invalidate_game_gate() ->
    persistent_term:put(
        ?GAME_GATE_KEY,
        #{generation => erlang:unique_integer([monotonic, positive])}
    ),
    ok.

-spec refresh_game_gate(non_neg_integer()) -> boolean().
refresh_game_gate(Epoch) ->
    WasAllowed = game_activity_allowed(),
    Gate = persistent_term:get(?GAME_GATE_KEY, #{}),
    Stamp = erlang:monotonic_time(millisecond),
    %% A delayed freshness timer must not let old grants survive a stale interval.
    Generation =
        case WasAllowed of
            true -> maps:get(generation, Gate, 0);
            false -> erlang:unique_integer([monotonic, positive])
        end,
    persistent_term:put(
        ?GAME_GATE_KEY,
        #{epoch => Epoch, validated_at => Stamp, generation => Generation}
    ),
    erlang:send_after(?GAME_FRESHNESS_MS, self(), {game_activity_stale, Stamp}),
    not WasAllowed andalso game_activity_allowed().

-spec subscribe_to_nats(state()) -> state().
subscribe_to_nats(#{nats_subscription := Sid} = State) when Sid =/= undefined ->
    State;
subscribe_to_nats(State) ->
    case subscribe_to_rollout_subject() of
        {ok, Sid} ->
            MonRef = monitor_nats_rpc(),
            logger:info("Gateway rollout config subscribed to NATS", #{subject => ?NATS_SUBJECT}),
            State#{nats_subscription => Sid, nats_monitor => MonRef};
        {error, Reason} ->
            logger:debug("Gateway rollout config waiting for NATS subscription", #{
                subject => ?NATS_SUBJECT, reason => Reason
            }),
            erlang:send_after(?NATS_SUBSCRIBE_RETRY_MS, self(), subscribe_nats),
            State
    end.

-spec subscribe_to_rollout_subject() -> {ok, term()} | {error, term()}.
subscribe_to_rollout_subject() ->
    try gateway_nats_rpc:subscribe(?NATS_SUBJECT, <<>>) of
        {ok, Sid} -> {ok, Sid};
        {error, Reason} -> {error, Reason}
    catch
        Class:Reason -> {error, {Class, Reason}}
    end.

-spec monitor_nats_rpc() -> reference() | undefined.
monitor_nats_rpc() ->
    case whereis(gateway_nats_rpc) of
        Pid when is_pid(Pid) -> erlang:monitor(process, Pid);
        _ -> undefined
    end.

-spec log_config_transitions(map(), map()) -> ok.
log_config_transitions(OldConfig, NewConfig) ->
    WatchKeys = [
        <<"session_rollout_percentage">>,
        <<"guild_rollout_percentage">>,
        <<"rpc_request_timeout_ms">>
    ],
    lists:foreach(
        fun(Key) -> log_key_transition(Key, OldConfig, NewConfig) end,
        WatchKeys
    ),
    ok.

-spec log_key_transition(binary(), map(), map()) -> ok.
log_key_transition(Key, OldConfig, NewConfig) ->
    OldVal = maps:get(Key, OldConfig, undefined),
    NewVal = maps:get(Key, NewConfig, undefined),
    case OldVal =:= NewVal of
        true ->
            ok;
        false ->
            logger:notice(
                "Gateway rollout config transition:"
                " key=~s old=~p new=~p",
                [Key, OldVal, NewVal]
            )
    end.

-spec maybe_notify_subscribers(store_result(), state()) -> ok.
maybe_notify_subscribers(updated, State) ->
    notify_subscribers(State);
maybe_notify_subscribers(_Result, _State) ->
    ok.

-spec notify_subscribers(state()) -> ok.
notify_subscribers(#{subscribers := Subs}) ->
    notify_batch(Subs, 100).

-spec notify_batch([{pid(), reference()}], non_neg_integer()) -> ok.
notify_batch([], _) ->
    ok;
notify_batch(Rest, 0) ->
    self() ! {notify_rollout_subscribers, Rest},
    ok;
notify_batch([{Pid, _Monitor} | Rest], Remaining) ->
    Pid ! rollout_config_changed,
    notify_batch(Rest, Remaining - 1).
