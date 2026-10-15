%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_game_activity).
-typing([eqwalizer]).

%% Guild-side projection of members' "everyone" game activity. The owner's presence actor
%% is the only authority: it publishes the selected game (or null) to the guilds it is a
%% member of, and this module stores one entry per owner and hands it to the sessions of
%% this guild that have an interest in that owner. Nothing here touches the shared
%% presence payload, presence cache, member list or GUILD_CREATE/SYNC/chunk content:
%% every delivery is a per-viewer PRESENCE_UPDATE that the receiving session gates again.

-export([
    handle_cast/2,
    handle_call/3,
    handle_down/2,
    snapshot_fields/3,
    send_snapshot/3,
    unsubscribed/3,
    subscriptions_pruned/2,
    dm_eligibility/4,
    member_removed/2,
    owner_offline/2
]).

-define(KEY, game_activity).

-type guild_state() :: map().
-type user_id() :: integer().
-type session_id() :: binary().
-type user_set() :: #{user_id() => true}.
-type entry() :: #{
    pid := pid(),
    mref := reference(),
    activity := map(),
    stamp := map(),
    excluded := user_set()
}.
-type game() :: #{
    entries := #{user_id() => entry()},
    refs := #{reference() => user_id()},
    dm_index := #{user_id() => #{session_id() => true}}
}.
-type audience() :: all | user_set().

-export_type([guild_state/0, user_id/0, session_id/0]).

-spec handle_cast(term(), guild_state()) -> {noreply, guild_state()}.
handle_cast({game_activity_publish, OwnerId, OwnerPid, Activity, Stamp, Excluded}, State) when
    is_integer(OwnerId), is_pid(OwnerPid), is_map(Stamp), is_map(Excluded)
->
    {noreply, publish(OwnerId, OwnerPid, Activity, Stamp, Excluded, State)};
handle_cast(_Msg, State) ->
    {noreply, State}.

-spec handle_call(term(), gen_server:from(), guild_state()) ->
    {reply, ok, guild_state()} | {noreply, guild_state()}.
handle_call({game_activity_revoke, OwnerId, _OwnerEpoch}, From, State) when
    is_integer(OwnerId)
->
    {noreply, drop(OwnerId, From, State)};
handle_call({game_activity_exclude, OwnerId, ViewerId}, From, State) when
    is_integer(OwnerId), is_integer(ViewerId)
->
    {noreply, exclude(OwnerId, ViewerId, From, State)};
handle_call(_Msg, _From, State) ->
    {reply, ok, State}.

-spec handle_down(reference(), guild_state()) -> {ok, guild_state()} | unknown.
handle_down(Ref, State) ->
    #{entries := Entries, refs := Refs} = Game = game(State),
    case maps:find(Ref, Refs) of
        error ->
            unknown;
        {ok, OwnerId} ->
            {ok, owner_down(Ref, OwnerId, maps:get(OwnerId, Entries, undefined), Game, State)}
    end.

-spec owner_down(reference(), user_id(), entry() | undefined, game(), guild_state()) ->
    guild_state().
