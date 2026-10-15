%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(session_game_activity).
-typing([eqwalizer]).

-export([
    expect/3,
    grant/3,
    fence/3,
    deliver/4,
    wire/3,
    replay/2,
    subscribe/1,
    sync_friends/1,
    subscribed/2,
    rollout_payload/0,
    rollout/1,
    cleanup/2,
    prepare/3,
    down/2,
    refresh/2,
    sync_blocked/2
]).

-spec expect(integer(), map(), map()) -> {reply, term(), map()}.
expect(OwnerId, Context, State) ->
    case
        not maps:is_key(game_activity_resuming, State) andalso
            gateway_rollout_config:game_activity_allowed()
    of
        false ->
            {reply, {error, rollout_closed}, State};
        true ->
            expect_owner(
                owner_pid_alive(maps:get(owner_pid, Context, undefined)),
                OwnerId,
                Context,
                State
            )
    end.

-spec expect_owner(boolean(), integer(), map(), map()) -> {reply, term(), map()}.
expect_owner(false, _OwnerId, _Context, State) ->
    {reply, {error, unavailable_owner}, State};
expect_owner(true, OwnerId, Context, State) ->
    Expected = maps:get(game_activity_expected, State, #{}),
    Barriers = maps:get(game_activity_barriers, State, #{}),
    case fenced_context(maps:get(OwnerId, Barriers, #{}), Context) of
        true ->
            {reply, {error, fenced}, State};
        false ->
            Bound = bind_owner(OwnerId, Context, State),
            {reply, ok, Bound#{game_activity_expected => Expected#{OwnerId => Context}}}
    end.

-spec grant(integer(), map(), map()) -> {reply, term(), map()}.
grant(_OwnerId, _Stamp, #{game_activity_cleaning := true} = State) ->
    {reply, {error, rollout_closed}, State};
grant(OwnerId, #{allowed := true} = Stamp, State) ->
    Expected = maps:get(game_activity_expected, State, #{}),
    case maps:find(OwnerId, Expected) of
        {ok, Context} ->
            Valid =
                matches_context(Context, Stamp) andalso owner_live(OwnerId, Stamp, State) andalso
                    rollout_allows(Stamp),
            install_grant(Valid, OwnerId, Stamp, State);
        error ->
            {reply, {error, unknown_owner}, State}
    end;
grant(_OwnerId, _Stamp, State) ->
    {reply, {error, denied}, State}.

-spec install_grant(boolean(), integer(), map(), map()) -> {reply, term(), map()}.
install_grant(false, _OwnerId, _Stamp, State) ->
    {reply, {error, stale_grant}, State};
install_grant(true, OwnerId, Stamp, State) ->
    Grants = maps:get(game_activity_grants, State, #{}),
    Revisions = maps:get(game_activity_revisions, State, #{}),
    Expected = maps:get(game_activity_expected, State, #{}),
    Generation = gateway_rollout_config:game_activity_generation(),
    {reply, {ok, Stamp}, State#{
        game_activity_rollout_gate => session_game_activity_rollout:grant_gate(State),
        game_activity_grants => Grants#{
            OwnerId => Stamp#{local_rollout_generation => Generation}
        },
        game_activity_expected => maps:remove(OwnerId, Expected),
        game_activity_revisions => Revisions#{OwnerId => maps:get(activity_revision, Stamp, 0)}
    }}.

-spec matches_context(map(), map()) -> boolean().
matches_context(Context, Stamp) ->
    lists:all(
        fun(Key) ->
            maps:is_key(Key, Context) andalso
                maps:get(Key, Context) =:= maps:get(Key, Stamp, undefined)
        end,
        [owner_epoch, owner_pid, policy_revision, pair_generation, request_nonce]
    ).

-spec fenced_context(map(), map()) -> boolean().
fenced_context(Barrier, Context) ->
    maps:get(owner_epoch, Barrier, undefined) =:= maps:get(owner_epoch, Context, undefined) andalso
        (maps:is_key(
            maps:get(request_nonce, Context, undefined), maps:get(revoked_nonces, Barrier, #{})
        ) orelse
            revision(maps:get(policy_revision, Context, undefined)) <
                revision(maps:get(policy_revision, Barrier, undefined)) orelse
            maps:get(pair_generation, Context, -1) < maps:get(pair_generation, Barrier, 0)).

-spec revision(term()) -> integer().
revision(N) when is_integer(N) -> N;
revision(B) when is_binary(B) ->
    try
        binary_to_integer(B)
    catch
        error:badarg -> -1
    end;
revision(_) ->
    -1.

-spec fence(integer(), map(), map()) -> {reply, term(), map()}.
fence(OwnerId, Stamp, State) ->
    Current = current_context(OwnerId, State),
    Barrier = maps:get(OwnerId, maps:get(game_activity_barriers, State, #{}), #{}),
    Duplicate = maps:remove(revoked_nonces, Barrier) =:= Stamp,
    case Duplicate orelse stale_fence(Stamp, Current) of
        true -> {reply, {ok, Stamp}, State};
        false -> apply_fence(OwnerId, Stamp, State)
    end.

-spec current_context(integer(), map()) -> map().
current_context(OwnerId, State) ->
    Owners = maps:get(game_activity_owners, State, #{}),
    Expected = maps:get(game_activity_expected, State, #{}),
    Grants = maps:get(game_activity_grants, State, #{}),
    maps:get(OwnerId, Grants, maps:get(OwnerId, Expected, maps:get(OwnerId, Owners, #{}))).

-spec stale_fence(map(), map()) -> boolean().
stale_fence(_Stamp, Current) when map_size(Current) =:= 0 -> false;
stale_fence(Stamp, Current) ->
    DifferentOwner =
        maps:get(owner_epoch, Stamp, undefined) =/= maps:get(owner_epoch, Current, undefined),
    OlderPolicy =
        revision(maps:get(policy_revision, Stamp, undefined)) <
            revision(maps:get(policy_revision, Current, undefined)),
    OlderPair = maps:get(pair_generation, Stamp, -1) < maps:get(pair_generation, Current, 0),
    DifferentOwner orelse OlderPolicy orelse OlderPair orelse
        stale_revoked_context(Stamp, Current).

-spec stale_revoked_context(map(), map()) -> boolean().
stale_revoked_context(#{revoked_context := Revoked}, Current) ->
    not matches_context(Revoked, Current);
stale_revoked_context(_Stamp, _Current) ->
    false.

-spec apply_fence(integer(), map(), map()) -> {reply, term(), map()}.
apply_fence(OwnerId, Stamp, State) ->
    Barriers = maps:get(game_activity_barriers, State, #{}),
    Grants = maps:get(game_activity_grants, State, #{}),
    Expectations = maps:get(game_activity_expected, State, #{}),
    Grant = revoked_part(Stamp, maps:get(OwnerId, Grants, #{})),
    Expected = revoked_part(Stamp, maps:get(OwnerId, Expectations, #{})),
    Nonces = maps:from_list([
        {maps:get(request_nonce, S, undefined), true}
     || S <- [Grant, Expected], maps:is_key(request_nonce, S)
    ]),
    Closed = State#{
        game_activity_barriers => Barriers#{OwnerId => Stamp#{revoked_nonces => Nonces}},
        game_activity_grants => remove_revoked(OwnerId, Grant, Grants),
        game_activity_expected => remove_revoked(OwnerId, Expected, Expectations)
    },
    Entry = #{event => presence_update, data => activity_payload(OwnerId, null, Stamp)},
    %% The output queue is updated before the owner receives the barrier acknowledgement.
    Queued = session_dispatch_presence:dispatch_presence_now(Entry, Closed),
    {reply, {ok, Stamp}, Queued}.

-spec revoked_part(map(), map()) -> map().
revoked_part(#{revoked_context := Revoked}, Context) ->
    case matches_context(Revoked, Context) of
        true -> Context;
        false -> #{}
    end;
revoked_part(_Stamp, Context) ->
    Context.

-spec remove_revoked(integer(), map(), map()) -> map().
remove_revoked(_OwnerId, Context, Values) when map_size(Context) =:= 0 -> Values;
remove_revoked(OwnerId, _Context, Values) -> maps:remove(OwnerId, Values).

-spec deliver(integer(), map() | null, map(), map()) -> {noreply, map()}.
deliver(OwnerId, Activity, Stamp, State) ->
    session_dispatch:handle_dispatch(
        presence_update, activity_payload(OwnerId, Activity, Stamp), State
    ).

-spec activity_payload(integer(), map() | null, map()) -> map().
activity_payload(OwnerId, Activity, Stamp) ->
    #{
        <<"user">> => #{<<"id">> => integer_to_binary(OwnerId)},
        <<"game_activity">> => Activity,
        game_activity_stamp => Stamp
    }.

-spec wire(atom() | binary(), term(), map()) -> term().
wire(Event, {pre_encoded, Binary}, State) when
    Event =:= presence_update orelse
        Event =:= <<"PRESENCE_UPDATE">> orelse
        Event =:= ready orelse
        Event =:= <<"READY">>
->
    %% Game projections are normally maps; old encoded replay entries also fail closed.
    wire(Event, json:decode(Binary), State);
wire(Event, Data, State) when
    is_map(Data) andalso
        (Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">>)
->
    Clean = maps:remove(game_activity_stamp, Data),
    case maps:is_key(<<"game_activity">>, Data) andalso not allowed(Data, State) of
        false ->
            Clean;
        true ->
            Clean#{<<"game_activity">> => null}
    end;
wire(Event, Data, State) when
    is_map(Data) andalso (Event =:= ready orelse Event =:= <<"READY">>)
->
    Ready = Data#{<<"gateway_rollout">> => rollout_payload()},
    case maps:find(<<"presences">>, Data) of
        {ok, Presences} when is_list(Presences) ->
            Ready#{<<"presences">> => [wire(presence_update, P, State) || P <- Presences]};
        _ ->
            Ready
    end;
wire(Event, _Data, _State) when
    Event =:= gateway_rollout_update orelse Event =:= <<"GATEWAY_ROLLOUT_UPDATE">>
->
    rollout_payload();
wire(_Event, Data, _State) ->
    Data.

-spec rollout_payload() -> map().
rollout_payload() ->
    session_game_activity_rollout:payload().

-spec allowed(map(), map()) -> boolean().
allowed(#{<<"guild_id">> := GuildId} = Data, State) ->
    guild_allowed(snowflake_id:parse_maybe(GuildId), Data, State);
allowed(Data, State) ->
    OwnerId = session_dispatch_presence:presence_user_id(Data),
    Grants = maps:get(game_activity_grants, State, #{}),
    case {maps:find(OwnerId, Grants), maps:find(game_activity_stamp, Data)} of
        {{ok, #{allowed := true} = Grant}, {ok, Stamp}} when is_map(Stamp) ->
            maps:get(OwnerId, maps:get(relationships, State, #{}), undefined) =:= 1 andalso
                OwnerId =/= maps:get(user_id, State, undefined) andalso
                human_receiver(State) andalso
                owner_live(OwnerId, Grant, State) andalso
                not maps:is_key(<<"guild_id">>, Data) andalso
                same_generation(Grant, Stamp) andalso rollout_allows(Stamp) andalso
                maps:get(activity_revision, Stamp, -1) >=
                    maps:get(OwnerId, maps:get(game_activity_revisions, State, #{}), 0) andalso
                maps:get(local_rollout_generation, Grant, undefined) =:=
                    gateway_rollout_config:game_activity_generation();
        _ ->
            false
    end.

-spec guild_allowed(term(), map(), map()) -> boolean().
guild_allowed(GuildId, #{game_activity_stamp := #{scope := guild} = Stamp} = Data, State) when
    is_integer(GuildId)
->
    OwnerId = session_dispatch_presence:presence_user_id(Data),
    is_integer(OwnerId) andalso is_map_key(GuildId, maps:get(guilds, State, #{})) andalso
        OwnerId =/= maps:get(user_id, State, undefined) andalso human_receiver(State) andalso
        maps:get(OwnerId, maps:get(relationships, State, #{}), undefined) =/= 2 andalso
        rollout_allows(Stamp) andalso not older_guild_revision(OwnerId, Stamp, State);
guild_allowed(_GuildId, _Data, _State) ->
    false.

-spec older_guild_revision(integer(), map(), map()) -> boolean().
older_guild_revision(OwnerId, Stamp, State) ->
    case maps:get(activity_revision, Stamp, undefined) of
        Revision when is_integer(Revision) ->
            revision_epoch(OwnerId, State) =:= maps:get(owner_epoch, Stamp, undefined) andalso
                Revision < maps:get(OwnerId, maps:get(game_activity_revisions, State, #{}), 0);
        _ ->
            true
    end.

-spec revision_epoch(integer(), map()) -> term().
revision_epoch(OwnerId, State) ->
    case maps:find(OwnerId, maps:get(game_activity_grants, State, #{})) of
        {ok, #{owner_epoch := Epoch}} -> Epoch;
        _ -> maps:get(OwnerId, maps:get(game_activity_revision_epochs, State, #{}), undefined)
    end.

-spec prepare(atom() | binary(), term(), map()) -> {boolean(), map()}.
prepare(Event, #{game_activity_stamp := #{scope := guild} = Stamp} = Data, State) when
    Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">>
->
    case session_dispatch_presence:presence_user_id(Data) of
        OwnerId when is_integer(OwnerId) ->
            Activity = maps:get(<<"game_activity">>, Data, null),
            {true, guild_revision(OwnerId, Activity, Stamp, State)};
        _ ->
            {true, State}
    end;
prepare(Event, #{game_activity_stamp := Stamp} = Data, State) when
    is_map(Stamp) andalso
        (Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">>)
->
    OwnerId = session_dispatch_presence:presence_user_id(Data),
    Grants = maps:get(game_activity_grants, State, #{}),
    Revision = maps:get(activity_revision, Stamp, -1),
    case maps:find(OwnerId, Grants) of
        {ok, Grant} when is_integer(Revision) andalso Revision >= 0 ->
            advance_revision(same_generation(Grant, Stamp), OwnerId, Revision, State);
        _ ->
            {true, State}
    end;
prepare(Event, Data, State) ->
    {true, presence_transition(Event, Data, State)}.

-spec guild_revision(integer(), term(), map(), map()) -> map().
guild_revision(OwnerId, Activity, Stamp, State) ->
    Granted = is_map_key(OwnerId, maps:get(game_activity_grants, State, #{})),
    case {Activity, Granted, maps:get(activity_revision, Stamp, undefined)} of
        {null, false, _} ->
            %% Without a friend grant the entry only serves guild scopes, and a null ends them.
            forget_revision(OwnerId, State);
        {_, _, Revision} when is_integer(Revision) ->
            record_guild_revision(OwnerId, Revision, Granted, Stamp, State);
        _ ->
            State
    end.

-spec record_guild_revision(integer(), integer(), boolean(), map(), map()) -> map().
record_guild_revision(OwnerId, Revision, Granted, Stamp, State) ->
    Epoch = maps:get(owner_epoch, Stamp, undefined),
    Revisions = maps:get(game_activity_revisions, State, #{}),
    Stored = maps:get(OwnerId, Revisions, 0),
    case {revision_epoch(OwnerId, State) =:= Epoch, Granted} of
        {true, _} when Revision < Stored ->
            State;
        {true, _} ->
            State#{game_activity_revisions => Revisions#{OwnerId => Revision}};
        {false, true} ->
            State;
        {false, false} ->
            Epochs = maps:get(game_activity_revision_epochs, State, #{}),
            State#{
                game_activity_revisions => Revisions#{OwnerId => Revision},
                game_activity_revision_epochs => Epochs#{OwnerId => Epoch}
            }
    end.

-spec forget_revision(integer(), map()) -> map().
forget_revision(OwnerId, State) ->
    Revisions = maps:get(game_activity_revisions, State, #{}),
    Epochs = maps:get(game_activity_revision_epochs, State, #{}),
    State#{
        game_activity_revisions => maps:remove(OwnerId, Revisions),
        game_activity_revision_epochs => maps:remove(OwnerId, Epochs)
    }.

-spec sync_blocked(pid(), map()) -> ok.
sync_blocked(PresencePid, State) ->
    Blocked = [Id || {Id, 2} <- maps:to_list(maps:get(relationships, State, #{}))],
    gen_server:cast(PresencePid, {game_activity_blocked, Blocked}).

-spec presence_transition(atom() | binary(), term(), map()) -> map().
presence_transition(Event, #{<<"status">> := Status} = Data, State) when
    Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">>
->
    OwnerId = session_dispatch_presence:presence_user_id(Data),
    Friend = maps:get(OwnerId, maps:get(relationships, State, #{}), undefined),
    track_availability(
        gateway_rollout_config:game_activity_allowed() andalso
            not maps:is_key(<<"guild_id">>, Data) andalso Friend =:= 1,
        OwnerId,
        visible_status(Status),
        State
    );
presence_transition(_Event, _Data, State) ->
    State.

-spec visible_status(term()) -> boolean().
visible_status(online) -> true;
visible_status(idle) -> true;
visible_status(dnd) -> true;
visible_status(<<"online">>) -> true;
visible_status(<<"idle">>) -> true;
visible_status(<<"dnd">>) -> true;
visible_status(_) -> false.

-spec track_availability(boolean(), integer(), boolean(), map()) -> map().
track_availability(false, _OwnerId, _Visible, State) ->
    State;
track_availability(true, OwnerId, Visible, State) ->
    Available = maps:get(game_activity_available, State, #{}),
    WasVisible = maps:get(OwnerId, Available, false),
    Next = State#{game_activity_available => Available#{OwnerId => Visible}},
    case Visible andalso not WasVisible of
        true -> refresh(OwnerId, Next);
        false -> Next
    end.

-spec owner_pid_alive(term()) -> boolean().
owner_pid_alive(Pid) when is_pid(Pid) andalso node(Pid) =:= node() -> is_process_alive(Pid);
owner_pid_alive(Pid) when is_pid(Pid) -> lists:member(node(Pid), nodes());
owner_pid_alive(_) -> false.

-spec owner_live(integer(), map(), map()) -> boolean().
owner_live(OwnerId, Stamp, State) ->
    Owners = maps:get(game_activity_owners, State, #{}),
    case maps:find(OwnerId, Owners) of
        {ok, #{owner_pid := Pid, owner_mref := Ref, owner_epoch := Epoch}} ->
            is_reference(Ref) andalso Pid =:= maps:get(owner_pid, Stamp, undefined) andalso
                Epoch =:= maps:get(owner_epoch, Stamp, undefined) andalso owner_pid_alive(Pid);
        _ ->
            false
    end.

-spec bind_owner(integer(), map(), map()) -> map().
bind_owner(OwnerId, Context, State) ->
    Owners = maps:get(game_activity_owners, State, #{}),
    Old = maps:get(OwnerId, Owners, #{}),
    bind_owner_ref(maps:get(owner_pid, Old, undefined), OwnerId, Context, Old, State).

-spec bind_owner_ref(term(), integer(), map(), map(), map()) -> map().
bind_owner_ref(
    Pid,
    OwnerId,
    #{owner_pid := Pid, owner_epoch := Epoch} = Context,
    #{owner_mref := Ref, owner_epoch := Epoch},
    State
) ->
    Owners = maps:get(game_activity_owners, State, #{}),
    State#{game_activity_owners => Owners#{OwnerId => Context#{owner_mref => Ref}}};
bind_owner_ref(_OldPid, OwnerId, #{owner_pid := Pid} = Context, Old, State) ->
    Closed = close_replaced_owner(OwnerId, Old, State),
    Clean = forget_owner(OwnerId, Old, Closed),
    Ref = monitor(process, Pid),
    Owners = maps:get(game_activity_owners, Clean, #{}),
    Refs = maps:get(game_activity_owner_refs, Clean, #{}),
    Clean#{
        game_activity_owners => Owners#{OwnerId => Context#{owner_mref => Ref}},
        game_activity_owner_refs => Refs#{Ref => OwnerId}
    }.

-spec close_replaced_owner(integer(), map(), map()) -> map().
close_replaced_owner(_OwnerId, Old, State) when map_size(Old) =:= 0 -> State;
close_replaced_owner(OwnerId, Old, State) ->
    {reply, {ok, _}, Closed} = apply_fence(OwnerId, Old, State),
    Closed.

-spec forget_owner(integer(), map(), map()) -> map().
forget_owner(OwnerId, Old, State) ->
    Ref = maps:get(owner_mref, Old, undefined),
    demonitor_owner(Ref),
    State#{
        game_activity_owners => maps:remove(
            OwnerId, maps:get(game_activity_owners, State, #{})
        ),
        game_activity_owner_refs => maps:remove(
            Ref, maps:get(game_activity_owner_refs, State, #{})
        )
    }.

-spec demonitor_owner(term()) -> ok.
demonitor_owner(Ref) when is_reference(Ref) ->
    demonitor(Ref, [flush]),
    ok;
demonitor_owner(_) ->
    ok.

-spec down(reference(), map()) -> {noreply, map()} | unhandled.
down(Ref, State) ->
    Refs = maps:get(game_activity_owner_refs, State, #{}),
    owner_down(maps:find(Ref, Refs), State).

-spec owner_down({ok, integer()} | error, map()) -> {noreply, map()} | unhandled.
owner_down(error, _State) ->
    unhandled;
owner_down({ok, OwnerId}, State) ->
    Owners = maps:get(game_activity_owners, State),
    Context = maps:get(OwnerId, Owners),
    {reply, {ok, _}, Closed} = apply_fence(OwnerId, Context, State),
    {noreply, forget_owner(OwnerId, Context, Closed)}.

-spec advance_revision(boolean(), integer(), integer(), map()) -> {boolean(), map()}.
advance_revision(false, _OwnerId, _Revision, State) ->
    {true, State};
advance_revision(true, OwnerId, Revision, State) ->
    Revisions = maps:get(game_activity_revisions, State, #{}),
    case Revision < maps:get(OwnerId, Revisions, 0) of
        true -> {false, State};
        false -> {true, State#{game_activity_revisions => Revisions#{OwnerId => Revision}}}
    end.

-spec human_receiver(map()) -> boolean().
human_receiver(State) ->
    case maps:get(bot, State, false) of
        false -> true;
        _ -> false
    end.

-spec same_generation(map(), map()) -> boolean().
same_generation(A, B) ->
    lists:all(
        fun(Key) ->
            maps:is_key(Key, A) andalso maps:get(Key, A) =:= maps:get(Key, B, undefined)
        end,
        [owner_epoch, policy_revision, pair_generation, rollout_epoch, request_nonce]
    ).

-spec rollout_allows(map()) -> boolean().
rollout_allows(Stamp) ->
    session_game_activity_rollout:allows(Stamp).

-spec replay([map()], map()) -> [map()].
replay(Entries, State) ->
    {Latest, _Seen} = lists:foldr(fun replay_entry/2, {[], #{}}, Entries),
    session_game_activity_rollout:replay(Latest, State).

-spec replay_entry(map(), {[map()], map()}) -> {[map()], map()}.
replay_entry(#{event := Event, data := {pre_encoded, Binary}} = Entry, Acc) when
    Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">>
->
    replay_entry(Entry#{data => json:decode(Binary)}, Acc);
replay_entry(
    #{event := Event, data := #{<<"guild_id">> := GuildId, <<"game_activity">> := _} = Data} =
        Entry,
    {Entries, Seen}
) when Event =:= presence_update orelse Event =:= <<"PRESENCE_UPDATE">> ->
    case
        {session_dispatch_presence:presence_user_id(Data), snowflake_id:parse_maybe(GuildId)}
    of
        {OwnerId, Guild} when is_integer(OwnerId), is_integer(Guild) ->
            Key = {OwnerId, Guild},
            case maps:is_key(Key, Seen) of
                true ->
                    %% Keep the sequence and ordinary presence fields without replaying old games.
                    Clean = maps:without([<<"game_activity">>, game_activity_stamp], Data),
                    {[Entry#{data => Clean} | Entries], Seen};
                false ->
                    {[Entry | Entries], Seen#{Key => true}}
            end;
        _ ->
            {[Entry | Entries], Seen}
    end;
replay_entry(Entry, {Entries, Seen}) ->
    {[Entry | Entries], Seen}.

-spec subscribe(map()) -> map().
subscribe(State) ->
    subscribe_friends(#{}, State).

-spec sync_friends(map()) -> map().
sync_friends(State) ->
    Known = maps:get(
        game_activity_subscription_friends,
        State,
        maps:get(game_activity_grants, State, #{})
    ),
    subscribe_friends(Known, State).

-spec subscribe_friends(map(), map()) -> map().
subscribe_friends(Known, State) ->
    case gateway_rollout_config:game_activity_allowed() of
        false ->
            State;
        true ->
            Ids = presence_targets:friend_ids_from_state(State),
            queue_subscribe(
                [Id || Id <- Ids, not maps:is_key(Id, Known)], remember_friends(Ids, State)
            )
    end.

-spec remember_friends([integer()], map()) -> map().
remember_friends([], State) when not is_map_key(game_activity_subscription_friends, State) ->
    State;
remember_friends(Ids, State) ->
    State#{game_activity_subscription_friends => maps:from_keys(Ids, true)}.

-spec refresh(integer(), map()) -> map().
refresh(OwnerId, State) -> queue_subscribe([OwnerId], State).

-spec queue_subscribe([integer()], map()) -> map().
queue_subscribe(Ids, State) ->
    case
        human_receiver(State) andalso
            not maps:is_key(game_activity_resuming, State) andalso
            gateway_rollout_config:game_activity_allowed()
    of
        true ->
            Queue = maps:get(game_activity_subscription_targets, State, #{}),
            Friends = maps:get(relationships, State, #{}),
            Targets = maps:from_list([
                {Id, true}
             || Id <- Ids, maps:get(Id, Friends, undefined) =:= 1
            ]),
            start_subscriber(State#{
                game_activity_subscription_targets => maps:merge(Queue, Targets)
            });
        false ->
            State
    end.

-spec start_subscriber(map()) -> map().
start_subscriber(State) ->
    start_subscriber(maps:get(game_activity_subscription_pid, State, undefined), State).

-spec start_subscriber(pid() | undefined, map()) -> map().
start_subscriber(Pid, State) when is_pid(Pid) -> State;
start_subscriber(undefined, State) ->
    Queue = maps:get(game_activity_subscription_targets, State, #{}),
    {Ids, Rest} = take_targets(maps:iterator(Queue), 100, Queue, []),
    launch_subscriber(Ids, State#{game_activity_subscription_targets => Rest}).

-spec take_targets(maps:iterator(), non_neg_integer(), map(), [integer()]) ->
    {[integer()], map()}.
take_targets(_Iterator, 0, Rest, Ids) ->
    {Ids, Rest};
take_targets(Iterator, N, Rest, Ids) ->
    case maps:next(Iterator) of
        none -> {Ids, Rest};
        {Id, _, Next} -> take_targets(Next, N - 1, maps:remove(Id, Rest), [Id | Ids])
    end.

-spec launch_subscriber([integer()], map()) -> map().
launch_subscriber([], State) ->
    State;
launch_subscriber(FriendIds, State) ->
    SessionPid = self(),
    ViewerId = maps:get(user_id, State),
    Worker = spawn(fun() ->
        subscribe_batches(FriendIds, ViewerId, SessionPid),
        SessionPid ! {game_activity_subscribed, self()}
    end),
    State#{game_activity_subscription_pid => Worker}.

-spec subscribed(pid(), map()) -> map().
subscribed(Pid, #{game_activity_subscription_pid := Pid} = State) ->
    Next = maps:remove(game_activity_subscription_pid, State),
    start_subscriber(Next);
subscribed(_Pid, State) ->
    State.

-spec rollout(map()) -> map().
rollout(#{game_activity_cleaning := true} = State) ->
    State;
rollout(State) ->
    cancel_subscriber(maps:get(game_activity_subscription_pid, State, undefined)),
    Grants = maps:get(game_activity_grants, State, #{}),
    Closed = (maps:remove(game_activity_subscription_pid, State))#{
        game_activity_grants => #{},
        game_activity_expected => #{},
        game_activity_available => #{},
        game_activity_subscription_targets => #{},
        game_activity_cleaning => true
    },
    cleanup(maps:iterator(Grants), Closed).

-spec cancel_subscriber(pid() | undefined) -> ok.
cancel_subscriber(Pid) when is_pid(Pid) ->
    exit(Pid, kill),
    ok;
cancel_subscriber(undefined) ->
    ok.

-spec cleanup(maps:iterator(), map()) -> map().
cleanup(Iterator, State) -> cleanup(100, Iterator, State).

-spec cleanup(non_neg_integer(), maps:iterator(), map()) -> map().
cleanup(0, Iterator, State) ->
    self() ! {game_activity_cleanup, Iterator},
    State;
cleanup(N, Iterator, State) ->
    case maps:next(Iterator) of
        none ->
            %% TEMPORARY: opening costs O(sum of session friends), without a cluster budget.
            %% Target the same Fluxer shard/session path with budgeted, coalesced, staggered
            %% resubscription and close/revoke priority. Before broad rollout, accept actual
            %% friend/session load and desktop sends against mailbox/RPC p95/p99, cancellation
            %% latency, and a 30% capacity headroom model.
            subscribe(maps:remove(game_activity_cleaning, State));
        {OwnerId, Stamp, Rest} ->
            {reply, {ok, _}, Next} = fence(OwnerId, Stamp, State),
            cleanup(N - 1, Rest, Next)
    end.

-spec subscribe_batches([integer()], integer(), pid()) -> ok.
subscribe_batches([], _ViewerId, _SessionPid) ->
    ok;
subscribe_batches(Ids, ViewerId, SessionPid) ->
    {Batch, Rest} = take_batch(Ids, 100, []),
    Contexts = lists:filtermap(
        fun(OwnerId) -> owner_context(OwnerId, ViewerId, SessionPid) end, Batch
    ),
    resolve_batch(Contexts, ViewerId, SessionPid),
    subscribe_batches(Rest, ViewerId, SessionPid).

-spec take_batch([integer()], non_neg_integer(), [integer()]) -> {[integer()], [integer()]}.
take_batch(Rest, 0, Acc) -> {lists:reverse(Acc), Rest};
take_batch([], _N, Acc) -> {lists:reverse(Acc), []};
take_batch([Id | Rest], N, Acc) -> take_batch(Rest, N - 1, [Id | Acc]).

-spec owner_context(integer(), integer(), pid()) -> false | {true, tuple()}.
owner_context(OwnerId, ViewerId, SessionPid) ->
    try
        {ok, OwnerPid} = presence_manager:lookup(OwnerId),
        {ok, Context} = gen_server:call(OwnerPid, {game_activity_context, ViewerId}, 2000),
        ok = gen_server:call(SessionPid, {game_activity_expect, OwnerId, Context}, 2000),
        {true, {OwnerId, OwnerPid, Context}}
    catch
        _:_ -> false
    end.

-spec resolve_batch([tuple()], integer(), pid()) -> ok.
resolve_batch([], _ViewerId, _SessionPid) ->
    ok;
resolve_batch(Contexts, ViewerId, SessionPid) ->
    resolve_batch(Contexts, ViewerId, SessionPid, 1).

-spec resolve_batch([tuple()], integer(), pid(), non_neg_integer()) -> ok.
resolve_batch([], _ViewerId, _SessionPid, _Retries) ->
    ok;
resolve_batch(Contexts, ViewerId, SessionPid, Retries) ->
    try
        Nonce = base64:encode(crypto:strong_rand_bytes(24)),
        {ok, Response} = rpc_client:call(#{
            <<"type">> => <<"get_game_activity_grants">>,
            <<"request_nonce">> => Nonce,
            <<"targets">> => [integer_to_binary(Id) || {Id, _, _} <- Contexts],
            <<"viewer_id">> => integer_to_binary(ViewerId)
        }),
        #{<<"request_nonce">> := Nonce, <<"grants">> := Grants} = Response,
        ByOwner = maps:from_list([{maps:get(<<"owner_id">>, G), G} || G <- Grants]),
        Denied = lists:filter(
            fun(Context) ->
                install_resolved(Context, ByOwner, ViewerId, SessionPid) =:= {error, denied}
            end,
            Contexts
        ),
        retry_denied(Denied, ViewerId, SessionPid, Retries)
    catch
        Class:Reason ->
            %% A missing owner or unavailable policy resolver leaves the receiver closed.
            logger:debug("Game activity grant unavailable: ~p", [{Class, failure_kind(Reason)}]),
            ok
    end.

-spec retry_denied([tuple()], integer(), pid(), non_neg_integer()) -> ok.
retry_denied(_Denied, _ViewerId, _SessionPid, 0) ->
    ok;
retry_denied(Denied, ViewerId, SessionPid, Retries) ->
    Fresh = lists:filtermap(
        fun({OwnerId, _OwnerPid, Context}) ->
            changed_context(Context, owner_context(OwnerId, ViewerId, SessionPid))
        end,
        Denied
    ),
    resolve_batch(Fresh, ViewerId, SessionPid, Retries - 1).

-spec changed_context(map(), false | {true, tuple()}) -> false | {true, tuple()}.
changed_context(Context, {true, {_, _, NextContext} = Next}) ->
    case same_generation(Context, NextContext) of
        true -> false;
        false -> {true, Next}
    end;
changed_context(_Context, false) ->
    false.

-spec install_resolved(tuple(), map(), integer(), pid()) -> term().
install_resolved({OwnerId, OwnerPid, Context}, ByOwner, ViewerId, SessionPid) ->
    case maps:find(integer_to_binary(OwnerId), ByOwner) of
        {ok, Grant} ->
            BoundGrant = Grant#{<<"request_nonce">> => maps:get(request_nonce, Context)},
            gen_server:call(
                OwnerPid,
                {game_activity_subscribe, ViewerId, SessionPid, Context, BoundGrant},
                5000
            );
        error ->
            ok
    end.

-spec failure_kind(term()) -> atom().
failure_kind({badmatch, _}) -> invalid_response;
failure_kind({timeout, _}) -> timeout;
failure_kind(_) -> unavailable.
