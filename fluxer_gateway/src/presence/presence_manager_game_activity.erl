%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(presence_manager_game_activity).
-typing([eqwalizer]).

-export([
    prepare_fence/5,
    pending_control/3,
    pending_key/2,
    pending_id/2,
    pending_ids/3,
    remove_rejected_request/4,
    record_pending_ack/4,
    store_pending/4
]).

-spec prepare_fence(integer(), policy | pair, map(), map(), map()) ->
    {ok, map()} | {error, stale | busy}.
prepare_fence(UserId, Kind, Request, Game, State) ->
    admit_fence(UserId, Game, State, pending_control(Kind, Request, Game)).

-spec admit_fence(integer(), map(), map(), {ok, map()} | {error, stale | busy}) ->
    {ok, map()} | {error, stale | busy}.
admit_fence(UserId, Game, State, {ok, Next}) ->
    Pending = maps:get(game_activity_pending, State, #{}),
    Count =
        maps:get(game_activity_pending_count, State, 0) +
            presence_game_activity_policy:pending_count(Next) -
            presence_game_activity_policy:pending_count(Game),
    case
        Count > 10000 orelse
            (map_size(Pending) >= 10000 andalso not is_map_key(UserId, Pending))
    of
        true -> {error, busy};
        false -> {ok, Next}
    end;
admit_fence(_UserId, _Game, _State, Error) ->
    Error.

-spec remove_rejected_request(policy | pair, map(), map(), map()) -> map().
remove_rejected_request(policy, Request, Remaining, Game) ->
    case presence_game_activity_policy:value(recoverable, Request, false) of
        %% A rejected retry must not erase the aggregate protecting an older writer.
        true ->
            Game;
        _ ->
            Game#{
                policy_requests => Remaining,
                fenced => map_size(Remaining) > 0,
                recoverable_policy_requests => maps:with(
                    maps:keys(Remaining),
                    maps:get(recoverable_policy_requests, Game, #{})
                ),
                inherited_policy_requests => maps:with(
                    maps:keys(Remaining),
                    maps:get(inherited_policy_requests, Game, #{})
                )
            }
    end;
remove_rejected_request(pair, Request, Remaining, Game) ->
    Viewer = presence_game_activity_policy:value(viewer_id, Request, undefined),
    Pairs = maps:get(pairs, Game),
    Pair = maps:get(Viewer, Pairs),
    Game#{
        pairs => Pairs#{
            Viewer => Pair#{requests => Remaining, fenced => map_size(Remaining) > 0}
        }
    }.

-spec pending_key(policy | pair, map()) -> tuple().
pending_key(Kind, Request) ->
    {Kind, presence_game_activity_policy:value(viewer_id, Request, undefined),
        pending_id(Kind, Request)}.

-spec pending_id(policy | pair, map()) -> term().
pending_id(policy, Request) ->
    presence_game_activity_policy:request_key(Request);
pending_id(pair, Request) ->
    presence_game_activity_policy:value(request_id, Request, undefined).

-spec pending_ids(policy | pair, map(), map()) -> map().
pending_ids(policy, _Request, Game) ->
    maps:get(policy_requests, Game, #{});
pending_ids(pair, Request, Game) ->
    Viewer = presence_game_activity_policy:value(viewer_id, Request, undefined),
    maps:get(requests, maps:get(Viewer, maps:get(pairs, Game, #{}), #{}), #{}).

-spec pending_control(policy | pair, map(), map()) -> {ok, map()} | {error, stale | busy}.
pending_control(Kind, Request, Game) ->
    Id = pending_id(Kind, Request),
    Phase = presence_game_activity_policy:value(phase, Request, undefined),
    Requests = pending_ids(Kind, Request, Game),
    case Phase =:= <<"fence">> andalso maps:is_key(Id, Requests) of
        true ->
            {ok, Game};
        false ->
            Local = Request#{owner_epoch => maps:get(owner_epoch, Game)},
            apply_control(Kind, Local, Game)
    end.

-spec record_pending_ack(policy | pair, map(), map(), map()) -> map().
record_pending_ack(Kind, Request, Ack, Game) ->
    Clean = Game#{
        rejection_tokens => maps:remove(
            pending_key(Kind, Request), maps:get(rejection_tokens, Game, #{})
        )
    },
    case presence_game_activity_policy:value(phase, Request, undefined) of
        <<"fence">> -> record_fence_ack(Kind, Request, Ack, Clean);
        _ -> Clean
    end.

-spec record_fence_ack(policy | pair, map(), map(), map()) -> map().
record_fence_ack(policy, Request, Ack, Game) ->
    Id = pending_id(policy, Request),
    Epoch = maps:get(<<"owner_epoch">>, Ack),
    Inherited = maps:get(inherited_policy_requests, Game, #{}),
    Game#{inherited_policy_requests => Inherited#{Id => Epoch}};
record_fence_ack(pair, Request, Ack, Game) ->
    Id = presence_game_activity_policy:value(request_id, Request, undefined),
    Viewer = presence_game_activity_policy:value(viewer_id, Request, undefined),
    Epoch = maps:get(<<"owner_epoch">>, Ack),
    Generation = binary_to_integer(maps:get(<<"pair_generation">>, Ack)),
    Pairs = maps:get(pairs, Game),
    Pair = maps:get(Viewer, Pairs),
    Requests = maps:get(requests, Pair),
    Inherited = maps:get(inherited_requests, Pair, #{}),
    Game#{
        pair_sequence => max(Generation, maps:get(pair_sequence, Game, 0)),
        pairs => Pairs#{
            Viewer => Pair#{
                generation => max(Generation, maps:get(generation, Pair)),
                requests => Requests#{Id => Generation},
                inherited_requests => Inherited#{Id => Epoch}
            }
        }
    }.

-spec store_pending(integer(), map(), map(), map()) -> map().
store_pending(UserId, Game, Request, State) ->
    Pending = maps:get(game_activity_pending, State, #{}),
    Viewer = presence_game_activity_policy:value(viewer_id, Request, undefined),
    Pairs0 = maps:get(pairs, Game, #{}),
    Pair = maps:get(Viewer, Pairs0, #{}),
    Pairs =
        case map_size(maps:get(requests, Pair, #{})) of
            0 -> maps:remove(Viewer, Pairs0);
            _ -> Pairs0
        end,
    HasPending = map_size(maps:get(policy_requests, Game, #{})) > 0 orelse map_size(Pairs) > 0,
    Tokens = maps:filter(
        fun({Kind, Target, Id}, _) ->
            maps:is_key(Id, pending_ids(Kind, #{viewer_id => Target}, Game))
        end,
        maps:get(rejection_tokens, Game, #{})
    ),
    Next =
        case HasPending of
            true -> Pending#{UserId => Game#{pairs => Pairs, rejection_tokens => Tokens}};
            false -> maps:remove(UserId, Pending)
        end,
    PreviousCount = presence_game_activity_policy:pending_count(maps:get(UserId, Pending, #{})),
    NextCount = presence_game_activity_policy:pending_count(maps:get(UserId, Next, #{})),
    State#{
        game_activity_pending => Next,
        game_activity_pending_count => maps:get(game_activity_pending_count, State, 0) +
            NextCount - PreviousCount
    }.

-spec apply_control(policy | pair, map(), map()) -> {ok, map()} | {error, stale | busy}.
apply_control(policy, Request, Game) ->
    presence_game_activity_policy:control(Request, Game);
apply_control(pair, Request, Game) ->
    presence_game_activity_policy:pair_control(Request, Game).
