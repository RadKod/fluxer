%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(presence_game_activity_policy).
-typing([eqwalizer]).
-export([
    new/0,
    context/2,
    bootstrap/3,
    control/2,
    pair_control/2,
    permitted/1,
    permitted_everyone/1,
    excluded/1,
    grant_allowed/5,
    stamp/2,
    value/3,
    revoke/3,
    abandon_requests/1,
    refresh/2,
    ack/3,
    interest_allowed/5,
    request_key/1,
    pending_count/1,
    track_receiver/3,
    untrack_receiver/3
]).

-type revoke_iterator() :: maps:iterator(pid(), map()).

-spec new() -> map().
new() ->
    #{
        owner_epoch => base64:encode(crypto:strong_rand_bytes(24)),
        request_nonce => base64:encode(crypto:strong_rand_bytes(24)),
        policy_revision => <<"0">>,
        policy => unknown,
        pairs => #{},
        pair_sequence => 0,
        grants => #{},
        ledger => #{},
        candidates => #{},
        owner => undefined,
        activity_revision => 0,
        change_sequence => 0,
        tokens => 0,
        budget_at => erlang:monotonic_time(millisecond),
        pending => undefined
    }.

-spec value(atom(), map(), term()) -> term().
value(Key, Map, Default) -> maps:get(Key, Map, maps:get(atom_to_binary(Key), Map, Default)).

