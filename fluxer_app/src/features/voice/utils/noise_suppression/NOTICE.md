# Noise suppression worklet licenses

The noise suppression backends load WebAssembly binaries and AudioWorklet
processors that are bundled into the app from
`@sapphi-red/web-noise-suppressor`. They are third-party artifacts and keep
their upstream licenses.

| Artifact | Component | License |
| --- | --- | --- |
| `rnnoise.wasm`, `rnnoise_simd.wasm` | RNNoise (xiph) built by `@shiguredo/rnnoise-wasm` | BSD-3-Clause (RNNoise), Apache-2.0 (build wrapper) |
| `gtcrn.wasm` | GTCRN compiled with `onnx2c` by `@sapphi-red/gtcrn-wasm`, bundling `pffft` | MIT (GTCRN code and weights), FFTPACK/UCAR (pffft) |
| `speex.wasm` | SpeexDSP preprocessor built by `@sapphi-red/speex-preprocess-wasm` | BSD-3-Clause (Xiph.Org, Valin, Analog Devices, CSIRO, Rowe, EpicGames, Degener/Bormann) |
| `*.worklet.js` | AudioWorklet processors from `@sapphi-red/web-noise-suppressor` | MIT |
| `rnnoise-sync.js` (embedded RNNoise 0.2 WASM) | `@jitsi/rnnoise-wasm` 0.2.1 | Apache-2.0 (wrapper), BSD-3-Clause (RNNoise) |

The speech detector uses the synchronous artifact from
https://github.com/jitsi/rnnoise-wasm, not its legacy asynchronous RNNoise 0.1
artifact. Its unmodified SHA-256 is
`05a553f523d59502d133a6d05dbf1878137c9e7bcff06edf5561f7001b62f95f`.
The build loader verifies this pin and replaces only the default export with
an AudioWorklet-global factory. The RNNoise model is embedded in that pinned
artifact; no external model URL is accepted. It is loaded only for the opt-in
mono voice pipeline. RNNoise's denoised output is discarded: only its speech
probability drives the gate.

The worklet processors are modified at build time by
`fluxer_app/scripts/build/rspack/noise-suppressor-worklet-loader.cjs`, which
makes them pass audio through until their WebAssembly module is ready, start
their message port, and report readiness and initialisation failures.

The Xiph license text ships inside `speex.wasm`'s worklet bundle. No Fluxer
license notice grants rights to third-party trademarks or brand names.
