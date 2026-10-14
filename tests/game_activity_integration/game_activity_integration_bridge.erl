%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_integration_bridge).
-export([run/1]).

run(Path) ->
    {ok, Encoded} = file:read_file(Path),
    Input = json:decode(Encoded),
    meck:new(gateway_rollout_config, [non_strict]),
    meck:expect(gateway_rollout_config, game_activity_allowed, fun() -> true end),
    meck:expect(gateway_rollout_config, get, fun() -> #{<<"game_activity_epoch">> => 0} end),
    meck:expect(gateway_rollout_config, game_activity_generation, fun() -> 0 end),
    meck:new(gateway_dispatch_relay, [non_strict]),
    meck:expect(gateway_dispatch_relay, dispatch_game_activity_many, fun(Pids, Payload) ->
        lists:foreach(fun(Pid) -> Pid ! {projection, Payload} end, Pids), ok
    end),
    meck:new(session_dispatch_presence, [non_strict]),
    meck:expect(session_dispatch_presence, presence_user_id, fun(Data) ->
        binary_to_integer(maps:get(<<"id">>, maps:get(<<"user">>, Data)))
    end),
    meck:expect(session_dispatch_presence, dispatch_presence_now, fun(#{data := Data}, State) ->
        capture(Data, State)
    end),
    Policy = maps:get(<<"policy">>, Input),
    G0 = (presence_game_activity_policy:new())#{
        policy => Policy, policy_revision => maps:get(<<"policy_revision">>, Policy),
        rollout_epoch => 0, rollout_generation => 0, tokens => 2
    },
    State0 = #{user_id => 2, is_bot => false, game_activity_state => G0,
        friends => #{1 => true, 3 => true},
        sessions => #{<<"desktop">> => #{status => online, afk => false, mobile => false}}},
    {Receivers, State1} = lists:mapfoldl(fun(Row, State) ->
        Viewer = maps:get(<<"viewer">>, Row),
        Receiver = spawn(fun() -> receiver(#{user_id => Viewer, bot => false,
            relationships => #{2 => 1}, output => []}) end),
        G = maps:get(game_activity_state, State),
        Context = presence_game_activity_policy:context(Viewer, G),
        Stamp = Context#{owner_pid => self()},
        ok = gen_server:call(Receiver, {expect, 2, Stamp}),
        Grant = (maps:get(<<"grant">>, Row))#{<<"request_nonce">> => maps:get(request_nonce, Context)},
        {Reply, Next} = presence_game_activity:subscribe(Viewer, Receiver, Context, Grant, State),
        {{Viewer, Receiver, element(1, Reply) =:= ok}, Next}
    end, State0, maps:get(<<"viewers">>, Input)),
    State2 = lists:foldl(fun(Activity, State) ->
        Next = presence_game_activity:update(#{session_id => <<"desktop">>, game_activity => Activity}, State),
        G = maps:get(game_activity_state, Next),
        presence_game_activity:deliver(maps:to_list(maps:get(grants, G, #{})), Next)
    end, State1, maps:get(<<"activities">>, Input)),
    State3 = case maps:get(<<"off">>, Input, false) of
        false -> State2;
        true ->
            Fence = Policy#{<<"user_id">> => <<"2">>, <<"owner_epoch">> => null,
                <<"phase">> => <<"fence">>, <<"request_id">> => <<"e2e-off">>},
            {{barrier, Targets, Ack}, Closed} = presence_game_activity:control(policy, Fence, State2),
            presence_game_activity:barrier(Targets, Ack, Closed, self()),
            receive {game_activity_barrier_done, _, {ok, _}} -> ok after 5000 -> error(barrier_timeout) end,
            Closed
    end,
    Results = [#{viewer => Viewer, subscribed => Subscribed,
        output => gen_server:call(Pid, output)} || {Viewer, Pid, Subscribed} <- Receivers],
    G3 = maps:get(game_activity_state, State3),
    io:format("~s", [json:encode(#{viewers => Results,
        selected => element(2, presence_game_activity:selected(G3, erlang:monotonic_time(millisecond)))})]).

capture(Data, State) ->
    Wire = session_game_activity:wire(presence_update, Data, State),
    State#{output => [Wire | maps:get(output, State)]}.

receiver(State) ->
    receive
        {'$gen_call', From, {expect, Owner, Stamp}} ->
            {reply, Reply, Next} = session_game_activity:expect(Owner, Stamp, State),
            gen_server:reply(From, Reply), receiver(Next);
        {'$gen_call', From, {game_activity_grant, Owner, Stamp}} ->
            {reply, Reply, Next} = session_game_activity:grant(Owner, Stamp, State),
            gen_server:reply(From, Reply), receiver(Next);
        {'$gen_call', From, {game_activity_fence, Owner, Stamp}} ->
            {reply, Reply, Next} = session_game_activity:fence(Owner, Stamp, State),
            gen_server:reply(From, Reply), receiver(Next);
        {'$gen_call', From, output} ->
            gen_server:reply(From, lists:reverse(maps:get(output, State))), receiver(State);
        {'$gen_cast', {game_activity_fence, Owner, Stamp}} ->
            {reply, _, Next} = session_game_activity:fence(Owner, Stamp, State), receiver(Next);
        {projection, Data} ->
            {true, Next} = session_game_activity:prepare(presence_update, Data, State),
            receiver(capture(Data, Next));
        _ -> receiver(State)
    end.
