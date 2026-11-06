%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(push).
-typing([eqwalizer]).
-behaviour(gen_server).

-export([start_link/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).
-export([
    handle_message_create/1,
    handle_buffered_message_creates/1,
    handle_unread_grace_message_creates/1,
    publish_still_unread/1,
    unread_grace_ms/0,
    sync_user_guild_settings_local/3,
    clear_channel_notifications/3,
    clear_notifications_enabled/0
]).
-export([get_cache_stats/0]).

-define(EVICT_INTERVAL_MS, 60000).
-define(DEFAULT_MAX_ENTRIES, 500000).

-define(CNT_WORKER_POOL, push_loss_worker_pool).
%% sanalyer: how long a push waits behind an active desktop before it is sent
%% anyway if still unread. Shared by the DM (presence) and guild hold paths;
%% 0 turns the unread grace off and restores the old hold-until-AFK behaviour.
-define(UNREAD_GRACE_KEY, push_unread_grace_ms).
-define(DEFAULT_UNREAD_GRACE_MS, 120000).
%% The unread-grace read-state check reuses push_read_state's counter table and
%% in-flight slot so the suppressed/skipped metrics stay in one place.
-define(CNT_READ_STATE_SUPPRESSED, push_read_state_suppressed).
-define(CNT_READ_STATE_FAILURES, push_read_state_fetch_failures).
-define(CNT_READ_STATE_SKIPPED, push_read_state_fetch_skipped).
-define(READ_STATE_FETCH_TIMEOUT_MS, 2000).
-define(READ_STATE_TABLE, push_read_state_counters).
-define(READ_STATE_FETCH_SLOTS, read_state_fetches_in_flight).
-define(MAX_READ_STATE_FETCHES, 64).

-type read_marks() :: #{{integer(), integer()} => non_neg_integer()}.

-type state() :: #{
    max_entries := non_neg_integer()
}.

