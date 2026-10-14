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
    receiver_down/2
]).

-define(LEASE_MS, 120000).

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
        false -> update_input(Input, maps:get(session_id, Request), State)
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
            select_after_clear(maps:get(owner, Old, undefined) =:= SessionId, New, State)
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
disconnect(SessionId, State) -> clear(SessionId, State).

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
            NewState = store_game(New, State),
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
    Reply =
        case
            presence_game_activity_policy:revoke(
                Targets, State, erlang:monotonic_time(millisecond) + 4500
            )
        of
            {ok, Count} ->
                refresh_after_apply(Targets, Ack, State),
                {ok, ack_count(Ack, Count)};
            Error ->
                Error
        end,
    ReplyTo ! {game_activity_barrier_done, self(), Reply}.

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
    Next.