owner_down(Ref, OwnerId, #{mref := Ref}, _Game, State) ->
    drop(OwnerId, State);
owner_down(Ref, _OwnerId, _Entry, #{refs := Refs} = Game, State) ->
    put_game(Game#{refs := maps:remove(Ref, Refs)}, State).

%% The two fields the per-session presence snapshot carries when a member subscription is
%% added; null whenever this viewer may not see the owner's game here.
-spec snapshot_fields(user_id(), map(), guild_state()) -> map().
snapshot_fields(OwnerId, Session, State) ->
    case maps:get(OwnerId, entries(State), undefined) of
        #{stamp := Stamp} = Entry ->
            fields(shown(OwnerId, Entry, Session), Stamp);
        undefined ->
            fields(null, #{})
    end.

%% A snapshot carrying a game takes the ordered game channel, so it cannot overtake a null
%% queued for the same session by an earlier unsubscribe.
-spec send_snapshot(pid(), map(), guild_state()) -> guild_state().
send_snapshot(SessionPid, Update, State) ->
    case
        {
            maps:get(<<"game_activity">>, Update, null),
            maps:get(broadcaster_pid, State, undefined)
        }
    of
        {null, undefined} ->
            dispatch_game([SessionPid], Update),
            State;
        _ ->
            send([SessionPid], Update, State)
    end.

-spec unsubscribed(session_id(), [user_id()], guild_state()) -> guild_state().
unsubscribed(SessionId, OwnerIds, State) ->
    Entries = entries(State),
    lists:foldl(
        fun(OwnerId, Acc) -> lost_interest(OwnerId, [SessionId], Entries, Acc) end,
        State,
        OwnerIds
    ).

-spec subscriptions_pruned(guild_subscriptions:subscription_state(), guild_state()) ->
    guild_state().
subscriptions_pruned(OldSubs, State) ->
    NewSubs = member_subscriptions(State),
    Entries = entries(State),
    maps:fold(
        fun(OwnerId, _Entry, Acc) ->
            Removed = [
                SessionId
             || SessionId <- guild_subscriptions:get_subscribed_sessions(OwnerId, OldSubs),
                not guild_subscriptions:is_subscribed(SessionId, OwnerId, NewSubs)
            ],
            lost_interest(OwnerId, Removed, Entries, Acc)
        end,
        State,
        Entries
    ).

%% Keeps the partner -> sessions index of the guild_dm_partners registrations and delivers
%% the entry, or its null, to a session whose DM eligibility for an owner changed.
-spec dm_eligibility(map(), map(), [session_id()], guild_state()) -> guild_state().
dm_eligibility(Previous, Next, Touched, State) ->
    lists:foldl(
        fun(SessionId, Acc) ->
            dm_session(SessionId, eligible(SessionId, Previous), eligible(SessionId, Next), Acc)
        end,
        State,
        Touched
    ).

-spec member_removed(user_id() | undefined, guild_state()) -> guild_state().
member_removed(OwnerId, State) when is_integer(OwnerId) ->
    drop(OwnerId, State);
member_removed(_OwnerId, State) ->
    State.

-spec owner_offline(user_id(), guild_state()) -> guild_state().
owner_offline(OwnerId, State) ->
    drop(OwnerId, State).

-spec publish(user_id(), pid(), term(), map(), map(), guild_state()) -> guild_state().
publish(OwnerId, OwnerPid, Activity, Stamp, Excluded, State) ->
    case guild_permissions_check:find_member_by_user_id(OwnerId, State) of
        undefined -> State;
        _Member -> project(OwnerId, OwnerPid, Activity, Stamp, Excluded, State)
    end.

-spec project(user_id(), pid(), term(), map(), map(), guild_state()) -> guild_state().
project(OwnerId, OwnerPid, Activity, Stamp, Excluded, State) when is_map(Activity) ->
    case session_game_activity_rollout:allows(Stamp) of
        true -> store(OwnerId, OwnerPid, Activity, Stamp, user_set(Excluded), State);
        false -> drop(OwnerId, State)
    end;
project(OwnerId, _OwnerPid, _Activity, _Stamp, _Excluded, State) ->
    drop(OwnerId, State).

-spec store(user_id(), pid(), map(), map(), user_set(), guild_state()) -> guild_state().
store(OwnerId, OwnerPid, Activity, Stamp, Excluded, State) ->
    #{entries := Entries, refs := Refs0} = Game = game(State),
    Previous = maps:get(OwnerId, Entries, undefined),
    {MRef, Refs} = monitor_owner(OwnerId, OwnerPid, Previous, Refs0),
    Entry = #{
        pid => OwnerPid,
        mref => MRef,
        activity => Activity,
        stamp => Stamp,
        excluded => Excluded
    },
    Stored = put_game(Game#{entries := Entries#{OwnerId => Entry}, refs := Refs}, State),
    deliver_change(OwnerId, Previous, Entry, Stored).

-spec monitor_owner(user_id(), pid(), entry() | undefined, #{reference() => user_id()}) ->
    {reference(), #{reference() => user_id()}}.
monitor_owner(_OwnerId, Pid, #{pid := Pid, mref := MRef}, Refs) ->
    {MRef, Refs};
monitor_owner(OwnerId, Pid, Previous, Refs) ->
    Kept =
        case Previous of
            #{mref := OldRef} ->
                true = erlang:demonitor(OldRef, [flush]),
                maps:remove(OldRef, Refs);
            undefined ->
                Refs
        end,
    MRef = erlang:monitor(process, Pid),
    {MRef, Kept#{MRef => OwnerId}}.

-spec deliver_change(user_id(), entry() | undefined, entry(), guild_state()) -> guild_state().
deliver_change(OwnerId, undefined, Entry, State) ->
    send_entry(OwnerId, Entry, all, State);
deliver_change(OwnerId, Previous, Entry, State) ->
    #{activity := OldActivity, stamp := OldStamp, excluded := OldExcluded} = Previous,
    #{activity := Activity, stamp := Stamp, excluded := Excluded} = Entry,
    Nulled = null_users(OwnerId, Entry, maps:without(maps:keys(OldExcluded), Excluded), State),
    case {OldActivity, OldStamp} =:= {Activity, Stamp} of
        false ->
            send_entry(OwnerId, Entry, all, Nulled);
        true ->
            send_entry(OwnerId, Entry, maps:without(maps:keys(Excluded), OldExcluded), Nulled)
    end.

-spec exclude(user_id(), user_id(), gen_server:from(), guild_state()) -> guild_state().
exclude(OwnerId, ViewerId, From, State) ->
    #{entries := Entries} = Game = game(State),
    case maps:find(OwnerId, Entries) of
        {ok, #{excluded := Excluded} = Entry} ->
            Updated = Entry#{excluded := Excluded#{ViewerId => true}},
            Stored = put_game(Game#{entries := Entries#{OwnerId => Updated}}, State),
            null_users(OwnerId, Updated, #{ViewerId => true}, From, Stored);
        error ->
            send([], payload(OwnerId, null, #{}, State), From, State)
    end.

%% Every session that may still hold the entry gets the null before the entry is gone;
%% the recipient set is the unfiltered superset, a null reveals nothing.
-spec drop(user_id(), guild_state()) -> guild_state().
drop(OwnerId, State) ->
    drop(OwnerId, undefined, State).

-spec drop(user_id(), gen_server:from() | undefined, guild_state()) -> guild_state().
drop(OwnerId, From, State) ->
    #{entries := Entries, refs := Refs} = Game = game(State),
    case maps:take(OwnerId, Entries) of
        error ->
            send([], payload(OwnerId, null, #{}, State), From, State);
        {#{mref := MRef, stamp := Stamp}, Rest} ->
            true = erlang:demonitor(MRef, [flush]),
            Pids = [Pid || {_SessionId, #{pid := Pid}} <- held_sessions(OwnerId, State)],
            Dropped = put_game(Game#{entries := Rest, refs := maps:remove(MRef, Refs)}, State),
            send(Pids, payload(OwnerId, null, Stamp, Dropped), From, Dropped)
    end.

-spec lost_interest(user_id(), [session_id()], #{user_id() => entry()}, guild_state()) ->
    guild_state().
lost_interest(_OwnerId, [], _Entries, State) ->
    State;
lost_interest(OwnerId, SessionIds, Entries, State) ->
    case maps:find(OwnerId, Entries) of
        {ok, #{stamp := Stamp}} ->
            Index = maps:get(OwnerId, dm_index(State), #{}),
            Sessions = maps:get(sessions, State, #{}),
            Pids = [
                Pid
             || SessionId <- SessionIds,
                not maps:is_key(SessionId, Index),
                #{pid := Pid} <- [maps:get(SessionId, Sessions, #{})],
                is_pid(Pid)
            ],
            send(Pids, payload(OwnerId, null, Stamp, State), State);
        error ->
            State
    end.

-spec dm_session(session_id(), user_set(), user_set(), guild_state()) -> guild_state().
dm_session(_SessionId, Same, Same, State) ->
    State;
dm_session(SessionId, Previous, Next, State) ->
    Gained = maps:keys(maps:without(maps:keys(Previous), Next)),
    Lost = maps:keys(maps:without(maps:keys(Next), Previous)),
    #{dm_index := Index} = Game = game(State),
    Indexed = put_game(Game#{dm_index := reindex(SessionId, Gained, Lost, Index)}, State),
    Entries = entries(Indexed),
    Subs = member_subscriptions(Indexed),
    WithGains = lists:foldl(
        fun(OwnerId, Acc) -> dm_gained(SessionId, OwnerId, Entries, Acc) end, Indexed, Gained
    ),
    Unsubscribed = [
        OwnerId
     || OwnerId <- Lost, not guild_subscriptions:is_subscribed(SessionId, OwnerId, Subs)
    ],
    lists:foldl(
        fun(OwnerId, Acc) -> lost_interest(OwnerId, [SessionId], Entries, Acc) end,
        WithGains,
        Unsubscribed
    ).

-spec dm_gained(session_id(), user_id(), #{user_id() => entry()}, guild_state()) ->
    guild_state().
dm_gained(SessionId, OwnerId, Entries, State) ->
    case {maps:find(OwnerId, Entries), maps:find(SessionId, maps:get(sessions, State, #{}))} of
        {{ok, #{stamp := Stamp} = Entry}, {ok, #{pid := Pid} = Session}} when is_pid(Pid) ->
            send_activity([Pid], OwnerId, shown(OwnerId, Entry, Session), Stamp, State);
        _ ->
            State
    end.

-spec send_activity([pid()], user_id(), map() | null, map(), guild_state()) -> guild_state().
send_activity(_Pids, _OwnerId, null, _Stamp, State) ->
    State;
send_activity(Pids, OwnerId, Activity, Stamp, State) ->
    send(Pids, payload(OwnerId, Activity, Stamp, State), State).

-spec reindex(session_id(), [user_id()], [user_id()], map()) -> map().
reindex(SessionId, Gained, Lost, Index) ->
    WithGains = lists:foldl(
        fun(OwnerId, Acc) ->
            Acc#{OwnerId => (maps:get(OwnerId, Acc, #{}))#{SessionId => true}}
        end,
        Index,
        Gained
    ),
    lists:foldl(fun(OwnerId, Acc) -> unindex(OwnerId, SessionId, Acc) end, WithGains, Lost).

-spec unindex(user_id(), session_id(), map()) -> map().
unindex(OwnerId, SessionId, Index) ->
    case maps:remove(SessionId, maps:get(OwnerId, Index, #{})) of
        Remaining when map_size(Remaining) =:= 0 -> maps:remove(OwnerId, Index);
        Remaining -> Index#{OwnerId => Remaining}
    end.

-spec send_entry(user_id(), entry(), audience(), guild_state()) -> guild_state().
send_entry(_OwnerId, _Entry, Audience, State) when is_map(Audience), map_size(Audience) =:= 0 ->
    State;
send_entry(OwnerId, #{activity := Activity, stamp := Stamp} = Entry, Audience, State) ->
    case session_game_activity_rollout:allows(Stamp) of
        true ->
            Pids = entry_pids(OwnerId, Entry, Audience, State),
            send(Pids, payload(OwnerId, Activity, Stamp, State), State);
        false ->
            State
    end.

-spec entry_pids(user_id(), entry(), audience(), guild_state()) -> [pid()].
entry_pids(OwnerId, #{excluded := Excluded}, Audience, State) ->
    [
        Pid
     || {_SessionId, #{pid := Pid, user_id := UserId} = Session} <- interested_sessions(
            OwnerId, State
        ),
        Audience =:= all orelse maps:is_key(UserId, Audience),
        viewer_allowed(OwnerId, Excluded, Session)
    ].

-spec null_users(user_id(), entry(), user_set(), guild_state()) -> guild_state().
null_users(_OwnerId, _Entry, Users, State) when map_size(Users) =:= 0 ->
    State;
null_users(OwnerId, Entry, Users, State) ->
    null_users(OwnerId, Entry, Users, undefined, State).

-spec null_users(user_id(), entry(), user_set(), gen_server:from() | undefined, guild_state()) ->
    guild_state().
null_users(OwnerId, #{stamp := Stamp}, Users, From, State) ->
    Pids = [
        Pid
     || {_SessionId, #{pid := Pid, user_id := UserId}} <- held_sessions(OwnerId, State),
        maps:is_key(UserId, Users)
    ],
    send(Pids, payload(OwnerId, null, Stamp, State), From, State).

-spec shown(user_id(), entry(), map()) -> map() | null.
shown(OwnerId, #{activity := Activity} = Entry, Session) ->
    case visible_to(OwnerId, Entry, Session) of
        true -> Activity;
        false -> null
    end.

-spec visible_to(user_id(), entry(), map()) -> boolean().
visible_to(OwnerId, #{stamp := Stamp, excluded := Excluded}, Session) ->
    session_game_activity_rollout:allows(Stamp) andalso
        viewer_allowed(OwnerId, Excluded, Session).

-spec viewer_allowed(user_id(), user_set(), map()) -> boolean().
viewer_allowed(OwnerId, Excluded, Session) ->
    UserId = maps:get(user_id, Session, undefined),
    is_integer(UserId) andalso UserId =/= OwnerId andalso
        not maps:is_key(UserId, Excluded) andalso not is_bot(Session).

-spec is_bot(map()) -> boolean().
is_bot(#{bot := true}) -> true;
is_bot(_Session) -> false.

%% TEMPORARY: visible member rows reach this guild through Fluxer's open member
%% subscription, so each such viewer also receives the member's ordinary presence.
%% Target: a game-only interest index (a game_members subscription variant that sends no
%% presence) or interest derived from member list ranges with a block-aware variant of
%% the single encode. Trigger: update_member_subscriptions above p99 200/s for one guild,
%% or subscription-driven presence above 30% of all presence deliveries.
-spec interested_sessions(user_id(), guild_state()) -> [{session_id(), map()}].
interested_sessions(OwnerId, State) ->
    Sessions = maps:get(sessions, State, #{}),
    Subscribed = guild_subscriptions:get_subscribed_sessions(
        OwnerId, member_subscriptions(State)
    ),
    Shared =
        case Subscribed of
            [] ->
                [];
            _ ->
                OwnerChannels = maps:from_keys(
                    guild_visibility_channels:get_user_viewable_channels(OwnerId, State), true
                ),
                {Valid, _Invalid} = guild_presence_sync:partition_subscribed_sessions(
                    Subscribed, Sessions, OwnerChannels, OwnerId, State
                ),
                Valid
        end,
    live_sessions(OwnerId, Shared ++ dm_sessions(OwnerId, State), Sessions).

-spec held_sessions(user_id(), guild_state()) -> [{session_id(), map()}].
held_sessions(OwnerId, State) ->
    Subscribed = guild_subscriptions:get_subscribed_sessions(
        OwnerId, member_subscriptions(State)
    ),
    live_sessions(
        OwnerId, Subscribed ++ dm_sessions(OwnerId, State), maps:get(sessions, State, #{})
    ).

-spec live_sessions(user_id(), [session_id()], map()) -> [{session_id(), map()}].
live_sessions(OwnerId, SessionIds, Sessions) ->
    [
        {SessionId, Session}
     || SessionId <- lists:usort(SessionIds),
        #{pid := Pid, user_id := UserId} = Session <- [maps:get(SessionId, Sessions, #{})],
        is_pid(Pid),
        UserId =/= OwnerId
    ].

-spec dm_sessions(user_id(), guild_state()) -> [session_id()].
dm_sessions(OwnerId, State) ->
    maps:keys(maps:get(OwnerId, dm_index(State), #{})).

%% The broadcaster sends game updates in order; only nulls and revocation barriers
%% bypass its queue limit, since shedding either would leave a revoked game visible.
-spec send([pid()], map(), guild_state()) -> guild_state().
send(Pids, Payload, State) ->
    send(Pids, Payload, undefined, State).

-spec send([pid()], map(), gen_server:from() | undefined, guild_state()) -> guild_state().
send([], _Payload, undefined, State) ->
    State;
send(Pids, Payload, undefined, State) ->
    case guild_broadcaster:ensure(State) of
        {BroadcasterPid, Ensured} when is_pid(BroadcasterPid) ->
            ok = enqueue(BroadcasterPid, Payload, Pids),
            Ensured;
        {undefined, Ensured} ->
            dispatch_game(Pids, Payload),
            Ensured
    end;
send(Pids, Payload, From, State) ->
    case maps:get(broadcaster_pid, State, undefined) of
        Pid when is_pid(Pid) ->
            case process_liveness:is_alive(Pid) of
                true ->
                    gen_server:cast(Pid, {game_activity_broadcast, Payload, Pids, From});
                false ->
                    dispatch_game(Pids, Payload),
                    gen_server:reply(From, ok)
            end;
        _ ->
            dispatch_game(Pids, Payload),
            gen_server:reply(From, ok)
    end,
    State.

-spec dispatch_game([pid()], map()) -> ok.
dispatch_game(Pids, Payload) ->
    lists:foreach(
        fun(Pid) -> gen_server:cast(Pid, {dispatch, presence_update, Payload}) end, Pids
    ).

-spec enqueue(pid(), map(), [pid()]) -> ok.
enqueue(BroadcasterPid, Payload, Pids) ->
    case guild_broadcaster:cast_event(BroadcasterPid, presence_update, Payload, Pids) of
        true ->
            ok;
        false ->
            case maps:get(<<"game_activity">>, Payload, null) of
                null ->
                    gen_server:cast(
                        BroadcasterPid, {event_broadcast, presence_update, Payload, Pids}
                    );
                _ ->
                    ok
            end
    end.

-spec payload(user_id(), map() | null, map(), guild_state()) -> map().
payload(OwnerId, Activity, Stamp, State) ->
    (fields(Activity, Stamp))#{
        <<"user">> => #{<<"id">> => integer_to_binary(OwnerId)},
        <<"guild_id">> => integer_to_binary(maps:get(id, State))
    }.

-spec fields(map() | null, map()) -> map().
fields(Activity, Stamp) ->
    #{<<"game_activity">> => Activity, game_activity_stamp => Stamp#{scope => guild}}.

-spec eligible(session_id(), map()) -> user_set().
eligible(SessionId, Registrations) ->
    case maps:get(SessionId, Registrations, undefined) of
        #{eligible := Eligible} when is_map(Eligible) -> Eligible;
        _ -> #{}
    end.

-spec user_set(map()) -> user_set().
user_set(Ids) ->
    maps:from_keys([Id || Id <- maps:keys(Ids), is_integer(Id)], true).

-spec member_subscriptions(guild_state()) -> guild_subscriptions:subscription_state().
member_subscriptions(State) ->
    maps:get(member_subscriptions, State, guild_subscriptions:init_state()).

-spec entries(guild_state()) -> #{user_id() => entry()}.
entries(State) ->
    maps:get(entries, game(State)).

-spec dm_index(guild_state()) -> #{user_id() => #{session_id() => true}}.
dm_index(State) ->
    maps:get(dm_index, game(State)).

-spec game(guild_state()) -> game().
game(State) ->
    case maps:get(?KEY, State, undefined) of
        #{entries := _, refs := _, dm_index := _} = Game -> Game;
        _ -> #{entries => #{}, refs => #{}, dm_index => #{}}
    end.

-spec put_game(game(), guild_state()) -> guild_state().
put_game(Game, State) ->
    State#{?KEY => Game}.