-spec start_link() -> {ok, pid()} | {error, term()} | ignore.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec init([]) -> {ok, state()}.
init([]) ->
    erlang:process_flag(fullsweep_after, 10),
    push_ets_cache:init(),
    init_worker_counter(),
    maybe_schedule_eviction(env_boolean(push_enabled)),
    {ok, #{max_entries => ?DEFAULT_MAX_ENTRIES}}.

-spec maybe_schedule_eviction(boolean()) -> ok.
maybe_schedule_eviction(true) ->
    _ = schedule_eviction(),
    ok;
maybe_schedule_eviction(false) ->
    ok.

-spec handle_call(term(), gen_server:from(), state()) -> {reply, term(), state()}.
handle_call(get_cache_stats, _From, State) ->
    {reply, {ok, cache_stats_with_counters()}, State};
handle_call(_Request, _From, State) ->
    {reply, ok, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast({handle_message_create, Params}, State) when is_map(Params) ->
    handle_message_create_cast(Params, State);
handle_cast({clear_channel_notifications, UserId, ChannelId, MessageId}, State) when
    is_integer(UserId), is_integer(ChannelId), is_integer(MessageId)
->
    handle_clear_channel_notifications(UserId, ChannelId, MessageId, State);
handle_cast(_Msg, State) ->
    {noreply, State}.

-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info(evict_caches, State) ->
    MaxEntries = maps:get(max_entries, State),
    push_ets_cache:evict_tables(#{
        user_guild_settings => MaxEntries,
        blocked_ids => MaxEntries
    }),
    schedule_eviction(),
    {noreply, State};
handle_info(_Info, State) ->
    {noreply, State}.

-spec terminate(term(), state()) -> ok.
terminate(_Reason, _State) ->
    ok.

-spec code_change(term(), state(), term()) -> {ok, state()}.
code_change(_OldVsn, State, _Extra) ->
    erlang:garbage_collect(),
    {ok, State}.

-spec handle_message_create(map()) -> ok.
handle_message_create(Params) ->
    case is_push_active() of
        true -> cast_to_push_owner(push_owner_key(Params), {handle_message_create, Params});
        false -> ok
    end.

-spec handle_buffered_message_creates([map()]) -> ok.
handle_buffered_message_creates(ParamsList) ->
    case is_push_active() of
        true ->
            {Stale, Fresh} = push_read_state:split_stale_buffered(ParamsList),
            lists:foreach(fun handle_message_create/1, Fresh),
            push_read_state:check_stale(Stale);
        false ->
            ok
    end.

-spec sync_user_guild_settings_local(integer(), integer(), map()) -> ok.
sync_user_guild_settings_local(UserId, GuildId, Settings) ->
    local_cache_mutation(fun() ->
        push_ets_cache:put_user_guild_settings(UserId, GuildId, Settings)
    end).

-spec is_push_active() -> boolean().
is_push_active() ->
    not is_push_noop() andalso env_boolean(push_enabled).

-spec is_push_noop() -> boolean().
is_push_noop() ->
    persistent_term:get(push_noop, false).

-spec clear_channel_notifications(integer(), integer(), integer()) -> ok.
clear_channel_notifications(UserId, ChannelId, MessageId) ->
    case is_push_active() of
        true ->
            ok = push_outbox:truncate_read(UserId, ChannelId, MessageId),
            cast_clear_if_enabled(
                clear_notifications_enabled(), UserId, ChannelId, MessageId
            );
        false ->
            ok
    end.

-spec cast_clear_if_enabled(boolean(), integer(), integer(), integer()) -> ok.
cast_clear_if_enabled(true, UserId, ChannelId, MessageId) ->
    cast_to_push_owner(UserId, {clear_channel_notifications, UserId, ChannelId, MessageId});
cast_clear_if_enabled(false, _UserId, _ChannelId, _MessageId) ->
    ok.

-spec clear_notifications_enabled() -> boolean().
clear_notifications_enabled() ->
    case persistent_term:get(push_enrolled_clear_notifications_enabled, undefined) of
        OperatorChoice when is_boolean(OperatorChoice) -> OperatorChoice;
        _ -> env_boolean(push_enrolled_clear_notifications_enabled, true)
    end.

-spec get_cache_stats() -> {ok, map()}.
get_cache_stats() ->
    gen_server:call(?MODULE, get_cache_stats, 5000).

-spec push_owner_key(map()) -> term().
push_owner_key(Params) ->
    push_message_params:owner_key(Params).

-spec cast_to_push_owner(term(), term()) -> ok.
cast_to_push_owner(Key, Msg) ->
    case resolve_push_owner(Key) of
        {ok, TargetNode} ->
            Target = push_target(TargetNode),
            safe_cast(Target, Msg);
        unavailable ->
            ok
    end.

-spec safe_cast(gen_server:server_ref(), term()) -> ok.
safe_cast(Target, Msg) ->
    try gen_server:cast(Target, Msg) of
        _ -> ok
    catch
        throw:_Reason -> ok;
        error:_Reason -> ok;
        exit:_Reason -> ok
    end.

-spec push_target(node()) -> atom() | {atom(), node()}.
push_target(TargetNode) ->
    case TargetNode =:= node() of
        true -> ?MODULE;
        false -> {?MODULE, TargetNode}
    end.

-spec resolve_push_owner(term()) -> {ok, node()} | unavailable.
resolve_push_owner(undefined) ->
    {ok, node()};
resolve_push_owner(Key) ->
    try gateway_node_router:owner_node_result(Key, push) of
        {ok, OwnerNode} when is_atom(OwnerNode) -> {ok, OwnerNode};
        {error, _Reason} -> unavailable
    catch
        throw:_Reason -> unavailable;
        error:_Reason -> unavailable;
        exit:_Reason -> unavailable
    end.

-spec do_handle_message_create(map()) -> ok.
do_handle_message_create(Params) ->
    case push_message_params:context(Params) of
        {ok, Context} ->
            do_handle_message_create_context(Context);
        {error, Reason} ->
            logger:debug("Push: skipping malformed message create", #{reason => Reason}),
            ok
    end.

-spec unread_grace_ms() -> non_neg_integer().
unread_grace_ms() ->
    case application:get_env(fluxer_gateway, ?UNREAD_GRACE_KEY, undefined) of
        Value when is_integer(Value), Value >= 0 -> Value;
        _ -> ?DEFAULT_UNREAD_GRACE_MS
    end.

%% sanalyer: pushes held behind an active desktop for the unread grace window
%% go out only if the recipient still has not read the message. The read state
%% is fetched once per {user, channel} under an in-flight slot limit that shares
%% push_read_state's ETS counters; when no slot is free or the fetch fails the push is sent,
%% because a missed notification is the failure this hold exists to avoid.
-spec handle_unread_grace_message_creates([map()]) -> ok.
handle_unread_grace_message_creates([]) ->
    ok;
handle_unread_grace_message_creates(ParamsList) ->
    case is_push_active() of
        true ->
            _ = spawn(fun() -> publish_still_unread(ParamsList) end),
            ok;
        false ->
            ok
    end.

-spec publish_still_unread([map()]) -> ok.
publish_still_unread(ParamsList) ->
    case is_push_active() of
        true -> publish_still_unread_entries(unread_grace_entries(ParamsList));
        false -> ok
    end.

-spec unread_grace_entries([map()]) -> [{integer(), integer(), [integer()], map()}].
unread_grace_entries(ParamsList) ->
    lists:filtermap(fun unread_grace_entry/1, ParamsList).

-spec unread_grace_entry(map()) -> {true, {integer(), integer(), [integer()], map()}} | false.
unread_grace_entry(Params) ->
    case push_message_params:context(maps:remove(buffered_at, Params)) of
        {ok, #{user_ids := [_ | _] = UserIds, channel_id := ChannelId, message_id := MessageId}} ->
            {true, {ChannelId, MessageId, UserIds, maps:remove(buffered_at, Params)}};
        _ ->
            false
    end.

-spec publish_still_unread_entries([{integer(), integer(), [integer()], map()}]) -> ok.
publish_still_unread_entries([]) ->
    ok;
publish_still_unread_entries(Entries) ->
    Channels = lists:usort([
        {UserId, ChannelId}
     || {ChannelId, _MessageId, UserIds, _Params} <- Entries, UserId <- UserIds
    ]),
    ReadMarks = unread_grace_read_marks(Channels),
    lists:foreach(fun(Entry) -> publish_unread_users(ReadMarks, Entry) end, Entries).

-spec unread_grace_read_marks([{integer(), integer()}]) -> read_marks().
unread_grace_read_marks(Channels) ->
    case read_state_fetch_allowed(length(Channels)) of
        true ->
            try
                fetch_each_read_mark(Channels, #{})
            catch
                _:_ -> #{}
            after
                release_read_state_fetch_slot()
            end;
        false ->
            #{}
    end.

-spec publish_unread_users(read_marks(), {integer(), integer(), [integer()], map()}) -> ok.
publish_unread_users(ReadMarks, {ChannelId, MessageId, UserIds, Params}) ->
    Unread = [
        UserId
     || UserId <- UserIds, MessageId > maps:get({UserId, ChannelId}, ReadMarks, 0)
    ],
    case length(UserIds) - length(Unread) of
        0 -> ok;
        Read -> bump_read_state_counter(?CNT_READ_STATE_SUPPRESSED, Read)
    end,
    case Unread of
        [] -> ok;
        _ -> handle_message_create(Params#{user_ids => Unread})
    end.

-spec read_state_fetch_allowed(non_neg_integer()) -> boolean().
read_state_fetch_allowed(Fetches) ->
    case acquire_read_state_fetch_slot() of
        true ->
            true;
        false ->
            bump_read_state_counter(?CNT_READ_STATE_SKIPPED, Fetches),
            false
    end.

-spec acquire_read_state_fetch_slot() -> boolean().
acquire_read_state_fetch_slot() ->
    ok = ensure_read_state_table(),
    try
        ets:update_counter(
            ?READ_STATE_TABLE, ?READ_STATE_FETCH_SLOTS, {2, 1}, {?READ_STATE_FETCH_SLOTS, 0}
        )
    of
        InFlight when InFlight > ?MAX_READ_STATE_FETCHES ->
            release_read_state_fetch_slot(),
            false;
        _InFlight ->
            true
    catch
        error:badarg -> false
    end.

-spec release_read_state_fetch_slot() -> ok.
release_read_state_fetch_slot() ->
    try ets:update_counter(?READ_STATE_TABLE, ?READ_STATE_FETCH_SLOTS, {2, -1, 0, 0}) of
        _InFlight -> ok
    catch
        error:badarg -> ok
    end.

-spec bump_read_state_counter(atom(), non_neg_integer()) -> ok.
bump_read_state_counter(Key, Increment) ->
    ok = ensure_read_state_table(),
    try ets:update_counter(?READ_STATE_TABLE, Key, {2, Increment}, {Key, 0}) of
        _Value -> ok
    catch
        error:badarg -> ok
    end.

-spec ensure_read_state_table() -> ok.
ensure_read_state_table() ->
    case ets:whereis(?READ_STATE_TABLE) of
        undefined ->
            guild_ets_utils:ensure_table(?READ_STATE_TABLE, [
                named_table, public, set, {write_concurrency, true}
            ]);
        _Table ->
            ok
    end.

-spec fetch_each_read_mark([{integer(), integer()}], read_marks()) -> read_marks().
fetch_each_read_mark([], ReadMarks) ->
    ReadMarks;
fetch_each_read_mark([{UserId, ChannelId} = Key | Rest], ReadMarks) ->
    case fetch_read_message_id(UserId, ChannelId) of
        {ok, ReadMessageId} ->
            fetch_each_read_mark(Rest, ReadMarks#{Key => ReadMessageId});
        error ->
            bump_read_state_counter(?CNT_READ_STATE_SKIPPED, length(Rest)),
            ReadMarks
    end.

-spec fetch_read_message_id(integer(), integer()) -> {ok, non_neg_integer()} | error.
fetch_read_message_id(UserId, ChannelId) ->
    Request = #{
        <<"type">> => <<"get_read_state">>,
        <<"user_id">> => integer_to_binary(UserId),
        <<"channel_id">> => integer_to_binary(ChannelId)
    },
    case read_state_call(Request) of
        {ok, #{<<"last_message_id">> := LastMessageId}} ->
            {ok, read_message_id(snowflake_id:parse_maybe(LastMessageId))};
        {ok, _Data} ->
            {ok, 0};
        {error, Reason} ->
            bump_read_state_counter(?CNT_READ_STATE_FAILURES, 1),
            logger:debug("Push: read state fetch failed", #{
                reason => Reason, user_id => UserId, channel_id => ChannelId
            }),
            error
    end.

-spec read_state_call(map()) -> {ok, term()} | {error, term()}.
read_state_call(Request) ->
    try
        rpc_client:call(Request, ?READ_STATE_FETCH_TIMEOUT_MS)
    catch
        Class:Reason -> {error, {Class, Reason}}
    end.

-spec read_message_id(integer() | undefined) -> non_neg_integer().
read_message_id(MessageId) when is_integer(MessageId), MessageId > 0 -> MessageId;
read_message_id(_MessageId) -> 0.
-spec do_handle_message_create_context(push_message_params:context()) -> ok.
do_handle_message_create_context(Context) ->
    #{
        message_data := MessageData,
        user_ids := UserIds,
        guild_id := GuildId,
        author_id := AuthorId,
        user_roles := UserRolesMap,
        connected_users := ConnectedUsers,
        channel_id := ChannelId,
        message_id := MessageId,
        guild_default_notifications := GuildDefaultNotifications,
        guild_name := GuildName,
        channel_name := ChannelName,
        markdown_context := MarkdownContext
    } = Context,
    logger:debug("Push: evaluating eligibility", #{
        message_id => MessageId,
        channel_id => ChannelId,
        guild_id => GuildId,
        author_id => AuthorId,
        candidate_count => length(UserIds)
    }),
    EligibleUsers = push_recipients:filter_eligible(
        UserIds,
        AuthorId,
        GuildId,
        ChannelId,
        MessageData,
        GuildDefaultNotifications,
        UserRolesMap,
        ConnectedUsers,
        maps:get(large_guild_metadata, Context, undefined)
    ),
    logger:debug("Push: eligibility result", #{
        message_id => MessageId,
        channel_id => ChannelId,
        eligible_count => length(EligibleUsers)
    }),
    publish_eligible_users(
        EligibleUsers,
        push_eligibility_checks:strip_thread_eligibility(MessageData),
        MarkdownContext,
        GuildId,
        ChannelId,
        MessageId,
        GuildName,
        ChannelName
    ).

-spec publish_eligible_users(
    [integer()],
    map(),
    map(),
    integer(),
    integer(),
    integer(),
    binary() | undefined,
    binary() | undefined
) -> ok.
publish_eligible_users(
    [],
    _MessageData,
    _MarkdownContext,
    _GuildId,
    _ChannelId,
    _MessageId,
    _GuildName,
    _ChannelName
) ->
    ok;
publish_eligible_users(
    EligibleUsers,
    MessageData,
    MarkdownContext,
    GuildId,
    ChannelId,
    MessageId,
    GuildName,
    ChannelName
) ->
    _ = push_job_publisher:publish_message(
        EligibleUsers,
        MessageData,
        MarkdownContext,
        GuildId,
        ChannelId,
        MessageId,
        GuildName,
        ChannelName
    ),
    ok.

-spec handle_message_create_cast(map(), state()) -> {noreply, state()}.
handle_message_create_cast(Params, State) ->
    SpawnResult = maybe_spawn_push_worker(fun() -> do_handle_message_create(Params) end),
    log_message_worker_drop(SpawnResult, Params),
    {noreply, State}.

-spec handle_clear_channel_notifications(integer(), integer(), integer(), state()) ->
    {noreply, state()}.
handle_clear_channel_notifications(UserId, ChannelId, MessageId, State) ->
    _ = push_job_publisher:publish_clear(UserId, ChannelId, MessageId),
    {noreply, State}.

-spec log_message_worker_drop(ok | dropped, map()) -> ok.
log_message_worker_drop(ok, _Params) ->
    ok;
log_message_worker_drop(dropped, Params) ->
    push_worker_pool:bump_counter(?CNT_WORKER_POOL, 1),
    MessageData = maps:get(message_data, Params, #{}),
    log_worker_pool_drop(
        loss_logging_enabled(),
        maps:get(<<"id">>, MessageData, undefined),
        maps:get(<<"channel_id">>, MessageData, undefined)
    ).

-spec log_worker_pool_drop(boolean(), term(), term()) -> ok.
log_worker_pool_drop(true, MessageId, ChannelId) ->
    logger:error("Push: worker pool saturated, dropping message create", #{
        message_id => MessageId, channel_id => ChannelId
    });
log_worker_pool_drop(false, MessageId, ChannelId) ->
    logger:debug("Push: worker pool saturated, dropping message create", #{
        message_id => MessageId, channel_id => ChannelId
    }).

-spec cache_stats_with_counters() -> map().
cache_stats_with_counters() ->
    Base = maps:merge(push_ets_cache:cache_stats(), push_recipients:counters()),
    maps:merge(Base, push_loss_counters()).

-spec push_loss_counters() -> map().
push_loss_counters() ->
    maps:merge(
        #{
            counters => push_worker_pool:counter_table_status(),
            worker_pool_dropped => push_worker_pool:read_counter(?CNT_WORKER_POOL)
        },
        push_read_state:counters()
    ).

