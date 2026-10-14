%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(session_manager_shard_rollout).
-typing([eqwalizer]).

-export([init/1, changed/1, down/1, retry/1, batch/1, terminate/1]).

-spec init(map()) -> map().
init(State) ->
    subscribe(changed(State)).

-spec changed(map()) -> map().
changed(State) ->
    Allowed = gateway_rollout_config:game_activity_allowed(),
    Epoch = maps:get(<<"game_activity_epoch">>, gateway_rollout_config:get(), 0),
    Generation =
        case Allowed of
            true -> gateway_rollout_config:game_activity_generation();
            false -> 0
        end,
    Gate = {Allowed, Epoch, Generation},
    case maps:get(game_activity_gate, State, undefined) =:= Gate of
        true ->
            State;
        false ->
            self() !
                {session_game_activity_rollout_batch, maps:iterator(maps:get(sessions, State))},
            State#{game_activity_gate => Gate}
    end.

-spec down(map()) -> map().
down(State) ->
    init(maps:without([rollout_config_pid, rollout_config_monitor], State)).

-spec retry(map()) -> map().
retry(State) ->
    init(cancel_retry(State)).

-spec subscribe(map()) -> map().
subscribe(State) ->
    case whereis(gateway_rollout_config) of
        undefined -> retry_later(State);
        Pid -> subscribe(Pid, cancel_retry(State))
    end.

-spec subscribe(pid(), map()) -> map().
subscribe(Pid, #{rollout_config_pid := Pid} = State) ->
    State;
subscribe(Pid, State) ->
    Ref = monitor(process, Pid),
    gateway_rollout_config:subscribe_changes(self()),
    self() ! rollout_config_changed,
    State#{rollout_config_pid => Pid, rollout_config_monitor => Ref}.

-spec retry_later(map()) -> map().
retry_later(#{rollout_config_retry := _} = State) ->
    State;
retry_later(State) ->
    State#{rollout_config_retry => erlang:send_after(1000, self(), retry_rollout_config)}.

-spec cancel_retry(map()) -> map().
cancel_retry(#{rollout_config_retry := Timer} = State) ->
    _ = erlang:cancel_timer(Timer),
    maps:remove(rollout_config_retry, State);
cancel_retry(State) ->
    State.

-spec batch(maps:iterator()) -> ok.
batch(Iterator) ->
    batch(100, Iterator).

-spec batch(non_neg_integer(), maps:iterator()) -> ok.
batch(0, Iterator) ->
    self() ! {session_game_activity_rollout_batch, Iterator},
    ok;
batch(N, Iterator) ->
    case maps:next(Iterator) of
        none ->
            ok;
        {_Id, {Pid, _Ref}, Next} ->
            gen_server:cast(Pid, game_activity_rollout_changed),
            batch(N - 1, Next)
    end.

-spec terminate(map()) -> ok.
terminate(State) ->
    _ = cancel_retry(State),
    gateway_rollout_config:unsubscribe_changes(self()).
