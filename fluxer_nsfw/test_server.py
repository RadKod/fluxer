# SPDX-License-Identifier: AGPL-3.0-or-later
"""Contract tests: fluxer_media_proxy/src/nsfw.rs is the client. Run: python -m unittest fluxer_nsfw/test_server.py"""

import base64
import http.client
import io
import json
import os
import socket
import sys
import threading
import time
import unittest

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

# Deliberately not round numbers: a rounded reply would turn a clean frame into 0.
PROBABILITIES = [0.123456789012345, 1.2345e-07, 0.987654321]
FRAME_LIMIT = 1024 * 1024  # nsfw.rs NSFW_MAX_FRAME_BYTES


def image_bytes(size=(64, 48), color=(40, 120, 200), fmt="JPEG", pad_to=None):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, fmt)
    data = buf.getvalue()
    return data + b"\0" * (pad_to - len(data)) if pad_to else data


def frame(**kwargs):
    return {"base64_data": base64.b64encode(image_bytes(**kwargs)).decode()}


class FakePredictor:
    def __init__(self, result=None, error=None):
        self.calls = []
        self.result = result
        self.error = error

    def __call__(self, images):
        self.calls.append(images)
        if self.error:
            raise self.error
        return self.result or PROBABILITIES[: len(images)]


class BlockingPredictor:
    def __init__(self):
        self.calls = 0
        self.started = threading.Semaphore(0)
        self.release = threading.Event()

    def __call__(self, images):
        self.calls += 1
        self.started.release()
        self.release.wait(10)
        return [0.25] * len(images)


