#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""NSFW image classifier behind FLUXER_NSFW_SERVICE_ENDPOINT. The client and its contract are
fluxer_media_proxy/src/nsfw.rs:

  POST /predict/image   {"base64_data": b64}                 -> {"nsfw_probability": p}
  POST /predict/images  {"images": [{"base64_data": b64}..]} -> {"predictions": [{"nsfw_probability": p}..]}
  GET  /health          503 until the model is loaded, then 200
  GET  /_metrics        Prometheus text
  python /srv/nsfw/server.py --selftest   exit 0 only if the model loads and a plain JPEG scores 0 < p < 0.5

Probabilities go out unrounded. NSFW_WORKERS inferences run at once and NSFW_QUEUE more may wait; past that, or once a
request has waited longer than media-proxy would (DEADLINES), the answer is an immediate 503, which media-proxy treats
as unavailable. Images are decoded only inside a worker slot, so memory is bounded by the workers, not the queue.
Model: OpenNSFW2 (MIT; Yahoo weights BSD-2), exported from Keras 3 to ONNX at build time (export_onnx.py, held to
Keras+JAX by test_model.py) and run by onnxruntime; no network and no writes at runtime. Stateless: scale by adding
replicas.
"""

import base64
import collections
import io
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

PORT = 8000
MAX_FRAME_BYTES = 1024 * 1024  # nsfw.rs NSFW_MAX_FRAME_BYTES
MAX_FRAMES = 3  # nsfw.rs NSFW_MAX_FRAMES
MAX_BODY_BYTES = 4608 * 1024  # 3 full frames are 4 MiB in base64, plus the JSON around them
MAX_SIDE = 1024  # 2x media-proxy's NSFW_FRAME_MAX_DIMENSION (512); checked from the header, before decoding
FORMATS = ("JPEG", "PNG", "WEBP")  # media-proxy encodes every frame as JPEG
DEADLINES = {"/predict/image": 4.5, "/predict/images": 14.5}  # nsfw.rs gives up after 5 s / 15 s
READ_SECONDS = 5.0  # whole request body, not per recv
IDLE_SECONDS = 65  # keep-alive; longer than nsfw.rs's 30 s pool idle so the client always closes first
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "open_nsfw.onnx")
LABELLED_PATHS = (*DEADLINES, "/health", "/_metrics")
BUCKETS = (0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10)


def open_image(item):
    """Validate one frame up to its header; pixels are decoded later, inside a worker slot."""
    if not isinstance(item, dict) or not isinstance(item.get("base64_data"), str):
        raise ValueError("base64_data must be a string")
    data = base64.b64decode(item["base64_data"], validate=True)
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame exceeds 1 MiB")
    try:
        image = Image.open(io.BytesIO(data), formats=FORMATS)
    except (OSError, Image.DecompressionBombError) as err:
        raise ValueError("not a JPEG, PNG or WebP image") from err
    if max(image.size) > MAX_SIDE:
        raise ValueError(f"image side exceeds {MAX_SIDE} px")
    return image


def parse_frames(path, body):
    payload = json.loads(body)
    if path == "/predict/image":
        return [open_image(payload)]
    frames = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        raise ValueError(f"images must hold 1-{MAX_FRAMES} frames")
    return [open_image(frame) for frame in frames]


def decode(frames):
    try:
        for image in frames:
            image.load()
    except (OSError, Image.DecompressionBombError) as err:
        raise ValueError("image data is corrupt") from err
    return frames


class Metrics:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = collections.Counter()
        self.latency = {}  # path -> cumulative bucket counts, +Inf count, sum
        self.queued = 0

    def observe(self, path, code, seconds):
        with self.lock:
            self.requests[path, code] += 1
            if path in DEADLINES:
                hist = self.latency.setdefault(path, [0] * (len(BUCKETS) + 1) + [0.0])
                for i, le in enumerate(BUCKETS):
                    hist[i] += seconds <= le
                hist[len(BUCKETS)] += 1
                hist[-1] += seconds

    def render(self):
        with self.lock:
            lines = ["# TYPE fluxer_nsfw_requests_total counter"]
            lines += [
                f'fluxer_nsfw_requests_total{{path="{p}",code="{c}"}} {n}'
                for (p, c), n in sorted(self.requests.items())
            ]
            lines.append("# TYPE fluxer_nsfw_request_seconds histogram")
            for path, hist in sorted(self.latency.items()):
                lines += [
                    f'fluxer_nsfw_request_seconds_bucket{{path="{path}",le="{le}"}} {n}'
                    for le, n in zip((*BUCKETS, "+Inf"), hist)
                ]
                lines.append(f'fluxer_nsfw_request_seconds_sum{{path="{path}"}} {hist[-1]}')
                lines.append(f'fluxer_nsfw_request_seconds_count{{path="{path}"}} {hist[len(BUCKETS)]}')
            lines += ["# TYPE fluxer_nsfw_queue_depth gauge", f"fluxer_nsfw_queue_depth {self.queued}"]
        return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    server_version = "fluxer-nsfw"
    protocol_version = "HTTP/1.1"  # keep-alive: media-proxy's reqwest pool reuses connections
    timeout = IDLE_SECONDS

    def begin(self):
        self.started = time.monotonic()
        self.replied = False
        self.body_unread = self.command == "POST"  # any reply sent before the body is read closes the connection

    def do_GET(self):
        self.begin()
        if self.path == "/_metrics":
            return self.send(200, self.server.metrics.render().encode(), "text/plain; version=0.0.4")
        if self.path != "/health":
            return self.reply(404, {"error": "not_found"})
        if self.server.predict is None:
            return self.reply(503, {"status": "loading"})
        self.reply(200, {"status": "ok"})

    def do_POST(self):
        self.begin()
        try:
            self.admit()
        except Exception:
            traceback.print_exc()
            if not self.replied:
                self.reply(500, {"error": "internal"})

    def admit(self):
        if self.path not in DEADLINES:
            return self.reply(404, {"error": "not_found"})
        predict = self.server.predict
        if predict is None:
            return self.reply(503, {"status": "loading"})
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            return self.reply(411, {"error": "length_required"})
        if not 0 <= length <= MAX_BODY_BYTES:
            return self.reply(413, {"error": "body_too_large"})
        if not self.server.admitted.acquire(blocking=False):  # never read a body we cannot serve
            return self.reply(503, {"error": "busy"})
        try:
            self.classify(predict, length)
        finally:
            self.server.admitted.release()

    def read_body(self, length):
        deadline = self.started + self.server.read_seconds
        chunks = []
        while length > 0:
            self.connection.settimeout(max(deadline - time.monotonic(), 0.001))
            chunk = self.rfile.read1(min(length, 65536))
            if not chunk:
                raise ConnectionError("body shorter than Content-Length")
            chunks.append(chunk)
            length -= len(chunk)
        self.connection.settimeout(self.timeout)
        self.body_unread = False
        return b"".join(chunks)

    def classify(self, predict, length):
        try:
            body = self.read_body(length)
        except TimeoutError:
            return self.reply(408, {"error": "body_read_timeout"})
        except ConnectionError:
            return self.reply(400, {"error": "body_incomplete"})
        try:
            frames = parse_frames(self.path, body)
        except (ValueError, RecursionError):
            return self.reply(400, {"error": "bad_request"})
        del body
        metrics, workers = self.server.metrics, self.server.workers
        remaining = self.started + self.server.deadlines[self.path] - time.monotonic()
        with metrics.lock:
            metrics.queued += 1
        got_worker = workers.acquire(timeout=max(remaining, 0))
        with metrics.lock:
            metrics.queued -= 1
        if not got_worker:  # media-proxy has given up on this request by now
            return self.reply(503, {"error": "expired"})
        try:
            probabilities = predict(decode(frames))
        except ValueError:
            probabilities = None
        finally:
            workers.release()
        if probabilities is None:
            return self.reply(400, {"error": "bad_request"})
        if self.path == "/predict/image":
            return self.reply(200, {"nsfw_probability": probabilities[0]})
        self.reply(200, {"predictions": [{"nsfw_probability": p} for p in probabilities]})

    def reply(self, status, payload):
        try:
            body = json.dumps(payload, allow_nan=False).encode()
        except ValueError:  # NaN/Infinity is not JSON; media-proxy must see a clean failure
            status, body = 500, b'{"error":"invalid_prediction"}'
        self.send(status, body, "application/json")

    def send(self, status, body, content_type):
        self.replied = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if self.body_unread:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        path = self.path if self.path in LABELLED_PATHS else "other"
        self.server.metrics.observe(path, status, time.monotonic() - self.started)

    def log_request(self, code="-", size="-"):
        # Successes and busy answers are counted in /_metrics; logging each one is pure volume.
        if not (isinstance(code, int) and (200 <= code < 300 or code == 503)):
            super().log_request(code, size)


class Server(ThreadingHTTPServer):
    request_queue_size = 128  # socketserver's default of 5 drops connections in a burst


def make_server(address, predict=None, workers=2, queue=48):
    httpd = Server(address, Handler)
    httpd.predict = predict
    httpd.workers = threading.Semaphore(workers)
    httpd.admitted = threading.BoundedSemaphore(workers + queue)
    httpd.deadlines = dict(DEADLINES)
    httpd.read_seconds = READ_SECONDS
    httpd.metrics = Metrics()
    return httpd


def preprocess(image):
    """OpenNSFW2's YAHOO preprocessing, bit for bit (test_model.py): RGB, bilinear 256 px, a JPEG round trip, centre
    224 px crop, BGR minus the Caffe channel means."""
    import numpy as np

    buf = io.BytesIO()
    image.convert("RGB").resize((256, 256), Image.BILINEAR).save(buf, "JPEG")
    pixels = np.asarray(Image.open(buf), dtype=np.float32)[16:240, 16:240, ::-1]
    return pixels - np.array([104, 117, 123], np.float32)


def load_predictor():
    import numpy as np
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1  # NSFW_WORKERS runs at once, one core each
    session = onnxruntime.InferenceSession(MODEL_PATH, options, providers=["CPUExecutionProvider"])

    def predict(images):
        return session.run(None, {"input": np.stack([preprocess(image) for image in images])})[0][:, 1].tolist()

    for n in range(1, MAX_FRAMES + 1):  # load the model and warm every batch shape before /health is 200
        predict([Image.new("RGB", (64, 64))] * n)
    return predict


def selftest(load=load_predictor):
    try:
        buf = io.BytesIO()
        Image.new("RGB", (256, 256), (40, 120, 200)).save(buf, "JPEG")
        image = open_image({"base64_data": base64.b64encode(buf.getvalue()).decode()})
        probability = load()(decode([image]))[0]
    except Exception:
        traceback.print_exc()
        return 1
    print(f"fluxer-nsfw selftest: p={probability!r}", flush=True)
    return 0 if 0 < probability < 0.5 else 1


def main():
    if sys.argv[1:] == ["--selftest"]:
        sys.exit(selftest())
    workers = int(os.environ.get("NSFW_WORKERS", "2"))
    httpd = make_server(("0.0.0.0", PORT), workers=workers, queue=int(os.environ.get("NSFW_QUEUE", "48")))

    def load():
        try:
            httpd.predict = load_predictor()
            print(f"fluxer-nsfw: model ready on :{PORT}, {workers} workers", flush=True)
        except BaseException:
            traceback.print_exc()
            os._exit(1)  # fail loud: a restart beats a container stuck at 503

    threading.Thread(target=load, daemon=True).start()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
