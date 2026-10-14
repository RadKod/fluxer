<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# fluxer-nsfw

**Micup addition, not in upstream Fluxer.** `fluxer_media_proxy` sends image and video frames to an external classifier
at `FLUXER_NSFW_SERVICE_ENDPOINT`, and upstream ships no such service. This is that service. It implements the
contract in `fluxer_media_proxy/src/nsfw.rs` and nothing else. It holds no state, so it scales by adding replicas
behind the one endpoint (Micup PLAN §8, G-N).

## Contract

| | |
|---|---|
| Port / user | `8000`, uid:gid `65532:65532`, workdir `/srv/nsfw`. No network at runtime |
| Filesystem | Read-only root plus a small `/tmp` tmpfs (`/tmp:size=16m`), which is how CI runs it. Nothing is written at runtime |
| `POST /predict/image` | `{"base64_data": "<b64>"}` → `{"nsfw_probability": p}` |
| `POST /predict/images` | `{"images": [{"base64_data": "<b64>"}, …]}` with 1–3 frames → `{"predictions": [{"nsfw_probability": p}, …]}`, same order |
| `GET /health` | `503` while the model loads and warms up, then `200` |
| `GET /_metrics` | Prometheus text: `fluxer_nsfw_requests_total{path,code}`, `fluxer_nsfw_request_seconds{path}` histogram, `fluxer_nsfw_queue_depth` |
| Self-test | `python /srv/nsfw/server.py --selftest` exits 0 only if the model loads and an in-memory plain JPEG scores `0 < p < 0.5`. Works with `--network none`. Infra `kur-fluxer.sh` runs exactly this command before `up` |
| Image healthcheck | `GET /health` through python `urllib` (curl and wget are not in the image) |
| HTTP | HTTP/1.1 keep-alive. Idle connections are closed after 65 s, longer than nsfw.rs's 30 s pool idle time, so the client always closes first. A reply sent before the body has been read carries `Connection: close` |

Probabilities are returned unrounded. If they were rounded, a clean frame would read as `0`.

Answers other than 200:

