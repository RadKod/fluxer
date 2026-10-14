%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(fluxer_gateway_config_tests).
-typing([eqwalizer]).
-include_lib("eunit/include/eunit.hrl").

cluster_static_peers_rejects_invalid_node_names_test() ->
    LongPeer = list_to_binary(lists:duplicate(260, $a)),
    RawConfig = #{
        <<"services">> => #{
            <<"gateway">> => #{
                <<"cluster_static_peers">> => <<
                    "valid_peer@127.0.0.1,",
                    "invalid peer@127.0.0.2,",
                    "missing-host@,",
                    LongPeer/binary,
                    ",other-valid@node.local"
                >>
            }
        }
    },
    ?assertError(
        {invalid_cluster_static_peer, "invalid peer@127.0.0.2"},
        fluxer_gateway_config:build_config(RawConfig)
    ).

cluster_static_peers_accepts_valid_node_names_test() ->
    RawConfig = #{
        <<"services">> => #{
            <<"gateway">> => #{
                <<"cluster_static_peers">> =>
                    <<"valid_peer@127.0.0.1,other-valid@node.local">>
            }
        }
    },
    Config = fluxer_gateway_config:build_config(RawConfig),
    ?assertEqual(
        [list_to_atom("valid_peer@127.0.0.1"), list_to_atom("other-valid@node.local")],
        maps:get(cluster_static_peers, Config)
    ).

env_int_rejects_a_non_integer_value_test() ->
    with_env("FLUXER_GATEWAY_HTTP_RPC_MAX_CONCURRENCY", "abc", fun() ->
        ?assertError(
            {invalid_integer_env, "FLUXER_GATEWAY_HTTP_RPC_MAX_CONCURRENCY", "abc"},
            fluxer_gateway_config:load()
        )
    end).

env_int_falls_back_to_the_default_for_an_empty_value_test() ->
    with_env("FLUXER_GATEWAY_HTTP_RPC_MAX_CONCURRENCY", "", fun() ->
        Config = fluxer_gateway_config:load(),
        ?assertEqual(512, maps:get(gateway_http_rpc_max_concurrency, Config))
    end).

blank_env_values_fall_back_to_the_defaults_test() ->
    with_envs(
        [
            {"FLUXER_GATEWAY_HTTP_RPC_MAX_CONCURRENCY", "  "},
            {"FLUXER_CLIENT_IP_HEADER_NAME", " "},
            {"FLUXER_NATS_URL", "\t"},
            {"FLUXER_GATEWAY_API_RPC_ENDPOINT", "   "},
            {"FLUXER_GATEWAY_LOGGER_LEVEL", " "},
            {"FLUXER_GATEWAY_PUSH_ENABLED", " "}
        ],
        fun() ->
            Config = fluxer_gateway_config:load(),
            ?assertEqual(512, maps:get(gateway_http_rpc_max_concurrency, Config)),
            ?assertEqual(<<"x-forwarded-for">>, maps:get(client_ip_header, Config)),
            ?assertEqual("nats://nats:4222", maps:get(nats_core_url, Config)),
            ?assertEqual(undefined, maps:get(api_rpc_endpoint, Config)),
            ?assertEqual(info, maps:get(logger_level, Config)),
            ?assertEqual(true, maps:get(push_enabled, Config))
        end
    ).

self_hosted_follows_the_fluxer_self_hosted_env_test() ->
    with_env("FLUXER_SELF_HOSTED", "", fun() ->
        ?assertEqual(false, maps:get(self_hosted, fluxer_gateway_config:load()))
    end),
    with_env("FLUXER_SELF_HOSTED", "true", fun() ->
        ?assertEqual(true, maps:get(self_hosted, fluxer_gateway_config:load()))
    end).

pinned_guild_ids_reject_non_snowflakes_test() ->
    with_env("FLUXER_GATEWAY_PINNED_GUILD_IDS", "1100000000000000001,ab", fun() ->
        ?assertError({invalid_pinned_guild_id, "ab"}, fluxer_gateway_config:load())
    end).

env_value_reads_name_file_test() ->
    with_env_file(<<"from-file\r\n">>, fun(Path) ->
        with_envs(
            [{"FLUXER_GATEWAY_TEST_SECRET", ""}, {"FLUXER_GATEWAY_TEST_SECRET_FILE", Path}],
            fun() ->
                ?assertEqual(
                    "from-file", fluxer_gateway_config:env_value("FLUXER_GATEWAY_TEST_SECRET")
                )
            end
        )
    end).