class ServerTest(unittest.TestCase):
    workers, queue = 2, 4

    def setUp(self):
        self.predict = FakePredictor()
        self.httpd = server.make_server(("127.0.0.1", 0), self.predict, self.workers, self.queue)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def connect(self):
        conn = http.client.HTTPConnection(*self.httpd.server_address, timeout=10)
        self.addCleanup(conn.close)
        return conn

    def call(self, method, path, body=None, conn=None, full=False):
        conn = conn or self.connect()
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        conn.request(method, path, body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = resp.read()
        parsed = json.loads(data) if resp.getheader("Content-Type") == "application/json" else data.decode()
        return (resp.status, parsed, resp) if full else (resp.status, parsed)

    def raw(self, *head, body=b""):
        """Send hand-written request headers (and maybe a short body), return the response."""
        conn = self.connect()
        conn.putrequest("POST", "/predict/image")
        for name, value in head:
            conn.putheader(name, value)
        conn.endheaders()
        if body:
            conn.send(body)
        resp = conn.getresponse()
        resp.read()
        return resp

    def metric_lines(self):
        return self.call("GET", "/_metrics")[1].splitlines()


class ContractTest(ServerTest):
    def test_single_image_reply_matches_nsfw_rs_and_is_not_rounded(self):
        status, body = self.call("POST", "/predict/image", frame())
        self.assertEqual(200, status)
        self.assertEqual({"nsfw_probability": PROBABILITIES[0]}, body)
        self.assertEqual(1, len(self.predict.calls[0]))
        self.assertIsInstance(self.predict.calls[0][0], Image.Image)

    def test_batch_reply_keeps_frame_order_and_tiny_probabilities(self):
        frames = [frame(color=c) for c in ((40, 120, 200), (90, 160, 60), (128, 128, 128))]
        status, body = self.call("POST", "/predict/images", {"images": frames})
        self.assertEqual(200, status)
        self.assertEqual({"predictions": [{"nsfw_probability": p} for p in PROBABILITIES]}, body)
        self.assertEqual(3, len(self.predict.calls[0]))

    def test_batch_accepts_one_and_two_frames(self):
        for n in (1, 2):
            status, body = self.call("POST", "/predict/images", {"images": [frame()] * n})
            self.assertEqual(200, status)
            self.assertEqual(n, len(body["predictions"]))

    def test_media_proxy_frame_size_is_accepted(self):
        # nsfw_processing/mod.rs NSFW_FRAME_MAX_DIMENSION = 512
        self.assertEqual(200, self.call("POST", "/predict/image", frame(size=(512, 288)))[0])

    def test_batch_frame_count_outside_one_to_three_is_400(self):
        for n in (0, 4):
            status, _ = self.call("POST", "/predict/images", {"images": [frame()] * n})
            self.assertEqual(400, status, n)
        self.assertEqual([], self.predict.calls)

    def test_malformed_requests_are_400(self):
        truncated = image_bytes(size=(256, 256))[:300]
        cases = [
            ("/predict/image", "not json"),
            ("/predict/image", "[" * 100_000),  # RecursionError in json, still a bad request
            ("/predict/image", []),
            ("/predict/image", {}),
            ("/predict/image", {"base64_data": 5}),
            ("/predict/image", {"base64_data": "@@not-base64@@"}),
            ("/predict/image", {"base64_data": base64.b64encode(b"plain text, not an image").decode()}),
            ("/predict/image", {"base64_data": ""}),
            ("/predict/image", frame(fmt="BMP")),
            ("/predict/image", {"base64_data": base64.b64encode(truncated).decode()}),
            ("/predict/images", {}),
            ("/predict/images", {"images": "x"}),
            ("/predict/images", {"images": [frame(), {"other": 1}]}),
            ("/predict/images", {"images": [frame(), {"base64_data": "AAAA"}]}),
        ]
        for path, body in cases:
            status, _ = self.call("POST", path, body)
            self.assertEqual(400, status, (path, str(body)[:80]))
        self.assertEqual([], self.predict.calls)

    def test_oversized_dimensions_are_400(self):
        status, _ = self.call("POST", "/predict/image", frame(size=(server.MAX_SIDE + 1, 8), fmt="PNG"))
        self.assertEqual(400, status)

    def test_unknown_paths_are_404(self):
        for method, path in (("POST", "/predict"), ("POST", "/health"), ("GET", "/predict/image"), ("GET", "/")):
            status, _ = self.call(method, path, frame() if method == "POST" else None)
            self.assertEqual(404, status, (method, path))

    def test_health_is_503_until_the_model_is_loaded(self):
        self.httpd.predict = None
        self.assertEqual(503, self.call("GET", "/health")[0])
        self.assertEqual(503, self.call("POST", "/predict/image", frame())[0])
        self.httpd.predict = self.predict
        self.assertEqual((200, {"status": "ok"}), self.call("GET", "/health"))

    def test_non_finite_prediction_is_500_never_invalid_json(self):
        self.httpd.predict = FakePredictor(result=[float("nan")])
        self.assertEqual(500, self.call("POST", "/predict/image", frame())[0])

    def test_predictor_failure_is_500_and_counted_never_a_dropped_connection(self):
        self.httpd.predict = FakePredictor(error=RuntimeError("model exploded"))
        self.assertEqual(500, self.call("POST", "/predict/image", frame())[0])
        self.assertIn('fluxer_nsfw_requests_total{path="/predict/image",code="500"} 1', self.metric_lines())


class ConnectionTest(ServerTest):
    def test_connection_is_kept_alive_across_requests(self):
        conn = self.connect()
        self.assertEqual(200, self.call("POST", "/predict/image", frame(), conn)[0])
        sock = conn.sock
        self.assertIsNotNone(sock, "server closed a keep-alive connection")
        self.assertEqual(400, self.call("POST", "/predict/image", {}, conn)[0])
        self.assertEqual(200, self.call("GET", "/health", conn=conn)[0])
        self.assertIs(sock, conn.sock)

    def test_answers_that_leave_the_body_unread_close_the_connection(self):
        _, _, not_found = self.call("POST", "/nope", frame(), full=True)
        self.assertEqual((404, "close"), (not_found.status, not_found.getheader("Connection")))
        self.httpd.predict = None
        _, _, loading = self.call("POST", "/predict/image", frame(), full=True)
        self.assertEqual((503, "close"), (loading.status, loading.getheader("Connection")))

    def test_missing_content_length_is_411(self):
        resp = self.raw(("Content-Type", "application/json"))
        self.assertEqual((411, "close"), (resp.status, resp.getheader("Connection")))

    def test_body_shorter_than_content_length_times_out_within_the_total_read_deadline(self):
        self.httpd.read_seconds = 0.3
        start = time.monotonic()
        resp = self.raw(("Content-Length", "1000"), body=b'{"base64_data": "')
        self.assertEqual((408, "close"), (resp.status, resp.getheader("Connection")))
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(200, self.call("POST", "/predict/image", frame())[0])  # admission slot was released

    def test_trickling_body_cannot_extend_the_read_deadline(self):
        self.httpd.read_seconds = 0.5
        payload = json.dumps(frame()).encode()
        sock = socket.create_connection(self.httpd.server_address, timeout=10)
        self.addCleanup(sock.close)
        sock.sendall(b"POST /predict/image HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(payload))

        def trickle():  # one byte every 50 ms for 3 s: a per-recv timeout would never fire
            try:
                for byte in payload[:60]:
                    sock.sendall(bytes([byte]))
                    time.sleep(0.05)
            except OSError:
                pass  # server gave up and closed

        threading.Thread(target=trickle, daemon=True).start()
        start = time.monotonic()
        timed_out = 'fluxer_nsfw_requests_total{path="/predict/image",code="408"} 1'
        while timed_out not in self.metric_lines():
            self.assertLess(time.monotonic() - start, 2, "trickling client kept the request open")
            time.sleep(0.05)


class SizeLimitTest(ServerTest):
    def test_three_maximum_frames_fit_the_body_limit(self):
        frames = [frame(pad_to=FRAME_LIMIT) for _ in range(3)]
        body = json.dumps({"images": frames}).encode()
        self.assertGreater(len(body), 4 * 1024 * 1024)
        self.assertLessEqual(len(body), server.MAX_BODY_BYTES)
        self.assertEqual(200, self.call("POST", "/predict/images", body)[0])

    def test_frame_over_1_mib_is_400(self):
        self.assertEqual(400, self.call("POST", "/predict/image", frame(pad_to=FRAME_LIMIT + 1))[0])
        self.assertEqual([], self.predict.calls)

    def test_body_at_the_limit_is_read_and_one_byte_more_is_413(self):
        self.assertGreaterEqual(server.MAX_BODY_BYTES, 4.5 * 1024 * 1024)
        payload = json.dumps(frame()).encode()
        status, _ = self.call("POST", "/predict/image", payload + b" " * (server.MAX_BODY_BYTES - len(payload)))
        self.assertEqual(200, status)
        resp = self.raw(("Content-Length", str(server.MAX_BODY_BYTES + 1)))
        self.assertEqual((413, "close"), (resp.status, resp.getheader("Connection")))


class QueueTest(ServerTest):
    workers, queue = 1, 1

    def send_in_background(self, results):
        thread = threading.Thread(target=lambda: results.append(self.call("POST", "/predict/image", frame())[0]))
        thread.start()
        return thread

    def test_full_queue_answers_503_at_once_and_metrics_show_the_queue(self):
        blocking = self.httpd.predict = BlockingPredictor()
        results = []
        running = self.send_in_background(results)
        self.assertTrue(blocking.started.acquire(timeout=5))
        queued = self.send_in_background(results)
        deadline = time.monotonic() + 5
        while "fluxer_nsfw_queue_depth 1" not in self.metric_lines():
            self.assertLess(time.monotonic(), deadline, "second request never queued")
            time.sleep(0.02)

        start = time.monotonic()
        _, _, busy = self.call("POST", "/predict/image", frame(), full=True)
        self.assertEqual((503, "close"), (busy.status, busy.getheader("Connection")))
        self.assertLess(time.monotonic() - start, 1)

        blocking.release.set()
        running.join(5)
        queued.join(5)
        self.assertEqual([200, 200], results)
        self.assertIn("fluxer_nsfw_queue_depth 0", self.metric_lines())

    def test_request_queued_past_its_deadline_is_dropped_with_503_before_predict(self):
        self.assertEqual({"/predict/image": 4.5, "/predict/images": 14.5}, server.DEADLINES)  # nsfw.rs 5 s / 15 s
        self.httpd.deadlines["/predict/image"] = 0.3
        blocking = self.httpd.predict = BlockingPredictor()
        results = []
        running = self.send_in_background(results)
        self.assertTrue(blocking.started.acquire(timeout=5))
        start = time.monotonic()
        self.assertEqual(503, self.call("POST", "/predict/image", frame())[0])
        self.assertLess(time.monotonic() - start, 2)
        blocking.release.set()
        running.join(5)
        self.assertEqual([200], results)
        self.assertEqual(1, blocking.calls)


class MetricsTest(ServerTest):
    def test_metrics_count_requests_by_path_and_code_with_latency_histogram(self):
        self.call("POST", "/predict/image", frame())
        self.call("POST", "/predict/images", {"images": "x"})
        self.call("POST", "/nope", frame())
        lines = self.metric_lines()
        for line in (
            'fluxer_nsfw_requests_total{path="/predict/image",code="200"} 1',
            'fluxer_nsfw_requests_total{path="/predict/images",code="400"} 1',
            'fluxer_nsfw_requests_total{path="other",code="404"} 1',
            'fluxer_nsfw_request_seconds_bucket{path="/predict/image",le="+Inf"} 1',
            'fluxer_nsfw_request_seconds_count{path="/predict/image"} 1',
            "fluxer_nsfw_queue_depth 0",
            "# TYPE fluxer_nsfw_request_seconds histogram",
        ):
            self.assertIn(line, lines)


class SelftestTest(unittest.TestCase):
    def test_selftest_passes_only_for_a_low_nonzero_score(self):
        for score, code in ((0.02, 0), (0.0, 1), (0.9, 1)):
            self.assertEqual(code, server.selftest(lambda: FakePredictor(result=[score])), score)

    def test_selftest_fails_when_the_model_cannot_load(self):
        def broken():
            raise OSError("weights missing")

        self.assertEqual(1, server.selftest(broken))


if __name__ == "__main__":
    unittest.main()