- `400`: invalid request. That means:
  - not JSON, or nested too deep;
  - not 1–3 frames;
  - a frame that is not base64, decodes to more than 1 MiB, is not JPEG/PNG/WebP, or is corrupt;
  - a frame with a side over 1024 px (twice media-proxy's 512 px frame cap, `NSFW_FRAME_MAX_DIMENSION`), checked from the header before decoding;
  - a body shorter than its `Content-Length` when the client closes.
- `404`: unknown path.
- `408`: the body did not arrive within 5 s in total. The limit is on the whole body, not on each read.
- `411`: no `Content-Length`.
- `413`: body over 4.5 MiB. Three 1 MiB frames in base64 plus the JSON around them fit.
- `500`: any internal failure, including a prediction that is not a finite number. It is never a dropped connection and never invalid JSON, and it is counted in `/_metrics`.
- `503`, always immediate. media-proxy counts any non-2xx as unavailable. It is returned when:
  - the model is still loading;
  - the queue is full;
  - the request waited longer than media-proxy would. It is dropped before inference, 4.5 s after it started for `/predict/image` and 14.5 s for `/predict/images`, because nsfw.rs gives up at 5 s and 15 s.

## Concurrency, memory and environment

- `NSFW_WORKERS` (default `2`): how many inferences run at once.
- `NSFW_QUEUE` (default `48`): how many more requests may wait.
  - A request beyond workers + queue gets `503` before its body is read.
  - Sizing: a video scan alone sends 16 frames at once (4 jobs × 4 frames), and messages and feed images arrive on top of that.
  - At the assumed ~20 frames/s on 2 vCPU (PLAN §3; CI logs the measured rate), 48 queued single frames drain in about 2.4 s, inside the 4.5 s budget. The queue still holds at down to ~11 frames/s.
  - When throughput is lower than that, the deadline drop turns the overflow into fast `503`s instead of 5 s timeouts.
  - Batch requests have a 15 s budget.
- Memory:
  - Pixels are decoded only inside a worker slot. At most 2 × 3 frames × 1024² are decoded at once, about 25 MiB.
  - Queued requests hold only their compressed frames. Each is at most 3 MiB by contract; a real media-proxy frame is a 512 px low-quality JPEG of tens of KiB.
  - The model runs in onnxruntime, not Keras+JAX. Served by Keras+JAX, the service peaked at 1138 MiB RSS (VmHWM) under the CI load smoke. That is over the 900 MiB gate (PLAN §3 RSS rule). The peak came from XLA: Keras runs the model eagerly, so XLA compiled it op by op, once per batch size (1–3 frames), and two such inferences ran at once. The same load smoke on one machine: Keras+JAX 852 MiB peak, onnxruntime 151 MiB.
- Threads: each inference runs on one onnxruntime thread (`intra_op_num_threads = inter_op_num_threads = 1`, `server.py`), so `NSFW_WORKERS=2` uses 2 cores, matching the compose limit `cpus: 2`.

## Build and version

- `.github/workflows/micup-nsfw-imaj.yml` builds this directory as the build context and tags it `ghcr.io/<owner>/micup-v2/fluxer-nsfw:v<VERSION>`.
  - The build does not depend on the candidate sha, and candidate builds never rebuild it.
  - Triggers: manual, or a push that changes `fluxer_nsfw/**`.
- Order: build locally → self-test → load smoke → media-proxy smoke → push → summary. Nothing is pushed unless every step passes.
  - Load smoke: 16 video-like plus 8 interactive concurrent requests under `--cpus 2 --memory 1g`, read-only. It logs throughput, p99 and peak RSS. It fails on any non-200, unless the runner is measurably too slow, in which case it only warns. It fails on RSS above 900 MiB.
  - media-proxy smoke: a generated GIF, WebP, APNG, CMYK JPEG, 16-bit PNG and 2 s mp4 go through `/_metadata`. `nsfw: allow` and `nsfw: block` must give the same result.
- Tags are immutable.
  - If `v<VERSION>` already exists and the build inputs (`Dockerfile`, `requirements.txt`, `requirements-model.txt`, `export_onnx.py`, `server.py`) are unchanged, CI pulls the existing image, runs the same smokes on it, and does not push.
  - If the inputs changed, the job fails. Raise `VERSION`.
- The run summary prints `MICUP_NSFW_ETIKET=v<VERSION>` and `MICUP_NSFW_OZET=sha256:…`, the registry manifest digest of the image that was tested. Infra pins both in `robot/fluxer/nsfw-imaj.env`.

## Model and dependencies

- Model: OpenNSFW2 0.19.0 (MIT). Weights: the OpenNSFW2 v0.1.0 release (Yahoo open_nsfw, BSD-2), fetched at build time and checked against the sha256 in `Dockerfile`.
- The build has two stages.
  - Model stage (`Dockerfile` `AS model`, not shipped):
    - builds the model in Keras 3 (Apache-2.0) on JAX (Apache-2.0) with those weights;
    - `export_onnx.py` writes it out as `open_nsfw.onnx` with onnx (Apache-2.0);
    - `test_model.py` then has to pass, or the build fails:
      - `server.preprocess` must equal OpenNSFW2's YAHOO preprocessing bit for bit (RGB, bilinear 256 px, a JPEG round trip, centre 224 px crop, BGR minus the channel means);
      - the served probabilities, in the server's 1–3 frame batches, must be within 1e-3 of Keras+JAX on the logit scale, on synthetic images: plain colours, grey, noise and a testsrc-like frame (no explicit content). On the logit scale a shift is still caught at p ≈ 0.001, where clean frames sit;
      - `export_onnx.py` must stop on layer options it does not write (dilation, `channels_first`, a fused activation), with `SystemExit`, not `assert`.
  - Served image: onnxruntime (MIT), numpy (BSD-3-Clause) and Pillow (MIT-CMU), plus `open_nsfw.onnx` and `server.py`. No Keras, JAX or weights file.
- `requirements.txt` (served image) and `requirements-model.txt` (model stage only) are hash-locked; their headers say how to regenerate them.
- Tests:
  - `python -m unittest fluxer_nsfw/test_server.py`: needs only Pillow and uses a fake predictor.
  - `cd fluxer_nsfw && KERAS_BACKEND=jax python -m unittest test_model`: needs both requirement files installed, `open_nsfw_weights.h5`, and `python export_onnx.py open_nsfw_weights.h5 open_nsfw.onnx` run first. The Docker build runs it every time.