env_value_trims_only_one_newline_test() ->
    with_env_file(<<"line1\nline2\n\n">>, fun(Path) ->
        with_env("FLUXER_GATEWAY_TEST_SECRET_FILE", Path, fun() ->
            ?assertEqual(
                "line1\nline2\n", fluxer_gateway_config:env_value("FLUXER_GATEWAY_TEST_SECRET")
            )
        end)
    end).

env_value_rejects_name_and_name_file_test() ->
    with_envs(
        [
            {"FLUXER_GATEWAY_TEST_SECRET", "direct"},
            {"FLUXER_GATEWAY_TEST_SECRET_FILE", "/run/secrets/x"}
        ],
        fun() ->
            ?assertError(
                {ambiguous_env, "FLUXER_GATEWAY_TEST_SECRET",
                    "FLUXER_GATEWAY_TEST_SECRET_FILE"},
                fluxer_gateway_config:env_value("FLUXER_GATEWAY_TEST_SECRET")
            )
        end
    ).

env_value_rejects_missing_name_file_test() ->
    Path = "/nonexistent/fluxer-gateway-test-secret",
    with_env("FLUXER_GATEWAY_TEST_SECRET_FILE", Path, fun() ->
        ?assertError(
            {unreadable_env_file, "FLUXER_GATEWAY_TEST_SECRET_FILE", Path, enoent},
            fluxer_gateway_config:env_value("FLUXER_GATEWAY_TEST_SECRET")
        )
    end).

with_env_file(Contents, Fun) ->
    Path = filename:join(
        filename:basedir(user_cache, "fluxer_gateway_tests"),
        integer_to_list(erlang:unique_integer([positive]))
    ),
    ok = filelib:ensure_dir(Path),
    ok = file:write_file(Path, Contents),
    try
        Fun(Path)
    after
        file:delete(Path)
    end.

with_envs([], Fun) ->
    Fun();
with_envs([{Name, Value} | Rest], Fun) ->
    with_env(Name, Value, fun() -> with_envs(Rest, Fun) end).

with_env(Name, Value, Fun) ->
    Previous = os:getenv(Name),
    restore_env(Name, Value),
    try
        Fun()
    after
        restore_env(Name, Previous)
    end.

restore_env(Name, false) ->
    os:unsetenv(Name);
restore_env(Name, Previous) ->
    os:putenv(Name, Previous).

