%% SPDX-License-Identifier: AGPL-3.0-or-later
-module(game_activity_lease_tests).
-include_lib("eunit/include/eunit.hrl").

fixture() -> (presence_game_activity_policy:new())#{tokens => 2, budget_at => 0}.
activity(N) -> #{<<"game_id">> => <<"test-game">>, <<"started_at">> => N}.

null_clears_only_producer_test() ->
    State = #{
        game_activity_state => #{
            candidates => #{<<"a">> => #{}, <<"b">> => #{}}, owner => <<"a">>
        }
    },
    {noreply, Next} = presence:handle_cast({game_activity_clear, <<"b">>}, State),
    ?assertNot(maps:is_key(<<"b">>, maps:get(candidates, maps:get(game_activity_state, Next)))),
    ?assert(maps:is_key(<<"a">>, maps:get(candidates, maps:get(game_activity_state, Next)))).

two_desktops_last_real_change_wins_test() ->
    {G1, true} = presence_game_activity:transition(<<"a">>, activity(1000), 0, 1000, fixture()),
    {G2, true} = presence_game_activity:transition(<<"b">>, activity(2000), 1, 2000, G1),
    ?assertEqual({<<"b">>, activity(2000)}, presence_game_activity:selected(G2, 2)).

renew_does_not_steal_owner_test() ->
    {G1, true} = presence_game_activity:transition(<<"a">>, activity(1000), 0, 1000, fixture()),
    {G2, true} = presence_game_activity:transition(<<"b">>, activity(2000), 1, 2000, G1),
    {G3, false} = presence_game_activity:transition(<<"a">>, activity(1000), 200, 5000, G2),
    ?assertEqual({<<"b">>, activity(2000)}, presence_game_activity:selected(G3, 201)),
    ?assertEqual(maps:get(activity_revision, G2), maps:get(activity_revision, G3)),
    ?assertEqual(maps:get(tokens, G2), maps:get(tokens, G3)).

disconnect_falls_back_test() ->
    Now = erlang:monotonic_time(millisecond),
    {G1, true} = presence_game_activity:transition(
        <<"a">>, activity(1000), Now, 1000, (fixture())#{budget_at => Now}
    ),
    {G2, true} = presence_game_activity:transition(<<"b">>, activity(2000), Now + 1, 2000, G1),
    Next = presence_game_activity:disconnect(<<"b">>, #{game_activity_state => G2}),
    ?assertEqual(
        {<<"a">>, activity(1000)},
        presence_game_activity:selected(maps:get(game_activity_state, Next), Now)
    ),
    flush().

web_absent_noop_test() ->
    State = #{game_activity_state => fixture()},
    ?assertEqual(State, presence_game_activity:update(#{session_id => <<"web">>}, State)).

stale_timer_cannot_clear_new_owner_test() ->
    Now = erlang:monotonic_time(millisecond),
    {G1, true} = presence_game_activity:transition(
        <<"a">>, activity(1000), Now - 100000, 1000, fixture()
    ),
    {G2, false} = presence_game_activity:transition(<<"a">>, activity(1000), Now, 1000, G1),
    State = #{game_activity_state => G2},
    ?assertEqual(
        State, presence_game_activity:expire(<<"a">>, 1, maps:get(owner_epoch, G2), State)
    ),
    ?assertEqual(State, presence_game_activity:expire(<<"a">>, 2, <<"old-owner">>, State)).

seven_day_renew_keeps_start_test() ->
    {G1, true} = presence_game_activity:transition(<<"a">>, activity(1000), 0, 1000, fixture()),
    {G2, false} = presence_game_activity:transition(
        <<"a">>, activity(1000), 60000, 900000000, G1
    ),
    ?assertEqual({<<"a">>, activity(1000)}, presence_game_activity:selected(G2, 60001)).

wall_clock_jump_not_lease_test() ->
    {G1, true} = presence_game_activity:transition(<<"a">>, activity(1000), 0, 1000, fixture()),
    {G2, false} = presence_game_activity:transition(
        <<"a">>, activity(1000), 1000, -900000000, G1
    ),
    ?assertEqual({undefined, null}, presence_game_activity:selected(G2, 121000)).

failed_scan_not_renewed_test() ->
    {G1, true} = presence_game_activity:transition(<<"a">>, activity(1000), 0, 1000, fixture()),
    ?assertEqual({undefined, null}, presence_game_activity:selected(G1, 120000)).

canonical_clamp_only_first_accept_test() ->
    {G1, true} = presence_game_activity:transition(
        <<"a">>, activity(1000000), 0, 1000, fixture()
    ),
    ?assertEqual({<<"a">>, activity(1000)}, presence_game_activity:selected(G1, 1)),
    {G2, false} = presence_game_activity:transition(<<"a">>, activity(1000000), 1, 1000000, G1),
    ?assertEqual({<<"a">>, activity(1000)}, presence_game_activity:selected(G2, 2)).

pending_last_value_and_clear_test() ->
    G0 = (fixture())#{tokens => 0},
    {G1, false} = presence_game_activity:transition(<<"a">>, activity(1), 0, 1, G0),
    {G2, false} = presence_game_activity:transition(<<"a">>, activity(2), 1, 2, G1),
    ?assertMatch({<<"a">>, #{<<"started_at">> := 2}, _}, maps:get(pending, G2)),
    Next = presence_game_activity:clear(<<"a">>, #{game_activity_state => G2}),
    ?assertEqual(undefined, maps:get(pending, maps:get(game_activity_state, Next))).

restart_budget_empty_test() ->
    ?assertEqual(0, maps:get(tokens, presence_game_activity_policy:new())).

renew_cancels_same_producer_pending_change_test() ->
    {Accepted, true} = presence_game_activity:transition(<<"a">>, activity(1), 0, 1, fixture()),
    {Pending, false} = presence_game_activity:transition(<<"a">>, activity(2), 1, 2, Accepted#{
        tokens => 0
    }),
    {Renewed, false} = presence_game_activity:transition(<<"a">>, activity(1), 2, 3, Pending),
    ?assertEqual(undefined, maps:get(pending, Renewed)).

renew_preserves_other_producer_pending_test() ->
    {Accepted, true} = presence_game_activity:transition(<<"a">>, activity(1), 0, 1, fixture()),
    {Pending, false} = presence_game_activity:transition(<<"b">>, activity(2), 1, 2, Accepted#{
        tokens => 0
    }),
    {Renewed, false} = presence_game_activity:transition(<<"a">>, activity(1), 2, 3, Pending),
    ?assertEqual(maps:get(pending, Pending), maps:get(pending, Renewed)).

flush() ->
    receive
        _ -> flush()
    after 0 -> ok
    end.
