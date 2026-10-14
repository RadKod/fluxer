# SPDX-License-Identifier: AGPL-3.0-or-later
"""CI smoke for the fluxer-nsfw image (.github/workflows/micup-nsfw-imaj.yml). Runs inside the image, script on stdin:

  docker exec -i nsfw python - load < smoke.py         contract + video burst with interactive calls, 127.0.0.1:8000
  docker run -i ... python - media-proxy < smoke.py    sample set through media-proxy /_metadata, 'allow' vs 'block'

Generated plain-colour media only.
"""

import base64
import collections
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

NSFW = "http://127.0.0.1:8000"
MEDIA_PROXY = "http://media-proxy:8080"
COLOURS = ((40, 120, 200), (90, 160, 60), (128, 128, 128))


def post(url, body, headers=None, timeout=15):
    request = urllib.request.Request(
        url, json.dumps(body).encode(), {"Content-Type": "application/json", **(headers or {})}
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.status, json.load(resp), time.monotonic() - start
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(errors="replace")[:200], time.monotonic() - start
    except (urllib.error.URLError, TimeoutError) as err:  # what media-proxy would see as a timeout or reset
        return 0, str(err)[:200], time.monotonic() - start


def encode(image, fmt, **options):
    buf = io.BytesIO()
    image.save(buf, fmt, **options)
    return buf.getvalue()


def frame(colour):
    return {"base64_data": base64.b64encode(encode(Image.new("RGB", (512, 512), colour), "JPEG")).decode()}


def load():
    status, body, _ = post(NSFW + "/predict/image", frame(COLOURS[0]))
    assert status == 200 and 0 < body["nsfw_probability"] < 0.5, (status, body)
    status, body, _ = post(NSFW + "/predict/images", {"images": [frame(c) for c in COLOURS]})
    assert status == 200 and len(body["predictions"]) == 3, (status, body)
    assert all(0 < p["nsfw_probability"] < 0.5 for p in body["predictions"]), body

    single = sorted(post(NSFW + "/predict/image", frame(COLOURS[i % 3]))[2] for i in range(7))[3]
    workers = int(os.environ.get("NSFW_WORKERS", "2"))
    rate = workers / single
    in_flight = 16 + 4 + 4 * 3  # frames of the burst below
    slow = in_flight / rate > 4.0  # the burst cannot fit in media-proxy's 5 s on this runner
    print(f"throughput ~{rate:.1f} frames/s ({single:.3f} s per frame, {workers} workers); "
          f"NSFW_QUEUE=48 drains in ~{48 / rate:.1f} s")

    # A video scan alone opens 4 jobs x 4 frames = 16 single-frame calls (FeedVideoScanner, WorkerLaneConfig);
    # interactive traffic arrives at the same time: 4 still images and 4 three-frame animations or videos.
    # Client timeouts are media-proxy's (nsfw.rs): 5 s single, 15 s batch. Closed loop, three rounds.
    def call(kind):
        if kind == "batch":
            return kind, *post(NSFW + "/predict/images", {"images": [frame(c) for c in COLOURS]}, timeout=15)
        return kind, *post(NSFW + "/predict/image", frame(COLOURS[len(kind) % 3]), timeout=5)

    with ThreadPoolExecutor(24) as pool:
        results = list(pool.map(call, (["video"] * 16 + ["still"] * 4 + ["batch"] * 4) * 3))
    codes = collections.Counter(code for _, code, _, _ in results)
    for group in ("video", "still", "batch"):
        seconds = sorted(elapsed for kind, _, _, elapsed in results if kind == group)
        p99 = seconds[min(len(seconds) - 1, int(len(seconds) * 0.99))]
        print(f"{group}: n={len(seconds)} p50={seconds[len(seconds) // 2]:.3f}s p99={p99:.3f}s")
        if group != "batch" and p99 > 2:
            print(f"::warning::NSFW {group} p99 {p99:.3f}s > 2 s (PLAN §8 G-N trigger)")
    print(f"answers: {dict(codes)}")
    with urllib.request.urlopen(NSFW + "/_metrics", timeout=5) as resp:
        metrics = resp.read().decode().splitlines()
    print("\n".join(line for line in metrics if line.startswith("fluxer_nsfw_requests_total")))
    assert "fluxer_nsfw_queue_depth 0" in metrics, "queue did not drain"
    failed = {code: n for code, n in codes.items() if code != 200}
    if failed and slow:
        print(f"::warning::runner too slow for the burst ({in_flight} frames at {rate:.1f}/s > 4 s): {failed}")
    else:
        assert not failed, f"non-200 answers under 16 video + 8 interactive concurrent calls: {failed}"


def samples():
    frames = [Image.new("RGB", (64, 64), colour) for colour in COLOURS]
    animated = {"save_all": True, "append_images": frames[1:], "duration": 100, "loop": 0}
    return {
        "anim.gif": encode(frames[0], "GIF", **animated),
        "anim.webp": encode(frames[0], "WEBP", **animated),
        "anim.png": encode(frames[0], "PNG", **animated),  # APNG
        "cmyk.jpg": encode(Image.new("CMYK", (64, 64), (200, 40, 0, 20)), "JPEG"),
        "16bit.png": encode(Image.new("I;16", (64, 64), 30000), "PNG"),
        "video.mp4": open("/ornek/video.mp4", "rb").read(),  # ffmpeg testsrc, 2 s
    }


def media_proxy():
    auth = {"Authorization": "Bearer " + os.environ["MP_ANAHTAR"]}
    block_only, scanned = [], 0
    print("| file | allow | block | nsfw_probability (block) |\n|---|---|---|---|")
    for name, data in samples().items():
        request = {"version": 2, "type": "base64", "base64": base64.b64encode(data).decode(), "filename": name}
        allow = post(MEDIA_PROXY + "/_metadata", {**request, "nsfw": "allow"}, auth, 60)
        block = post(MEDIA_PROXY + "/_metadata", {**request, "nsfw": "block"}, auth, 60)
        probability = block[1].get("nsfw_probability") if isinstance(block[1], dict) else block[1]
        print(f"| {name} | {allow[0]} | {block[0]} | {probability} |")
        scanned += isinstance(probability, (int, float)) and probability > 0
        if allow[0] == 200 and block[0] != 200:
            block_only.append(name)
    assert scanned, "no file was scanned under 'block': media-proxy is not calling the NSFW endpoint"
    assert not block_only, f"files that fail only under 'block' (plan review Y3): {block_only}"


if __name__ == "__main__":
    {"load": load, "media-proxy": media_proxy}[sys.argv[1]]()