-spec context(integer(), map()) -> map().
context(ViewerId, Game) ->
    Pair = maps:get(ViewerId, maps:get(pairs, Game, #{}), #{}),
    GlobalNonce = maps:get(request_nonce, Game),
    Nonce =
        case maps:get(request_nonce, Pair, undefined) of
            undefined -> GlobalNonce;
            PairNonce -> <<GlobalNonce/binary, ":", PairNonce/binary>>
        end,
    (stamp(ViewerId, Game))#{request_nonce => Nonce}.

-spec stamp(term(), map()) -> map().
stamp(ViewerId, Game) ->
    Pair = maps:get(ViewerId, maps:get(pairs, Game, #{}), #{}),
    #{
        owner_epoch => maps:get(owner_epoch, Game),
        policy_revision => maps:get(policy_revision, Game),
        pair_generation => maps:get(generation, Pair, maps:get(pair_sequence, Game, 0)),
        activity_revision => maps:get(activity_revision, Game, 0),
        rollout_epoch => maps:get(rollout_epoch, Game, 0),
        rollout_generation => maps:get(rollout_generation, Game, 0)
    }.

-spec bootstrap(binary() | {session, binary()}, map(), map()) -> map().
bootstrap(Nonce, Policy, Game) ->
    Revision = value(policy_revision, Policy, <<"0">>),
    case
        bootstrap_nonce(Nonce, Game) andalso maps:get(policy, Game) =:= unknown andalso
            not maps:get(fenced, Game, false) andalso revision(Revision) >= 0 andalso
            revision(Revision) >= revision(maps:get(policy_revision, Game))
    of
        true ->
            Game#{policy => Policy, policy_revision => Revision};
        false ->
            Game
    end.

-spec bootstrap_nonce(binary() | {session, binary()}, map()) -> boolean().
bootstrap_nonce({session, Nonce}, _Game) -> valid_request_id(Nonce);
bootstrap_nonce(Nonce, Game) -> Nonce =:= maps:get(request_nonce, Game).

-spec permitted(map()) -> boolean().
permitted(Game) ->
    Policy = maps:get(policy, Game, unknown),
    is_map(Policy) andalso
        lists:member(value(visibility, Policy, off), [<<"friends">>, <<"everyone">>]) andalso
        is_true(value(eligible_16_plus, Policy, false)) andalso
        value(effective_profile_audience, Policy, <<"only_me">>) =/= <<"only_me">> andalso
        is_false(maps:get(fenced, Game, false)).

-spec permitted_everyone(map()) -> boolean().
permitted_everyone(Game) ->
    permitted(Game) andalso
        value(visibility, maps:get(policy, Game), off) =:= <<"everyone">>.

-spec excluded(map()) -> #{integer() => true}.
excluded(Game) ->
    Fenced = maps:fold(
        fun
            (Viewer, #{fenced := true}, Acc) -> Acc#{Viewer => true};
            (_Viewer, _Pair, Acc) -> Acc
        end,
        #{},
        maps:get(pairs, Game, #{})
    ),
    maps:merge(
        maps:merge(maps:get(blocked_sync, Game, #{}), maps:get(blocked_pairs, Game, #{})),
        Fenced
    ).

-spec control(map(), map()) -> {ok, map()} | {error, stale | busy}.
control(Request, Game) ->
    Phase = value(phase, Request, undefined),
    Epoch = value(owner_epoch, Request, undefined),
    Revision = value(policy_revision, Request, undefined),
    Id = value(request_id, Request, undefined),
    Key = request_key(Request),
    Current = maps:get(policy_revision, Game),
    Valid =
        valid_epoch(Epoch, Phase, Game) andalso valid_request_id(Id) andalso
            revision(Revision) >= 0,
    case {Valid, Phase, revision(Revision) >= revision(Current)} of
        {true, <<"fence">>, true} ->
            fence_policy(Key, Revision, Game);
        {true, <<"apply">>, true} ->
            apply_policy(Request, Game, Id, Current, Revision);
        _ ->
            {error, stale}
    end.

-spec fence_policy(term(), binary(), map()) -> {ok, map()} | {error, busy}.
fence_policy(Key, Revision, Game) ->
    Requests = maps:get(policy_requests, Game, #{}),
    Recoverable = maps:get(recoverable_policy_requests, Game, #{}),
    Remaining =
        case is_tuple(Key) of
            %% The persisted revision makes older pinned CAS writers obsolete.
            true -> remaining_policy_requests(Key, Revision, Requests, Recoverable);
            false -> Requests
        end,
    Next = Remaining#{Key => Revision},
    case pending_count(Game) - map_size(Requests) + map_size(Next) > 64 of
        true ->
            {error, busy};
        false ->
            {ok, Game#{
                policy_revision => Revision,
                policy_requests => Next,
                recoverable_policy_requests => (maps:with(maps:keys(Next), Recoverable))#{
                    Key => is_tuple(Key)
                },
                inherited_policy_requests => maps:with(
                    maps:keys(Next), maps:get(inherited_policy_requests, Game, #{})
                ),
                fenced => true,
                request_nonce => base64:encode(crypto:strong_rand_bytes(24)),
                policy => unknown,
                candidates => #{},
                owner => undefined,
                pending => undefined,
                grants => #{},
                activity_revision => maps:get(activity_revision, Game, 0) + 1
            }}
    end.

-spec request_key(map()) -> term().
request_key(Request) ->
    %% Pinned settings writes always advance this revision, including no-op writes.
    case value(recoverable, Request, false) of
        true -> {recoverable, value(policy_revision, Request, undefined)};
        _ -> value(request_id, Request, undefined)
    end.

-spec pending_count(map()) -> non_neg_integer().
pending_count(Game) ->
    maps:fold(
        fun(_, Pair, Count) -> Count + map_size(maps:get(requests, Pair, #{})) end,
        map_size(maps:get(policy_requests, Game, #{})),
        maps:get(pairs, Game, #{})
    ).

-spec pair_control(map(), map()) -> {ok, map()} | {error, stale | busy}.
pair_control(Request, Game) ->
    Viewer = value(viewer_id, Request, undefined),
    Pairs = maps:get(pairs, Game, #{}),
    Pair = maps:get(Viewer, Pairs, #{generation => maps:get(pair_sequence, Game, 0)}),
    Id = value(request_id, Request, undefined),
    Requests = maps:get(requests, Pair, #{}),
    PendingCount = pending_count(Game),
    case {value(phase, Request, undefined), is_binary(Id) andalso byte_size(Id) > 0} of
        {<<"fence">>, true} when map_size(Pairs) >= 1024, not is_map_key(Viewer, Pairs) ->
            {error, busy};
        {<<"fence">>, true} when PendingCount >= 64, not is_map_key(Id, Requests) ->
            {error, busy};
        {<<"fence">>, true} ->
            Generation = max(maps:get(pair_sequence, Game, 0), maps:get(generation, Pair)) + 1,
            Next = Pair#{
                generation => Generation,
                requests => Requests#{Id => Generation},
                fenced => true,
                request_nonce => base64:encode(crypto:strong_rand_bytes(24))
            },
            {ok, Game#{pairs => Pairs#{Viewer => Next}, pair_sequence => Generation}};
        {<<"apply">>, true} ->
            apply_pair(Request, Game, Viewer, Pair, Pairs, Id);
        _ ->
            {error, stale}
    end.

-spec grant_allowed(integer(), map(), map(), map(), map()) -> boolean().
grant_allowed(Viewer, Context, Grant, Game, State) ->
    Expected = context(Viewer, Game),
    Pair = maps:get(Viewer, maps:get(pairs, Game, #{}), #{}),
    permitted(Game) andalso not maps:get(is_bot, State, false) andalso
        Viewer =/= maps:get(user_id, State, undefined) andalso
        maps:is_key(Viewer, maps:get(friends, State, #{})) andalso
        not maps:get(fenced, Pair, false) andalso
        value(owner_id, Grant, undefined) =:= integer_to_binary(maps:get(user_id, State)) andalso
        matching_context(Context, Expected) andalso
        value(policy_revision, Grant, undefined) =:= maps:get(policy_revision, Game) andalso
        value(request_nonce, Grant, undefined) =:= maps:get(request_nonce, Expected) andalso
        evidence_allowed(Grant).

-spec valid_epoch(term(), term(), map()) -> boolean().
valid_epoch(null, <<"fence">>, _Game) -> true;
valid_epoch(Epoch, <<"apply">>, _Game) -> valid_request_id(Epoch);
valid_epoch(Epoch, _Phase, Game) -> Epoch =:= maps:get(owner_epoch, Game).

-spec ack(policy | pair, map(), map()) -> map().
ack(Kind, Request, Game) ->
    Base = #{
        <<"owner_epoch">> => maps:get(owner_epoch, Game),
        <<"phase">> => value(phase, Request, undefined),
        <<"request_id">> => value(request_id, Request, undefined)
    },
    ack_fields(Kind, Request, Game, Base).

-spec ack_fields(policy | pair, map(), map(), map()) -> map().
ack_fields(policy, _Request, Game, Base) ->
    Base#{
        <<"policy_revision">> => maps:get(policy_revision, Game), <<"revoked_sessions">> => 0
    };
ack_fields(pair, Request, Game, Base) ->
    Stamp = stamp(value(viewer_id, Request, undefined), Game),
    Generation = value(
        pair_generation, Request, integer_to_binary(maps:get(pair_generation, Stamp))
    ),
    Base#{<<"pair_generation">> => Generation}.

-spec interest_allowed(integer(), map(), map(), map(), map()) -> boolean().
interest_allowed(Viewer, Context, Grant, Game, State) ->
    Expected = context(Viewer, Game),
    maps:is_key(Viewer, maps:get(friends, State, #{})) andalso
        Viewer =/= maps:get(user_id, State, undefined) andalso
        value(owner_id, Grant, undefined) =:= integer_to_binary(maps:get(user_id, State)) andalso
        value(request_nonce, Grant, undefined) =:= maps:get(request_nonce, Expected) andalso
        matching_context(Context, Expected).

-spec matching_context(map(), map()) -> boolean().
matching_context(Context, Expected) ->
    lists:all(
        fun(K) -> maps:get(K, Context, undefined) =:= maps:get(K, Expected) end,
        [owner_epoch, policy_revision, pair_generation, request_nonce]
    ).

-spec valid_request_id(term()) -> boolean().
valid_request_id(Id) -> is_binary(Id) andalso byte_size(Id) > 0.

-spec remaining_policy_requests(term(), binary(), map(), map()) -> map().
remaining_policy_requests(Id, Revision, Requests, Recoverable) ->
    maps:filter(
        fun(Key, FenceRevision) ->
            Key =/= Id andalso
                not (maps:get(Key, Recoverable, false) andalso
                    revision(FenceRevision) < revision(Revision))
        end,
        Requests
    ).

-spec apply_policy(map(), map(), binary(), binary(), binary()) -> {ok, map()} | {error, stale}.
apply_policy(Request, Game, Id, Current, Revision) ->
    Requests = maps:get(policy_requests, Game, #{}),
    Inherited = maps:get(inherited_policy_requests, Game, #{}),
    Pending =
        maps:is_key(Id, Requests) andalso maps:get(fenced, Game, false) andalso
            request_epoch(value(owner_epoch, Request, undefined), Id, Inherited, Game),
    case
        revision(Revision) > revision(Current) orelse
            (Pending andalso revision(Revision) =:= revision(Current))
    of
        true ->
            Recoverable = maps:get(recoverable_policy_requests, Game, #{}),
            Remaining = remaining_policy_requests(Id, Revision, Requests, Recoverable),
            {ok, Game#{
                policy => Request,
                policy_revision => Revision,
                policy_requests => Remaining,
                inherited_policy_requests => maps:with(maps:keys(Remaining), Inherited),
                recoverable_policy_requests => maps:with(maps:keys(Remaining), Recoverable),
                fenced => map_size(Remaining) > 0,
                request_nonce => base64:encode(crypto:strong_rand_bytes(24)),
                candidates => #{},
                owner => undefined,
                pending => undefined,
                grants => #{},
                activity_revision => maps:get(activity_revision, Game, 0) + 1
            }};
        false ->
            {error, stale}
    end.

-spec apply_pair(map(), map(), term(), map(), map(), binary()) -> {ok, map()} | {error, stale}.
apply_pair(Request, Game, Viewer, Pair, Pairs, Id) ->
    Requests = maps:get(requests, Pair, #{}),
    Inherited = maps:get(inherited_requests, Pair, #{}),
    case
        request_epoch(value(owner_epoch, Request, undefined), Id, Inherited, Game) andalso
            maps:is_key(Id, Requests) andalso
            revision(value(pair_generation, Request, undefined)) =:=
                maps:get(Id, Requests, undefined)
    of
        true ->
            Remaining = maps:remove(Id, Requests),
            Next = Pair#{
                requests => Remaining,
                inherited_requests => maps:remove(Id, Inherited),
                fenced => map_size(Remaining) > 0,
                request_nonce => base64:encode(crypto:strong_rand_bytes(24))
            },
            Blocked = blocked_pairs(value(blocked, Request, undefined), Viewer, Game),
            {ok, store_pair(Viewer, Next, Blocked#{pairs => Pairs})};
        false ->
            {error, stale}
    end.

%% TEMPORARY: viewers who blocked this owner also land here, so the set is not bounded by
%% MAX_RELATIONSHIPS while the owner stays online; their own session gate already rejects
%% the guild scope. Target: the API marks which side blocked and only the owner's own
%% blocks are kept here. Trigger: an owner exclusion set above 1,000 entries.
-spec blocked_pairs(term(), term(), map()) -> map().
blocked_pairs(true, Viewer, Game) ->
    Game#{blocked_pairs => (maps:get(blocked_pairs, Game, #{}))#{Viewer => true}};
blocked_pairs(false, Viewer, Game) ->
    Game#{blocked_pairs => maps:remove(Viewer, maps:get(blocked_pairs, Game, #{}))};
blocked_pairs(_, _Viewer, Game) ->
    Game.

-spec track_receiver(integer(), pid(), map()) -> map().
track_receiver(Viewer, Pid, Game) ->
    Pairs = maps:get(pairs, Game, #{}),
    Pair = maps:get(Viewer, Pairs, #{generation => maps:get(pair_sequence, Game, 0)}),
    Receivers = maps:get(receivers, Pair, #{}),
    Game#{pairs => Pairs#{Viewer => Pair#{receivers => Receivers#{Pid => true}}}}.

-spec untrack_receiver(integer(), pid(), map()) -> map().
untrack_receiver(Viewer, Pid, Game) ->
    Pair = maps:get(Viewer, maps:get(pairs, Game, #{}), #{}),
    store_pair(
        Viewer, Pair#{receivers => maps:remove(Pid, maps:get(receivers, Pair, #{}))}, Game
    ).

-spec store_pair(integer(), map(), map()) -> map().
store_pair(Viewer, Pair, Game) ->
    Pairs = maps:get(pairs, Game, #{}),
    case map_size(maps:get(requests, Pair, #{})) + map_size(maps:get(receivers, Pair, #{})) of
        0 ->
            Game#{
                pairs => maps:remove(Viewer, Pairs),
                pair_sequence => max(
                    maps:get(pair_sequence, Game, 0), maps:get(generation, Pair, 0)
                ) + 1
            };
        _ ->
            Game#{pairs => Pairs#{Viewer => Pair}}
    end.

-spec request_epoch(term(), binary(), map(), map()) -> boolean().
request_epoch(Epoch, Id, Inherited, Game) ->
    valid_request_id(Epoch) andalso
        (Epoch =:= maps:get(owner_epoch, Game) orelse
            Epoch =:= maps:get(Id, Inherited, undefined)).

-spec evidence_allowed(map()) -> boolean().
evidence_allowed(Grant) ->
    is_true(value(allowed, Grant, false)) andalso is_true(value(friend, Grant, false)) andalso
        is_false(value(blocked, Grant, true)) andalso
        is_true(value(eligible_16_plus, Grant, false)) andalso
        value(profile_view, Grant, undefined) =:= <<"full">>.

-spec is_true(term()) -> boolean().
is_true(true) -> true;
is_true(_) -> false.

-spec is_false(term()) -> boolean().
is_false(false) -> true;
is_false(_) -> false.

-spec revision(term()) -> integer().
revision(Bin) when is_binary(Bin) ->
    try
        binary_to_integer(Bin)
    catch
        error:badarg -> -1
    end;
revision(_) ->
    -1.

-spec revoke({term(), maps:iterator(pid(), map())}, map(), integer()) ->
    {ok, non_neg_integer()} | {error, atom()}.
revoke({Viewer, Iterator}, State, Deadline) ->
    Context = #{viewer => Viewer, state => State, deadline => Deadline},
    enqueue_fences(100, Iterator, Context),
    revoke_fill(100, Iterator, gen_server:reqids_new(), Context, {0, false}).

-spec revoke_fill(
    non_neg_integer(),
    maps:iterator(pid(), map()),
    gen_server:request_id_collection(),
    map(),
    tuple()
) -> term().
revoke_fill(0, Iterator, Requests, Context, Result) ->
    revoke_wait(Iterator, false, Requests, Context, Result);
revoke_fill(N, Iterator, Requests, Context, Result) ->
    case maps:next(Iterator) of
        none ->
            revoke_wait(Iterator, true, Requests, Context, Result);
        {Pid, Entry, Rest} ->
            Next = send_revocation(Pid, Entry, Requests, Context),
            revoke_fill(N - 1, Rest, Next, Context, Result)
    end.

-spec send_revocation(pid(), map(), gen_server:request_id_collection(), map()) ->
    gen_server:request_id_collection().
send_revocation(Pid, Entry, Requests, #{viewer := Viewer, state := State}) ->
    case Viewer =:= all orelse maps:get(viewer_id, Entry) =:= Viewer of
        false ->
            Requests;
        true ->
            Game = maps:get(game_activity_state, State),
            Stamp = fence_stamp(Entry, Game),
            gen_server:send_request(
                Pid, {game_activity_fence, maps:get(user_id, State), Stamp}, Stamp, Requests
            )
    end.

-spec revoke_wait(
    revoke_iterator(), boolean(), gen_server:request_id_collection(), map(), tuple()
) ->
    term().
revoke_wait(Iterator, Exhausted, Requests, Context, Result) ->
    Left = max(0, maps:get(deadline, Context) - erlang:monotonic_time(millisecond)),
    case gen_server:wait_response(Requests, min(100, Left), true) of
        timeout -> revoke_continue(Iterator, Exhausted, Requests, Context, Result);
        Response -> revoke_response(Response, Iterator, Exhausted, Context, Result)
    end.

-spec revoke_response(term(), revoke_iterator(), boolean(), map(), tuple()) -> term().
revoke_response(
    {{reply, {ok, Stamp}}, Stamp, Requests}, Iterator, Exhausted, Context, {Count, Failed}
) ->
    revoke_continue(Iterator, Exhausted, Requests, Context, {Count + 1, Failed});
revoke_response({_Response, _Label, Requests}, Iterator, Exhausted, Context, {Count, _}) ->
    revoke_continue(Iterator, Exhausted, Requests, Context, {Count, true});
revoke_response(no_request, _Iterator, true, _Context, {Count, false}) ->
    {ok, Count};
revoke_response(no_request, _Iterator, true, _Context, {_Count, true}) ->
    {error, receiver_timeout};
revoke_response(no_request, Iterator, false, Context, Result) ->
    revoke_continue(Iterator, false, gen_server:reqids_new(), Context, Result).

-spec revoke_continue(
    revoke_iterator(), boolean(), gen_server:request_id_collection(), map(), tuple()
) ->
    term().
revoke_continue(Iterator, Exhausted, Requests, Context, Result) ->
    case erlang:monotonic_time(millisecond) < maps:get(deadline, Context) of
        true ->
            revoke_continue_ready(Iterator, Exhausted, Requests, Context, Result);
        false ->
            abandon_requests(Requests),
            {error, receiver_timeout}
    end.

-spec revoke_continue_ready(
    revoke_iterator(), boolean(), gen_server:request_id_collection(), map(), tuple()
) ->
    term().
revoke_continue_ready(Iterator, true, Requests, Context, Result) ->
    revoke_wait(Iterator, true, Requests, Context, Result);
revoke_continue_ready(Iterator, false, Requests, Context, Result) ->
    revoke_fill(100 - gen_server:reqids_size(Requests), Iterator, Requests, Context, Result).

-spec abandon_requests(gen_server:request_id_collection()) -> ok.
abandon_requests(Requests) ->
    case gen_server:receive_response(Requests, 0, true) of
        {_Response, _Label, Remaining} -> abandon_requests(Remaining);
        _ -> ok
    end.

-spec fence_stamp(map(), map()) -> map().
fence_stamp(Entry, Game) ->
    Revoked = maps:get(stamp, Entry),
    (context(maps:get(viewer_id, Entry), Game))#{
        allowed => false,
        owner_pid => maps:get(owner_pid, Revoked, undefined),
        revoked_context => Revoked
    }.

-spec enqueue_fences(non_neg_integer(), maps:iterator(), map()) -> ok.
enqueue_fences(0, Iterator, Context) ->
    erlang:yield(),
    enqueue_fences(100, Iterator, Context);
enqueue_fences(N, Iterator, Context) ->
    case maps:next(Iterator) of
        none ->
            ok;
        {Pid, Entry, Rest} ->
            enqueue_fence(Pid, Entry, Context),
            enqueue_fences(N - 1, Rest, Context)
    end.

-spec enqueue_fence(pid(), map(), map()) -> ok.
enqueue_fence(Pid, Entry, #{viewer := Viewer, state := State}) ->
    case Viewer =:= all orelse maps:get(viewer_id, Entry) =:= Viewer of
        false ->
            ok;
        true ->
            gen_server:cast(
                Pid,
                {game_activity_fence, maps:get(user_id, State),
                    fence_stamp(Entry, maps:get(game_activity_state, State))}
            )
    end.

-spec refresh({term(), maps:iterator()}, integer()) -> ok.
refresh({Viewer, Iterator}, OwnerId) -> refresh(100, Viewer, Iterator, OwnerId).

-spec refresh(non_neg_integer(), term(), maps:iterator(), integer()) -> ok.
refresh(0, Viewer, Iterator, OwnerId) ->
    erlang:yield(),
    refresh(100, Viewer, Iterator, OwnerId);
refresh(N, Viewer, Iterator, OwnerId) ->
    case maps:next(Iterator) of
        none ->
            ok;
        {Pid, Entry, Rest} ->
            refresh_session(Viewer, Pid, Entry, OwnerId),
            refresh(N - 1, Viewer, Rest, OwnerId)
    end.

-spec refresh_session(term(), pid(), map(), integer()) -> ok.
refresh_session(Viewer, Pid, Entry, OwnerId) ->
    case Viewer =:= all orelse maps:get(viewer_id, Entry) =:= Viewer of
        true -> gen_server:cast(Pid, {game_activity_refresh, OwnerId});
        false -> ok
    end.
