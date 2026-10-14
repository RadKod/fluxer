# Vendored livekit-client

Vendored from https://github.com/livekit/client-sdk-js at tag `v2.22.3` (commit `53dd840`) under the Apache-2.0 licence. Re-vendored from `v2.17.2` on 2026-09-17.

## Source transforms

Every file went through the same mechanical steps, so a fresh upstream tree can be brought into this shape before merging.

1. Test files, `src/test` and snapshots are dropped. Files that are not reachable from `src/index.ts` or `src/e2ee/worker/e2ee.worker.ts` are dropped too.
2. Comments are stripped. `/// <reference>` lines, `@ts-expect-error` directives that are still needed and `biome-ignore` lines stay.
3. Relative imports get explicit `.ts` extensions, and directory imports point at `index.ts`.
4. Each file starts with the LiveKit SPDX header.
5. `biome check --write --unsafe` runs with the repo config. The unsafe fixes are reviewed by hand, because `useOptionalChain` turned `callback && callback(x)` into a call on `false` in `room/debounce.ts`, and `noUnusedPrivateClassMembers` deleted a field that was still written in `utils/dataPacketBuffer.ts`.
6. The tree is made to pass `tsgo --noEmit` under `fluxer_app/tsconfig.json`. That means `override` modifiers, explicit `return undefined`, typed `let` declarations, no async promise executors, literal enum members and no unused `@ts-expect-error` directives.
7. `@livekit/throws-transformer/throws` imports point at `src/utils/throws.ts`, which copies its type definitions, so the dev-only package is not a dependency.

## Removed upstream code

`connectionHelper`, `createLocalScreenTracks`, `getStereoAudioStreamTrack`, `isLocalPub`, the frame metadata worker, `room/token-source/test-tokens.ts`, `utils/subscribeToEvents.ts`, and the `DataTrackPacket`, data track packet extension and `LocalTrackRecorder` exports. `createV0RtcUrl`, `truncateBytes`, `videoQualityForRid` and `STOP_REFETCH_DELAY_MS` are no longer exported.

## Behaviour changes to carry forward

`DeviceManager.getDevices` stops every track of its temporary permission stream in `finally`, including when the second `enumerateDevices` fails. The stream is owned by device enumeration and is never handed to a caller. Keep this cleanup on each update; `DeviceManager.test.ts` covers failure and successful enumeration, with no-capture controls.

`LocalTrack.restart` does nothing once the track was stopped with `stop()`. Upstream clears `manuallyStopped` there and re-acquires the device with `getUserMedia`, so an `unmute()`, a `restartTrack()`, a permission grant after a revoke or a mobile return from the background that reaches a track already stopped by a room disconnect opens a microphone or camera capture nobody owns, and it stays live until the page reloads. Re-acquisition after the device ended the capture (`ended` without `stop()`), after `stopOnMute`, after a device change while muted and after the camera mute released the capture is unchanged. The subclass overrides stop at the same point: `LocalAudioTrack.restart` skips the silence check (a temporary `AudioContext` and an `AudioSilenceDetected` event) and `LocalVideoTrack.restartTrack` skips the simulcast sender swap (an ended clone handed to `replaceTrack`) once the track was stopped. Every update has to keep these guards; `LocalAudioTrack.test.ts` ("microphone re-acquisition") and `LocalVideoTrack.test.ts` ("camera re-acquisition") fail without them.

## Updating from upstream

1. Read the upstream changelog for the target version.
2. Run the source transforms on the old tag and on the new tag. Keep the old result as the merge base and the new result as the other side.
3. Strip blank lines from the base, this tree and the new tree, run `git merge-file --diff3 --diff-algorithm=histogram` per file, and put blank lines back from the new tree. Blank-line drift between the trees otherwise turns into conflicts.
4. Resolve conflicts by starting from the upstream function and reapplying whatever this tree changed.
5. Diff the result against the transformed new tag after compiling both to JavaScript without types. Review every hunk.
6. Run `tsgo --noEmit` under the app tsconfig, `biome check`, `knip` and `pnpm --filter livekit-client test`, then update the version in `package.json` and this file.
