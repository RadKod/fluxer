# Game activity component integration

Run explicitly from the repository root after the frozen workspace install and the existing gateway test dependency build:

```sh
node tests/game_activity_integration/run.mjs
```

Requires OTP 28 (`erl` and `erlc` on PATH) and the gateway's existing `meck` test dependency. Set `OTP_BIN` when OTP is installed elsewhere. Set `GAME_ACTIVITY_MECK_EBIN` when rebar uses a different build directory. `GAME_ACTIVITY_TEST_TMP` selects the generated beam/input directory; the default is the ignored `node_modules/.cache/game-activity-integration`. No dependency is installed by this runner. The default application suite does not include these tests.

The five cases use the real desktop process parser/catalog selector, desktop activity bridge/producer, gateway socket JSON serializer, API grant service, Erlang owner selection/subscription/delivery/barrier and receiver grant/fence/wire projection, receiver store, profile game component, static icon loader and shared minute clock.

The OS process query, Electron IPC transport, database repository, deployment rollout configuration and network relay/output queue are fixtures. The receiver uses a small local process loop around the real session functions. The socket uses an in-memory transport; it does not establish a WebSocket connection. DOM rendering uses happy-dom. This is cross-language component integration, not a real Electron/game, API HTTP, Cassandra or socket E2E run.

Checks include the game-specific icon/name/duration, off removal and local immediate null, zero blocked-viewer projections, `only_me` intersection, absent/guild updates, a shared clock, and rejection of the unapproved `shared_guilds` sharing option. Existing profile `guilds` audience still intersects with the required friendship. New manual process mapping remains unavailable in the current tasklist detector because it lacks process birth identity.