cluster_min_peers_for_rpc_test() ->
    ?assertEqual(
        1, maps:get(cluster_min_peers_for_rpc, fluxer_gateway_config:build_config(#{}))
    ),
    with_env("FLUXER_GATEWAY_CLUSTER_MIN_PEERS_FOR_RPC", "2", fun() ->
        ?assertEqual(2, maps:get(cluster_min_peers_for_rpc, fluxer_gateway_config:load()))
    end),
    lists:foreach(
        fun(Value) ->
            with_env(
                "FLUXER_GATEWAY_CLUSTER_MIN_PEERS_FOR_RPC", integer_to_list(Value), fun() ->
                    ?assertError(
                        {invalid_cluster_min_peers_for_rpc, Value}, fluxer_gateway_config:load()
                    )
                end
            )
        end,
        [0, -1, 513]
    ).

cluster_rpc_stability_ms_test() ->
    ?assertEqual(
        5000, maps:get(cluster_rpc_stability_ms, fluxer_gateway_config:build_config(#{}))
    ),
    lists:foreach(
        fun(Value) ->
            with_env("FLUXER_GATEWAY_CLUSTER_RPC_STABILITY_MS", integer_to_list(Value), fun() ->
                ?assertEqual(
                    Value, maps:get(cluster_rpc_stability_ms, fluxer_gateway_config:load())
                )
            end)
        end,
        [0, 250, 60000]
    ),
    lists:foreach(
        fun(Value) ->
            with_env("FLUXER_GATEWAY_CLUSTER_RPC_STABILITY_MS", integer_to_list(Value), fun() ->
                ?assertError(
                    {invalid_cluster_rpc_stability_ms, Value}, fluxer_gateway_config:load()
                )
            end)
        end,
        [-1, 60001]
    ).

metrics_allowed_networks_default_to_loopback_only_test() ->
    Config = fluxer_gateway_config:build_config(#{}),
    ?assertEqual([], maps:get(metrics_allowed_networks, Config)).

metrics_allowed_networks_parse_the_env_list_test() ->
    Value = " 10.77.0.0/24 , ,fd00:77::/64,192.0.2.10 ",
    with_env("FLUXER_METRICS_ALLOWED_CIDRS", Value, fun() ->
        Config = fluxer_gateway_config:load(),
        ?assertEqual(
            [
                {{10, 77, 0, 0}, 24},
                {{16#fd00, 16#77, 0, 0, 0, 0, 0, 0}, 64},
                {{192, 0, 2, 10}, 32}
            ],
            maps:get(metrics_allowed_networks, Config)
        )
    end).

metrics_allowed_networks_reject_invalid_entries_test() ->
    lists:foreach(
        fun(Entry) ->
            RawConfig = #{
                <<"services">> => #{
                    <<"gateway">> => #{<<"metrics_allowed_cidrs">> => list_to_binary(Entry)}
                }
            },
            ?assertError(
                {invalid_metrics_allowed_cidr, Entry},
                fluxer_gateway_config:build_config(RawConfig)
            )
        end,
        ["10.77.0.0/33", "fd00::/129", "not-an-ip/24", "10.77.0.0/", "1.2.3.4/2x", "1.2.3.4/-1"]
    ).

connection_limits_default_to_upstream_test() ->
    Config = fluxer_gateway_config:build_config(#{}),
    ?assertEqual(0, maps:get(zstd_window_log, Config)),
    ?assertEqual(0, maps:get(max_connections, Config)),
    ?assertEqual(0, maps:get(max_connections_per_ipv6_48, Config)),
    ?assertEqual(0, maps:get(max_unidentified_connections, Config)),
    ?assertEqual(0, maps:get(identify_timeout_ms, Config)),
    ?assertEqual(false, maps:get(count_ipv6_by_64, Config)).

connection_limits_read_env_test() ->
    with_envs(
        [
            {"FLUXER_GATEWAY_MAX_CONNECTIONS", "2500"},
            {"FLUXER_GATEWAY_MAX_CONNECTIONS_PER_IPV6_48", "1024"},
            {"FLUXER_GATEWAY_MAX_UNIDENTIFIED_CONNECTIONS", "250"},
            {"FLUXER_GATEWAY_IDENTIFY_TIMEOUT_MS", "45000"},
            {"FLUXER_GATEWAY_COUNT_IPV6_BY_64", "true"}
        ],
        fun() ->
            Config = fluxer_gateway_config:load(),
            ?assertEqual(2500, maps:get(max_connections, Config)),
            ?assertEqual(1024, maps:get(max_connections_per_ipv6_48, Config)),
            ?assertEqual(250, maps:get(max_unidentified_connections, Config)),
            ?assertEqual(45000, maps:get(identify_timeout_ms, Config)),
            ?assertEqual(true, maps:get(count_ipv6_by_64, Config))
        end
    ).

connection_limits_reject_non_integer_env_test() ->
    lists:foreach(
        fun({Name, Value}) ->
            with_env(Name, Value, fun() ->
                ?assertError({invalid_integer_env, Name, Value}, fluxer_gateway_config:load())
            end)
        end,
        [
            {"FLUXER_GATEWAY_MAX_CONNECTIONS", "abc"},
            {"FLUXER_GATEWAY_MAX_CONNECTIONS_PER_IPV6_48", "1k"},
            {"FLUXER_GATEWAY_MAX_UNIDENTIFIED_CONNECTIONS", "250x"},
            {"FLUXER_GATEWAY_IDENTIFY_TIMEOUT_MS", "20s"}
        ]
    ).

zstd_window_log_env_test() ->
    lists:foreach(
        fun({Value, Expected}) ->
            with_env("FLUXER_GATEWAY_ZSTD_WINDOW_LOG", Value, fun() ->
                ?assertEqual(Expected, maps:get(zstd_window_log, fluxer_gateway_config:load()))
            end)
        end,
        [{false, 0}, {"", 0}, {"0", 0}, {"10", 10}, {"18", 18}, {"23", 23}]
    ).

zstd_window_log_rejects_non_integer_env_test() ->
    lists:foreach(
        fun(Value) ->
            with_env("FLUXER_GATEWAY_ZSTD_WINDOW_LOG", Value, fun() ->
                ?assertError(
                    {invalid_integer_env, "FLUXER_GATEWAY_ZSTD_WINDOW_LOG", Value},
                    fluxer_gateway_config:load()
                )
            end)
        end,
        ["abc", "18.0"]
    ).

zstd_window_log_rejects_out_of_range_test() ->
    lists:foreach(
        fun(Value) ->
            with_env("FLUXER_GATEWAY_ZSTD_WINDOW_LOG", Value, fun() ->
                Parsed = list_to_integer(Value),
                ?assertError(
                    {invalid_zstd_window_log, Parsed},
                    fluxer_gateway_config:load()
                )
            end)
        end,
        ["9", "24", "-1"]
    ).
