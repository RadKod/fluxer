%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(presence_game_activity).
-typing([eqwalizer]).
-export([
    init/1,
    update/2,
    clear/2,
    expire/4,
    disconnect/2,
    control/3,
    context/2,
    subscribe/5,
    bootstrap/3,
    rollout/1,
    rollout_changed/1,
    deliver/2,
    transition/5,
    selected/2,
    allowed/1,
    pending/1,
    delivery_batch/3,
    barrier/4,
    receiver_down/2,
    guilds/1,
    blocked/2,
    join_guild/2,
    leave_guild/2,
    guild_resolved/3,
    guild_down/2,
    guild_retry/2,
    start_barrier/4,
    guild_response/2,
    forget_barrier/2
]).

-define(LEASE_MS, 120000).
-define(GUILD_ACK_MS, 2000).
-define(GUILD_RETRY_MS, 1000).
-define(GUILD_RETRY_MAX_MS, 30000).

-spec init(map()) -> map().
init(State) ->
    Game = (presence_game_activity_policy:new())#{
        rollout_epoch => maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0),
        rollout_generation => gateway_rollout_config:game_activity_generation()
    },
    State#{game_activity_state => Game}.

-spec game(map()) -> map().
game(#{game_activity_state := Game}) -> Game;
game(_) -> presence_game_activity_policy:new().
-spec store_game(map(), map()) -> map().
store_game(Game, State) -> State#{game_activity_state => Game}.

-spec allowed(map()) -> boolean().
allowed(State) ->
    Game = game(State),
    presence_game_activity_policy:permitted(Game) andalso
        gateway_rollout_config:game_activity_allowed() andalso
        maps:get(rollout_epoch, Game, -1) =:=
            maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0) andalso
        maps:get(rollout_generation, Game, -1) =:=
            gateway_rollout_config:game_activity_generation() andalso
        not maps:get(is_bot, State, false) andalso
        lists:member(presence_status:get_current_status(maps:get(sessions, State, #{})), [
            online, idle, dnd
        ]).

-spec update(map(), map()) -> map().
update(Request, State) ->
    Input = maps:get(game_activity, Request, maps:get(<<"game_activity">>, Request, absent)),
    case has_activity_state(game(State)) andalso not allowed(State) of
        true -> rollout(State);
        false -> guilds(update_input(Input, maps:get(session_id, Request), State))
    end.

-spec has_activity_state(map()) -> boolean().
has_activity_state(Game) ->
    map_size(maps:get(candidates, Game, #{})) > 0 orelse
        map_size(maps:get(grants, Game, #{})) > 0 orelse
        maps:get(pending, Game, undefined) =/= undefined.

-spec update_input(term(), binary(), map()) -> map().
update_input(absent, _SessionId, State) ->
    case maps:get(candidates, game(State), #{}) =/= #{} andalso not allowed(State) of
        true -> rollout(State);
        false -> State
    end;
update_input(null, SessionId, State) ->
    clear(SessionId, State);
update_input(Activity, SessionId, State) when is_map(Activity) ->
    case maps:is_key(SessionId, maps:get(sessions, State, #{})) andalso allowed(State) of
        true ->
            Old = game(State),
            {New, Changed} = transition(
                SessionId,
                Activity,
                erlang:monotonic_time(millisecond),
                erlang:system_time(millisecond),
                Old
            ),
            Refreshed = refresh_after_new_activity(Changed, New, State),
            Timed = schedule_pending(schedule_candidate(SessionId, Old, Refreshed)),
            maybe_deliver(Changed, store_game(Timed, State));
        false ->
            State
    end;
update_input(_, _SessionId, State) ->
    State.

-spec refresh_after_new_activity(boolean(), map(), map()) -> map().
refresh_after_new_activity(true, #{refresh_on_activity := true} = Game, State) ->
    refresh_interested(all, Game, maps:get(user_id, State)),
    maps:remove(refresh_on_activity, Game);
refresh_after_new_activity(_, Game, _State) ->
    Game.

-spec transition(binary(), map(), integer(), integer(), map()) -> {map(), boolean()}.
transition(SessionId, Activity, Now, Wall, Game) ->
    Candidates = maps:get(candidates, Game, #{}),
    case maps:get(SessionId, Candidates, undefined) of
        #{raw := Activity, expires := ExistingExpiry} = Candidate when ExistingExpiry > Now ->
            New = Candidate#{
                expires => Now + ?LEASE_MS,
                lease_generation => maps:get(lease_generation, Candidate) + 1
            },
            {
                Game#{
                    candidates => Candidates#{SessionId => New},
                    pending => pending_after_clear(SessionId, Game)
                },
                false
            };
        _ ->
            accept_change(SessionId, Activity, Now, Wall, Game)
    end.

-spec accept_change(binary(), map(), integer(), integer(), map()) -> {map(), boolean()}.
accept_change(SessionId, Activity, Now, Wall, Game) ->
    {Tokens, BudgetAt} = refill(Now, Game),
    Budgeted = Game#{tokens => Tokens, budget_at => BudgetAt},
    case Tokens > 0 of
        false ->
            {Budgeted#{pending => {SessionId, Activity, maps:get(owner_epoch, Game)}}, false};
        true ->
            accept_candidate(SessionId, Activity, Now, Wall, Budgeted)
    end.

-spec accept_candidate(binary(), map(), integer(), integer(), map()) -> {map(), boolean()}.
accept_candidate(SessionId, Activity, Now, Wall, Game) ->
    Candidates = maps:get(candidates, Game, #{}),
    Previous = maps:get(SessionId, Candidates, #{}),
    Started = canonical_start(maps:get(<<"started_at">>, Activity), Wall),
    New = #{
        raw => Activity,
        activity => Activity#{<<"started_at">> => Started},
        changed => {Now, SessionId},
        expires => Now + ?LEASE_MS,
        lease_generation => maps:get(lease_generation, Previous, 0) + 1
    },
    Next = Game#{
        candidates => Candidates#{SessionId => New},
        change_sequence => maps:get(change_sequence, Game, 0) + 1,
        tokens => maps:get(tokens, Game) - 1,
        pending => undefined,
        owner => SessionId,
        activity_revision => maps:get(activity_revision, Game, 0) + 1
    },
    {Owner, _} = selected(Next, Now),
    {Next#{owner => Owner}, true}.

-spec canonical_start(integer(), integer()) -> integer().
canonical_start(Started, Wall) when Started >= Wall - 604800000, Started =< Wall + 60000 ->
    Started;
canonical_start(_Started, Wall) ->
    Wall.

-spec refill(integer(), map()) -> {non_neg_integer(), integer()}.
refill(Now, Game) ->
    At = maps:get(budget_at, Game, Now),
    Added = max(0, (Now - At) div 10000),
    {min(2, maps:get(tokens, Game, 0) + Added), At + Added * 10000}.

-spec selected(map(), integer()) -> {binary() | undefined, map() | null}.
selected(Game, Now) ->
    Candidates = maps:get(candidates, Game, #{}),
    Valid = [
        {maps:get(changed, C), Id, C}
     || {Id, C} <- maps:to_list(Candidates), maps:get(expires, C, 0) > Now
    ],
    case Valid of
        [] ->
            {undefined, null};
        _ ->
            {_, Id, C} = lists:max(Valid),
            {Id, maps:get(activity, C)}
    end.

-spec clear(binary(), map()) -> map().
clear(SessionId, State) ->
    Old = game(State),
    Candidates = maps:get(candidates, Old, #{}),
    Pending = pending_after_clear(SessionId, Old),
    case maps:is_key(SessionId, Candidates) of
        false ->
            store_game(Old#{pending => Pending}, State);
        true ->
            New = Old#{candidates => maps:remove(SessionId, Candidates), pending => Pending},
            guilds(
                select_after_clear(maps:get(owner, Old, undefined) =:= SessionId, New, State)
            )
    end.

-spec pending_after_clear(binary(), map()) -> term().
pending_after_clear(SessionId, Game) ->
    case maps:get(pending, Game, undefined) of
        {SessionId, _, _} -> undefined;
        Pending -> Pending
    end.

-spec select_after_clear(boolean(), map(), map()) -> map().
select_after_clear(false, Game, State) ->
    store_game(Game, State);
select_after_clear(true, Game, State) ->
    {Owner, _} = selected(Game, erlang:monotonic_time(millisecond)),
    maybe_deliver(
        true,
        store_game(
            Game#{
                owner => Owner,
                activity_revision => maps:get(activity_revision, Game, 0) + 1
            },
            State
        )
    ).

-spec disconnect(binary(), map()) -> map().
disconnect(SessionId, State) -> guilds(clear(SessionId, State)).

-spec expire(binary(), non_neg_integer(), binary(), map()) -> map().
expire(SessionId, Generation, Epoch, State) ->
    Game = game(State),
    Candidate = maps:get(SessionId, maps:get(candidates, Game, #{}), undefined),
    CurrentEpoch = maps:get(owner_epoch, Game),
    Now = erlang:monotonic_time(millisecond),
    case Candidate of
        #{lease_generation := Generation, expires := Expiry} when
            Epoch =:= CurrentEpoch, Expiry =< Now
        ->
            clear(SessionId, State);
        _ ->
            State
    end.

-spec schedule_candidate(binary(), map(), map()) -> map().
schedule_candidate(SessionId, Old, Game) ->
    Candidates = maps:get(candidates, Game, #{}),
    case maps:get(SessionId, Candidates, undefined) of
        #{lease_generation := Generation, expires := Expiry} = Candidate ->
            Previous = maps:get(SessionId, maps:get(candidates, Old, #{}), #{}),
            cancel_timer(maps:get(timer, Previous, undefined)),
            Timer = erlang:send_after(
                max(0, Expiry - erlang:monotonic_time(millisecond)),
                self(),
                {game_activity_expire, SessionId, Generation, maps:get(owner_epoch, Game)}
            ),
            Game#{candidates => Candidates#{SessionId => Candidate#{timer => Timer}}};
        _ ->
            Game
    end.

-spec schedule_pending(map()) -> map().
schedule_pending(Game) ->
    cancel_timer(maps:get(pending_timer, Game, undefined)),
    Timer =
        case maps:get(pending, Game, undefined) of
            undefined ->
                undefined;
            _ ->
                erlang:send_after(
                    max(
                        1,
                        maps:get(budget_at, Game) + 10000 - erlang:monotonic_time(millisecond)
                    ),
                    self(),
                    game_activity_pending
                )
        end,
    Game#{pending_timer => Timer}.

-spec cancel_timer(term()) -> ok.
cancel_timer(Ref) when is_reference(Ref) ->
    _ = erlang:cancel_timer(Ref),
    ok;
cancel_timer(_) ->
    ok.

-spec pending(map()) -> map().
pending(State) ->
    Game = game(State),
    CurrentEpoch = maps:get(owner_epoch, Game),
    case maps:get(pending, Game, undefined) of
        {SessionId, Activity, CurrentEpoch} ->
            update(#{session_id => SessionId, game_activity => Activity}, State);
        _ ->
            State
    end.

-spec delivery_batch(non_neg_integer(), maps:iterator(), map()) -> map().
delivery_batch(Revision, Iterator, State) ->
    case maps:get(activity_revision, game(State), 0) =:= Revision of
        true -> delivery_batch(100, Revision, Iterator, State);
        false -> State
    end.

-spec delivery_batch(non_neg_integer(), non_neg_integer(), maps:iterator(), map()) -> map().
delivery_batch(0, Revision, Iterator, State) ->
    self() ! {game_activity_delivery, Revision, Iterator},
    State;
delivery_batch(N, Revision, Iterator, State) ->
    case maps:next(Iterator) of
        none ->
            State;
        {Pid, Entry, Next} ->
            Delivered = deliver([{Pid, Entry}], State),
            continue_delivery(N, Revision, Iterator, Next, Delivered)
    end.

-spec continue_delivery(
    non_neg_integer(), non_neg_integer(), maps:iterator(), maps:iterator(), map()
) -> map().
continue_delivery(
    _N, Revision, Iterator, _Next, #{game_activity_delivery_busy := true} = State
) ->
    erlang:send_after(25, self(), {game_activity_delivery, Revision, Iterator}),
    maps:remove(game_activity_delivery_busy, State);
continue_delivery(N, Revision, _Iterator, Next, State) ->
    delivery_batch(N - 1, Revision, Next, State).

-spec context(integer(), map()) -> {ok, map()}.
context(ViewerId, State) ->
    {ok, (presence_game_activity_policy:context(ViewerId, game(State)))#{owner_pid => self()}}.

-spec bootstrap(binary() | {session, binary()}, map(), map()) -> map().
bootstrap(Nonce, Policy, State) ->
    Old = game(State),
    New = presence_game_activity_policy:bootstrap(Nonce, Policy, Old),
    case New =/= Old of
        true -> refresh_interested(all, New, maps:get(user_id, State));
        false -> ok
    end,
    store_game(New, State).

-spec subscribe(integer(), pid(), map(), map(), map()) -> {term(), map()}.
subscribe(Viewer, SessionPid, Context, Grant, State) ->
    Interested = maybe_track_interest(Viewer, SessionPid, Context, Grant, State),
    Game = game(Interested),
    case
        allowed(Interested) andalso is_pid(SessionPid) andalso
            presence_game_activity_policy:grant_allowed(
                Viewer, Context, Grant, Game, Interested
            )
    of
        false -> {{error, denied}, Interested};
        true -> install_grant(Viewer, SessionPid, Game, Interested)
    end.

-spec maybe_track_interest(integer(), pid(), map(), map(), map()) -> map().
maybe_track_interest(Viewer, Pid, Context, Grant, State) ->
    Game = game(State),
    case
        gateway_rollout_config:game_activity_allowed() andalso is_pid(Pid) andalso
            presence_game_activity_policy:interest_allowed(Viewer, Context, Grant, Game, State)
    of
        false ->
            State;
        true ->
            Interests = maps:get(interests, Game, #{}),
            Ref = interest_monitor(Pid, Game),
            Refs = maps:get(receiver_refs, Game, #{}),
            Entry = #{viewer_id => Viewer, stamp => Context, mref => Ref},
            Tracked = presence_game_activity_policy:track_receiver(Viewer, Pid, Game),
            store_game(
                Tracked#{
                    interests => Interests#{Pid => Entry}, receiver_refs => Refs#{Ref => Pid}
                },
                State
            )
    end.

-spec interest_monitor(pid(), map()) -> reference().
interest_monitor(Pid, Game) ->
    Existing = maps:get(
        Pid,
        maps:get(interests, Game, #{}),
        maps:get(Pid, maps:get(ledger, Game, #{}), #{})
    ),
    case maps:get(mref, Existing, undefined) of
        undefined -> monitor(process, Pid);
        Ref -> Ref
    end.

-spec install_grant(integer(), pid(), map(), map()) -> {term(), map()}.
install_grant(Viewer, SessionPid, Game, State) ->
    Stamp = (presence_game_activity_policy:context(Viewer, Game))#{
        allowed => true, owner_pid => self()
    },
    case
        receiver_call(SessionPid, {game_activity_grant, maps:get(user_id, State), Stamp}, 1000)
    of
        {ok, Stamp} -> record_grant(Viewer, SessionPid, Stamp, Game, State);
        _ -> {{error, receiver_unavailable}, State}
    end.

-spec record_grant(integer(), pid(), map(), map(), map()) -> {term(), map()}.
record_grant(Viewer, SessionPid, Stamp, Game, State) ->
    Grants = maps:get(grants, Game, #{}),
    Ledger = maps:get(ledger, Game, #{}),
    Ref = interest_monitor(SessionPid, Game),
    Entry = #{viewer_id => Viewer, stamp => Stamp, mref => Ref},
    Refs = maps:get(receiver_refs, Game, #{}),
    Next = Game#{
        grants => Grants#{SessionPid => Entry},
        receiver_refs => Refs#{Ref => SessionPid},
        ledger => Ledger#{SessionPid => Entry}
    },
    self() !
        {game_activity_delivery, maps:get(activity_revision, Game, 0),
            maps:iterator(#{SessionPid => Entry})},
    {{ok, Stamp}, store_game(Next, State)}.

-spec maybe_deliver(boolean(), map()) -> map().
maybe_deliver(false, State) ->
    State;
maybe_deliver(true, State) ->
    Game = game(State),
    self() !
        {game_activity_delivery, maps:get(activity_revision, Game, 0),
            maps:iterator(maps:get(grants, Game, #{}))},
    State.

-spec deliver([{pid(), map()}], map()) -> map().
deliver([], State) ->
    State;
deliver([{Pid, Entry} | Rest], State) ->
    Game = game(State),
    Viewer = maps:get(viewer_id, Entry),
    Stamp = (presence_game_activity_policy:context(Viewer, Game))#{allowed => true},
    {_, Activity0} = selected(Game, erlang:monotonic_time(millisecond)),
    Activity =
        case allowed(State) of
            true -> Activity0;
            false -> null
        end,
    Pair = maps:get(Viewer, maps:get(pairs, Game, #{}), #{}),
    EntryStamp = maps:get(stamp, Entry),
    Fresh = lists:all(
        fun(K) -> maps:get(K, EntryStamp, undefined) =:= maps:get(K, Stamp) end,
        [
            owner_epoch,
            policy_revision,
            pair_generation,
            rollout_epoch,
            rollout_generation,
            request_nonce
        ]
    ),
    case
        maps:get(Pid, maps:get(grants, Game, #{}), undefined) =:= Entry andalso Fresh andalso
            not maps:get(fenced, Pair, false) andalso
            maps:is_key(Viewer, maps:get(friends, State, #{}))
    of
        true ->
            Payload = #{
                <<"user">> => #{<<"id">> => integer_to_binary(maps:get(user_id, State))},
                <<"game_activity">> => Activity,
                game_activity_stamp => Stamp
            },
            deliver_payload(Pid, Entry, Rest, Payload, Game, State);
        false ->
            deliver(Rest, State)
    end.

-spec deliver_payload(pid(), map(), [{pid(), map()}], map(), map(), map()) -> map().
deliver_payload(Pid, Entry, Rest, Payload, Game, State) ->
    case gateway_dispatch_relay:dispatch_game_activity_many([Pid], Payload) of
        ok ->
            Ledger = maps:get(ledger, Game, #{}),
            deliver(Rest, store_game(Game#{ledger => Ledger#{Pid => Entry}}, State));
        busy ->
            State#{game_activity_delivery_busy => true}
    end.

-spec receiver_down(reference(), map()) -> map().
receiver_down(Ref, State) ->
    Game = game(State),
    Ledger = maps:get(ledger, Game, #{}),
    Refs = maps:get(receiver_refs, Game, #{}),
    case maps:take(Ref, Refs) of
        error ->
            State;
        {Pid, Rest} ->
            Entry = maps:get(Pid, maps:get(interests, Game, #{}), maps:get(Pid, Ledger, #{})),
            Pruned = presence_game_activity_policy:untrack_receiver(
                maps:get(viewer_id, Entry), Pid, Game
            ),
            store_game(
                Pruned#{
                    ledger => maps:remove(Pid, Ledger),
                    grants => maps:remove(Pid, maps:get(grants, Game, #{})),
                    receiver_refs => Rest,
                    interests => maps:remove(Pid, maps:get(interests, Game, #{}))
                },
                State
            )
    end.

-spec control(policy | pair, map(), map()) -> {term(), map()}.
control(Kind, Request, State) ->
    Old = game(State),
    Result =
        case Kind of
            policy -> presence_game_activity_policy:control(Request, Old);
            pair -> presence_game_activity_policy:pair_control(Request, Old)
        end,
    case Result of
        {error, Reason} ->
            {{error, Reason}, State};
        {ok, New} ->
            Viewer = control_viewer(Kind, Request),
            Targets = {Viewer, maps:iterator(maps:get(ledger, Old, #{}))},
            NewState = guild_control(Kind, Viewer, Request, store_game(New, State)),
            Ack = presence_game_activity_policy:ack(Kind, Request, New),
            {{barrier, Targets, Ack}, NewState}
    end.

-spec control_viewer(policy | pair, map()) -> term().
control_viewer(policy, _Request) ->
    all;
control_viewer(pair, Request) ->
    presence_game_activity_policy:value(viewer_id, Request, undefined).

-spec barrier({term(), maps:iterator()}, map(), map(), pid()) -> term().
barrier(Targets, Ack, State, ReplyTo) ->
    GuildDeadline = erlang:monotonic_time(millisecond) + ?GUILD_ACK_MS,
    Reply =
        case
            presence_game_activity_policy:revoke(
                Targets, State, erlang:monotonic_time(millisecond) + 4500
            )
        of
            {ok, Count} ->
                Guilds = guild_acks(
                    maps:get(game_activity_guild_wait, State, undefined), GuildDeadline
                ),
                guild_barrier_reply(Guilds, Targets, Ack, Count, State);
            Error ->
                Error
        end,
    ReplyTo ! {game_activity_barrier_done, self(), Reply}.

-spec guild_barrier_reply(ok | {error, atom()}, tuple(), map(), non_neg_integer(), map()) ->
    term().
guild_barrier_reply(ok, Targets, Ack, Count, State) ->
    refresh_after_apply(Targets, Ack, State),
    {ok, ack_count(Ack, Count)};
guild_barrier_reply(Error, _Targets, _Ack, _Count, _State) ->
    Error.

-spec guild_acks(reference() | undefined, integer()) -> ok | {error, atom()}.
guild_acks(undefined, _Deadline) ->
    ok;
guild_acks(Wait, Deadline) ->
    receive
        {game_activity_guild_acks, Wait, Result} -> Result
    after max(0, Deadline - erlang:monotonic_time(millisecond)) ->
        {error, guild_timeout}
    end.

-spec ack_count(map(), non_neg_integer()) -> map().
ack_count(#{<<"revoked_sessions">> := _} = Ack, Count) ->
    Ack#{<<"revoked_sessions">> => Count};
ack_count(Ack, _Count) ->
    Ack.

-spec refresh_after_apply(tuple(), map(), map()) -> ok.
refresh_after_apply({Viewer, _}, #{<<"phase">> := <<"apply">>}, State) ->
    refresh_interested(Viewer, game(State), maps:get(user_id, State));
refresh_after_apply(_, _, _) ->
    ok.

-spec refresh_interested(term(), map(), integer()) -> ok.
refresh_interested(Viewer, Game, OwnerId) ->
    spawn(fun() ->
        presence_game_activity_policy:refresh(
            {Viewer, maps:iterator(maps:get(interests, Game, #{}))}, OwnerId
        ),
        presence_game_activity_policy:refresh(
            {Viewer, maps:iterator(maps:get(ledger, Game, #{}))}, OwnerId
        )
    end),
    ok.

-spec receiver_call(pid(), term(), pos_integer()) -> term().
receiver_call(Pid, Message, Timeout) ->
    try
        gen_server:call(Pid, Message, Timeout)
    catch
        exit:_ -> {error, receiver_unavailable}
    end.

-spec rollout(map()) -> map().
rollout(State) ->
    rollout(State, game_activity_reset).

-spec rollout_changed(map()) -> map().
rollout_changed(State) ->
    rollout(State, game_activity_rollout_changed).

-spec rollout(map(), atom()) -> map().
rollout(State, Notification) ->
    lists:foreach(
        fun(Pid) -> gen_server:cast(Pid, Notification) end,
        presence_connect:collect_session_pids(State)
    ),
    Old = game(State),
    New = Old#{
        candidates => #{},
        owner => undefined,
        grants => #{},
        pending => undefined,
        refresh_on_activity => true,
        request_nonce => base64:encode(crypto:strong_rand_bytes(24)),
        rollout_epoch => maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0),
        rollout_generation => gateway_rollout_config:game_activity_generation(),
        activity_revision => maps:get(activity_revision, Old, 0) + 1
    },
    Next = store_game(New, State),
    spawn(fun() ->
        presence_game_activity_policy:revoke(
            {all, maps:iterator(maps:get(ledger, Old, #{}))},
            Next,
            erlang:monotonic_time(millisecond) + 4500
        )
    end),
    guilds(Next).

-spec guilds(map()) -> map().
guilds(State) ->
    Message = guild_message(State),
    Next =
        case Message of
            null -> cancel_guild_retries(State);
            _ -> State
        end,
    case Message =:= maps:get(guild_published, game(Next), null) of
        true -> Next;
        false -> publish_guilds(Message, Next)
    end.

-spec guild_message(map()) -> null | {map(), map(), map()}.
guild_message(State) ->
    Game = game(State),
    case
        map_size(maps:get(candidates, Game, #{})) > 0 andalso
            presence_game_activity_policy:permitted_everyone(Game) andalso allowed(State)
    of
        false -> null;
        true -> guild_projection(selected(Game, erlang:monotonic_time(millisecond)), Game)
    end.

-spec guild_projection({term(), map() | null}, map()) -> null | {map(), map(), map()}.
guild_projection({_, null}, _Game) ->
    null;
guild_projection({_, Activity}, Game) ->
    {Activity, guild_stamp(Game), presence_game_activity_policy:excluded(Game)}.

-spec guild_stamp(map()) -> map().
guild_stamp(Game) ->
    #{
        owner_epoch => maps:get(owner_epoch, Game),
        activity_revision => maps:get(activity_revision, Game, 0),
        rollout_epoch => maps:get(rollout_epoch, Game, 0)
    }.

-spec publish_message(null | {map(), map(), map()}, map()) -> tuple().
publish_message(null, State) ->
    Game = game(State),
    {game_activity_publish, maps:get(user_id, State), self(), null, guild_stamp(Game),
        presence_game_activity_policy:excluded(Game)};
publish_message({Activity, Stamp, Excluded}, State) ->
    {game_activity_publish, maps:get(user_id, State), self(), Activity, Stamp, Excluded}.

-spec publish_guilds(null | {map(), map(), map()}, map()) -> map().
publish_guilds(Message, State) ->
    Game = game(State),
    Cast = publish_message(Message, State),
    maps:foreach(
        fun(_GuildId, {Pid, _Ref}) -> gen_server:cast(Pid, Cast) end,
        maps:get(guild_targets, Game, #{})
    ),
    Sent = maps:fold(
        fun(_GuildId, {_Pid, Ref}, Acc) -> Acc#{Ref => true} end,
        maps:get(guild_sent, Game, #{}),
        maps:get(guild_targets, Game, #{})
    ),
    Published = store_game(Game#{guild_published => Message, guild_sent => Sent}, State),
    case Message of
        null -> Published;
        _ -> resolve_guilds(maps:keys(maps:get(guild_ids, State, #{})), Published)
    end.

-spec resolve_guilds([integer()], map()) -> map().
resolve_guilds(GuildIds, State) ->
    Game = game(State),
    Targets = maps:get(guild_targets, Game, #{}),
    Resolving = maps:get(guild_resolving, Game, #{}),
    Retries = maps:get(guild_retries, Game, #{}),
    Leaves = maps:get(guild_leaves, Game, #{}),
    Leaving = maps:from_list([{G, true} || {G, _Pid} <- maps:values(Leaves)]),
    Slots = max(
        0, 200 - map_size(Targets) - map_size(Leaves) - map_size(Resolving) - map_size(Retries)
    ),
    Missing =
        [
            GuildId
         || GuildId <- GuildIds,
            not is_map_key(GuildId, Targets),
            not is_map_key(GuildId, Resolving),
            not is_map_key(GuildId, Retries),
            not is_map_key(GuildId, Leaving),
            is_map_key(GuildId, maps:get(guild_ids, State, #{}))
        ],
    Starting = lists:sublist(Missing, Slots),
    Owner = self(),
    lists:foreach(
        fun(GuildId) ->
            spawn(fun() ->
                Owner ! {game_activity_guild_resolved, GuildId, lookup_guild(GuildId)}
            end)
        end,
        Starting
    ),
    Next = maps:merge(Resolving, maps:from_keys(Starting, true)),
    Deferred = maps:merge(maps:get(guild_deferred, Game, #{}), maps:from_keys(Missing, true)),
    Waiting = maps:filter(
        fun(GuildId, _) ->
            is_map_key(GuildId, maps:get(guild_ids, State, #{})) andalso
                not is_map_key(GuildId, Targets) andalso not is_map_key(GuildId, Next) andalso
                not is_map_key(GuildId, Retries) andalso
                not is_map_key(GuildId, Leaving)
        end,
        Deferred
    ),
    store_game(
        Game#{
            guild_resolving => Next,
            guild_deferred => maps:from_keys(lists:sublist(maps:keys(Waiting), 200), true)
        },
        State
    ).

-spec resolve_deferred(map()) -> map().
resolve_deferred(State) ->
    Game = game(State),
    case maps:get(guild_published, Game, null) of
        null -> State;
        _ -> resolve_guilds(maps:keys(maps:get(guild_deferred, Game, #{})), State)
    end.

-spec lookup_guild(integer()) -> {ok, pid()} | error.
lookup_guild(GuildId) ->
    try guild_manager:lookup(GuildId, ?GUILD_ACK_MS) of
        {ok, Pid} when is_pid(Pid) -> {ok, Pid};
        _ -> error
    catch
        _:_ -> error
    end.

-spec guild_resolved(integer(), {ok, pid()} | error, map()) -> map().
guild_resolved(GuildId, Result, State) ->
    Game0 = game(State),
    Game = Game0#{
        guild_resolving => maps:remove(GuildId, maps:get(guild_resolving, Game0, #{})),
        guild_deferred => maps:remove(GuildId, maps:get(guild_deferred, Game0, #{}))
    },
    Targets = maps:get(guild_targets, Game, #{}),
    Wanted =
        is_map_key(GuildId, maps:get(guild_ids, State, #{})) andalso
            not is_map_key(GuildId, Targets) andalso
            maps:get(guild_published, Game, null) =/= null,
    Next =
        case {Result, Wanted} of
            {{ok, Pid}, true} ->
                Ref = monitor(process, Pid),
                Refs = maps:get(guild_refs, Game, #{}),
                Message = maps:get(guild_published, Game, null),
                publish_to(Pid, Message, State),
                Sent = maps:get(guild_sent, Game, #{}),
                Published =
                    case Message of
                        null -> Sent;
                        _ -> Sent#{Ref => true}
                    end,
                remove_guild_retry(
                    GuildId,
                    store_game(
                        Game#{
                            guild_targets => Targets#{GuildId => {Pid, Ref}},
                            guild_refs => Refs#{Ref => GuildId},
                            guild_sent => Published
                        },
                        State
                    )
                );
            {error, true} ->
                schedule_guild_retry(GuildId, store_game(Game, State));
            _ ->
                remove_guild_retry(GuildId, store_game(Game, State))
        end,
    resolve_deferred(Next).

-spec publish_to(pid(), null | {map(), map(), map()}, map()) -> ok.
publish_to(_Pid, null, _State) -> ok;
publish_to(Pid, Message, State) -> gen_server:cast(Pid, publish_message(Message, State)).

-spec guild_down(reference(), map()) -> map().
guild_down(Ref, State) ->
    case is_map_key(Ref, maps:get(guild_leaves, game(State), #{})) of
        true -> guild_leave_done(Ref, State);
        false -> active_guild_down(Ref, State)
    end.

-spec active_guild_down(reference(), map()) -> map().
active_guild_down(Ref, State) ->
    Game = game(State),
    case maps:take(Ref, maps:get(guild_refs, Game, #{})) of
        error ->
            State;
        {GuildId, Refs} ->
            Targets = maps:remove(GuildId, maps:get(guild_targets, Game, #{})),
            resolve_deferred(
                schedule_guild_retry(
                    GuildId,
                    store_game(
                        Game#{
                            guild_refs => Refs,
                            guild_targets => Targets,
                            guild_sent => maps:remove(Ref, maps:get(guild_sent, Game, #{}))
                        },
                        State
                    )
                )
            )
    end.

-spec guild_retry(reference(), map()) -> map().
guild_retry(Token, State) ->
    Game = game(State),
    case maps:get(guild_retry_timer, Game, undefined) of
        {_Timer, Token} ->
            Now = erlang:monotonic_time(millisecond),
            {Due, Waiting} = maps:fold(
                fun(GuildId, #{at := At} = Entry, {Ready, Rest}) ->
                    case At =< Now of
                        true -> {[GuildId | Ready], Rest};
                        false -> {Ready, Rest#{GuildId => Entry}}
                    end
                end,
                {[], #{}},
                maps:get(guild_retries, Game, #{})
            ),
            Next = store_game(
                Game#{guild_retries => Waiting, guild_retry_timer => undefined}, State
            ),
            schedule_guild_retry_timer(resolve_guilds(Due, Next));
        _ ->
            State
    end.

-spec schedule_guild_retry(integer(), map()) -> map().
schedule_guild_retry(GuildId, State) ->
    Game = game(State),
    case
        maps:get(guild_published, Game, null) =/= null andalso
            is_map_key(GuildId, maps:get(guild_ids, State, #{}))
    of
        false ->
            remove_guild_retry(GuildId, State);
        true ->
            Backoff = maps:get(guild_retry_backoff, Game, #{}),
            Delay = min(?GUILD_RETRY_MAX_MS, maps:get(GuildId, Backoff, ?GUILD_RETRY_MS)),
            At = erlang:monotonic_time(millisecond) + Delay div 2 + rand:uniform(Delay div 2),
            Retries = maps:get(guild_retries, Game, #{}),
            schedule_guild_retry_timer(
                store_game(
                    Game#{
                        guild_retries => Retries#{GuildId => #{at => At}},
                        guild_retry_backoff => Backoff#{
                            GuildId => min(?GUILD_RETRY_MAX_MS, Delay * 2)
                        }
                    },
                    State
                )
            )
    end.

-spec schedule_guild_retry_timer(map()) -> map().
schedule_guild_retry_timer(State) ->
    Game = game(State),
    case maps:get(guild_retry_timer, Game, undefined) of
        {Timer, _} -> cancel_timer(Timer);
        _ -> ok
    end,
    TimerEntry =
        case maps:values(maps:get(guild_retries, Game, #{})) of
            [] ->
                undefined;
            Entries ->
                At = lists:min([maps:get(at, Entry) || Entry <- Entries]),
                Token = make_ref(),
                Ref = erlang:send_after(
                    max(0, At - erlang:monotonic_time(millisecond)),
                    self(),
                    {game_activity_guild_retry, Token}
                ),
                {Ref, Token}
        end,
    store_game(Game#{guild_retry_timer => TimerEntry}, State).

-spec remove_guild_retry(integer(), map()) -> map().
remove_guild_retry(GuildId, State) ->
    Game = game(State),
    case
        is_map_key(GuildId, maps:get(guild_retries, Game, #{})) orelse
            is_map_key(GuildId, maps:get(guild_retry_backoff, Game, #{}))
    of
        false ->
            State;
        true ->
            schedule_guild_retry_timer(
                store_game(
                    Game#{
                        guild_retries => maps:remove(
                            GuildId, maps:get(guild_retries, Game, #{})
                        ),
                        guild_retry_backoff => maps:remove(
                            GuildId, maps:get(guild_retry_backoff, Game, #{})
                        )
                    },
                    State
                )
            )
    end.

-spec cancel_guild_retries(map()) -> map().
cancel_guild_retries(State) ->
    Game = game(State),
    case
        maps:get(guild_retries, Game, #{}) =:= #{} andalso
            maps:get(guild_retry_backoff, Game, #{}) =:= #{}
    of
        true ->
            State;
        false ->
            schedule_guild_retry_timer(
                store_game(
                    Game#{
                        guild_retries => #{}, guild_retry_backoff => #{}
                    },
                    State
                )
            )
    end.

-spec join_guild(integer(), map()) -> map().
join_guild(GuildId, State) ->
    case
        maps:get(guild_published, game(State), null) =/= null andalso
            is_map_key(GuildId, maps:get(guild_ids, State, #{}))
    of
        true -> resolve_guilds([GuildId], State);
        false -> State
    end.

-spec leave_guild(integer(), map()) -> map().
leave_guild(GuildId, State) ->
    Released = remove_guild_retry(GuildId, State),
    Game0 = game(Released),
    Game =
        case maps:find(guild_deferred, Game0) of
            {ok, Deferred} -> Game0#{guild_deferred => maps:remove(GuildId, Deferred)};
            error -> Game0
        end,
    case maps:take(GuildId, maps:get(guild_targets, Game, #{})) of
        error ->
            resolve_deferred(store_game(Game, Released));
        {{Pid, Ref}, Targets} ->
            Refs = maps:remove(Ref, maps:get(guild_refs, Game, #{})),
            Sent = maps:get(guild_sent, Game, #{}),
            Next = Game#{
                guild_targets => Targets,
                guild_refs => Refs,
                guild_sent => maps:remove(Ref, Sent)
            },
            case is_map_key(Ref, Sent) of
                false ->
                    demonitor(Ref, [flush]),
                    resolve_deferred(store_game(Next, State));
                true ->
                    %% Keep the ordered revoke until ACK or DOWN, including after a null publish.
                    Requests = gen_server:send_request(
                        Pid,
                        {game_activity_revoke, maps:get(user_id, State),
                            maps:get(owner_epoch, Game)},
                        Ref,
                        maps:get(guild_leave_requests, Game, gen_server:reqids_new())
                    ),
                    Leaves = maps:get(guild_leaves, Game, #{}),
                    store_game(
                        Next#{
                            guild_leaves => Leaves#{Ref => {GuildId, Pid}},
                            guild_leave_requests => Requests
                        },
                        State
                    )
            end
    end.

-spec guild_leave_done(reference(), map()) -> map().
guild_leave_done(Ref, State) ->
    Game = game(State),
    case maps:take(Ref, maps:get(guild_leaves, Game, #{})) of
        error ->
            State;
        {{_GuildId, _Pid}, Leaves} ->
            demonitor(Ref, [flush]),
            Requests = maps:get(guild_leave_requests, Game, gen_server:reqids_new()),
            Remaining = lists:foldl(
                fun({Request, Label}, Acc) ->
                    case Label =:= Ref of
                        true ->
                            _ = gen_server:receive_response(Request, 0),
                            Acc;
                        false ->
                            gen_server:reqids_add(Request, Label, Acc)
                    end
                end,
                gen_server:reqids_new(),
                gen_server:reqids_to_list(Requests)
            ),
            Released = store_game(
                Game#{
                    guild_leaves => Leaves,
                    guild_leave_requests => Remaining
                },
                State
            ),
            Barriers = maps:get(game_activity_guild_barriers, Released, #{}),
            Next = maps:fold(
                fun(Wait, {Worker, GuildRequests, Pending}, Acc) ->
                    guild_ack_state(Wait, Worker, GuildRequests, maps:remove(Ref, Pending), Acc)
                end,
                Released,
                Barriers
            ),
            case maps:get(guild_published, game(Next), null) of
                null -> Next;
                _ -> resolve_guilds(maps:keys(maps:get(guild_ids, Next, #{})), Next)
            end
    end.

-spec blocked([term()], map()) -> map().
blocked(Ids, State) ->
    Game = game(State),
    Blocked = maps:from_keys([Id || Id <- Ids, is_integer(Id)], true),
    guilds(store_game(Game#{blocked_sync => Blocked}, State)).

-spec guild_control(policy | pair, term(), map(), map()) -> map().
guild_control(Kind, Viewer, Request, State) ->
    case presence_game_activity_policy:value(phase, Request, undefined) of
        <<"fence">> -> guilds(guild_fence(Kind, Viewer, State));
        _ -> guilds(State)
    end.

%% Fence requests leave the owner process itself, behind any earlier publish to the same
%% guild, so a guild cannot apply an older publish after acknowledging the fence.
%% TEMPORARY: one call per guild the owner published to (up to 200, parallel, 2 s limit).
%% Target: one call per guild node carrying every guild of the owner on that node.
%% Trigger: fence acknowledgement p99 above 2 s.
-spec guild_fence(policy | pair, term(), map()) -> map().
guild_fence(Kind, Viewer, State) ->
    Game = game(State),
    OwnerId = maps:get(user_id, State),
    {Call, Published} =
        case Kind of
            policy -> {{game_activity_revoke, OwnerId, maps:get(owner_epoch, Game)}, null};
            pair -> {{game_activity_exclude, OwnerId, Viewer}, guild_message(State)}
        end,
    Requests = maps:fold(
        fun(_GuildId, {Pid, _Ref}, Acc) -> gen_server:send_request(Pid, Call, Pid, Acc) end,
        gen_server:reqids_new(),
        maps:get(guild_targets, Game, #{})
    ),
    store_game(Game#{guild_published => Published, guild_requests => Requests}, State).

-spec start_barrier({term(), maps:iterator()}, map(), gen_server:from(), map()) -> map().
start_barrier(Targets, Ack, From, State) ->
    Game = game(State),
    Requests = maps:get(guild_requests, Game, gen_server:reqids_new()),
    Leaves =
        case maps:get(<<"phase">>, Ack, undefined) of
            <<"fence">> -> maps:from_keys(maps:keys(maps:get(guild_leaves, Game, #{})), true);
            _ -> #{}
        end,
    Next = store_game(maps:remove(guild_requests, Game), State),
    Wait =
        case gen_server:reqids_size(Requests) + map_size(Leaves) of
            0 -> undefined;
            _ -> make_ref()
        end,
    Worker = spawn(?MODULE, barrier, [
        Targets, Ack, Next#{game_activity_guild_wait => Wait}, self()
    ]),
    Barriers = maps:get(game_activity_barriers, Next, #{}),
    GuildBarriers = maps:get(game_activity_guild_barriers, Next, #{}),
    Next#{
        game_activity_barriers => Barriers#{Worker => From},
        game_activity_guild_barriers => track_guild_barrier(
            Wait, Worker, Requests, Leaves, GuildBarriers
        )
    }.

-spec track_guild_barrier(reference() | undefined, pid(), term(), map(), map()) -> map().
track_guild_barrier(undefined, _Worker, _Requests, _Leaves, Barriers) ->
    Barriers;
track_guild_barrier(Wait, Worker, Requests, Leaves, Barriers) ->
    Barriers#{Wait => {Worker, Requests, Leaves}}.

-spec guild_response(term(), map()) -> {handled, map()} | unhandled.
guild_response(Message, State) ->
    Game = game(State),
    Requests = maps:get(guild_leave_requests, Game, gen_server:reqids_new()),
    case gen_server:check_response(Message, Requests, true) of
        {{reply, ok}, Ref, Rest} ->
            {handled,
                guild_leave_done(Ref, store_game(Game#{guild_leave_requests => Rest}, State))};
        {_Failed, _Ref, Rest} ->
            {handled, store_game(Game#{guild_leave_requests => Rest}, State)};
        _ ->
            guild_barrier_response(Message, State)
    end.

-spec guild_barrier_response(term(), map()) -> {handled, map()} | unhandled.
guild_barrier_response(Message, State) ->
    Barriers = maps:get(game_activity_guild_barriers, State, #{}),
    guild_response(maps:next(maps:iterator(Barriers)), Message, State).

-spec guild_response(none | {reference(), tuple(), maps:iterator()}, term(), map()) ->
    {handled, map()} | unhandled.
guild_response(none, _Message, _State) ->
    unhandled;
guild_response({Wait, {Worker, Requests, Leaves}, Iterator}, Message, State) ->
    case gen_server:check_response(Message, Requests, true) of
        no_reply ->
            guild_response(maps:next(Iterator), Message, State);
        no_request ->
            guild_response(maps:next(Iterator), Message, State);
        {{reply, ok}, _Pid, Rest} ->
            {handled, guild_ack_state(Wait, Worker, Rest, Leaves, State)};
        {_Failed, _Pid, _Rest} ->
            finish_guild_barrier(Wait, Worker, {error, guild_unavailable}, State)
    end.

-spec guild_ack_state(reference(), pid(), term(), map(), map()) -> map().
guild_ack_state(Wait, Worker, Requests, Leaves, State) ->
    case gen_server:reqids_size(Requests) + map_size(Leaves) of
        0 ->
            {handled, Next} = finish_guild_barrier(Wait, Worker, ok, State),
            Next;
        _ ->
            Barriers = maps:get(game_activity_guild_barriers, State, #{}),
            State#{
                game_activity_guild_barriers => Barriers#{Wait => {Worker, Requests, Leaves}}
            }
    end.

-spec finish_guild_barrier(reference(), pid(), ok | {error, atom()}, map()) ->
    {handled, map()}.
finish_guild_barrier(Wait, Worker, Result, State) ->
    Worker ! {game_activity_guild_acks, Wait, Result},
    Barriers = maps:get(game_activity_guild_barriers, State),
    {_Pid, Requests, _Leaves} = maps:get(Wait, Barriers),
    presence_game_activity_policy:abandon_requests(Requests),
    {handled, State#{game_activity_guild_barriers => maps:remove(Wait, Barriers)}}.

-spec forget_barrier(pid(), map()) -> map().
forget_barrier(Worker, State) ->
    Barriers = maps:filter(
        fun(_Wait, {Pid, Requests, _Leaves}) ->
            case Pid =:= Worker of
                true ->
                    presence_game_activity_policy:abandon_requests(Requests),
                    false;
                false ->
                    true
            end
        end,
        maps:get(game_activity_guild_barriers, State, #{})
    ),
    State#{game_activity_guild_barriers => Barriers}.