-spec loss_logging_enabled() -> boolean().
loss_logging_enabled() ->
    type_conv:is_true(application:get_env(fluxer_gateway, push_loss_logging, false)).

-spec local_cache_mutation(fun(() -> ok)) -> ok.
local_cache_mutation(Fun) ->
    case whereis(?MODULE) of
        undefined ->
            ok;
        _Pid ->
            safe_local_cache_mutation(Fun)
    end.

-spec safe_local_cache_mutation(fun(() -> ok)) -> ok.
safe_local_cache_mutation(Fun) ->
    try Fun() of
        ok -> ok
    catch
        error:badarg -> ok
    end.

-spec init_worker_counter() -> ok.
init_worker_counter() ->
    push_worker_pool:init_counter().

-spec maybe_spawn_push_worker(fun(() -> term())) -> ok | dropped.
maybe_spawn_push_worker(Fun) ->
    push_worker_pool:maybe_spawn(Fun).

-spec schedule_eviction() -> reference().
schedule_eviction() ->
    erlang:send_after(?EVICT_INTERVAL_MS, self(), evict_caches).

-spec env_boolean(atom()) -> boolean().
env_boolean(Key) ->
    case fluxer_gateway_env:get(Key) of
        true -> true;
        _ -> false
    end.

-spec env_boolean(atom(), boolean()) -> boolean().
env_boolean(Key, Default) ->
    case fluxer_gateway_env:get(Key) of
        Value when is_boolean(Value) -> Value;
        _ -> Default
    end.
