# SPDX-License-Identifier: AGPL-3.0-or-later
"""The served model against the original: server.py (onnxruntime) must score like OpenNSFW2 on Keras 3 + JAX.
Runs in the Dockerfile's model stage, the only place both stacks are installed, after export_onnx.py. Synthetic
images only. Locally: cd fluxer_nsfw && KERAS_BACKEND=jax python -m unittest test_model
"""

import os
import sys
import unittest
from unittest import mock

import numpy as np
import opennsfw2
from PIL import Image

import export_onnx
import server

WEIGHTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "open_nsfw_weights.h5")


def images():
    rng = np.random.default_rng(1)
    y, x = np.mgrid[0:288, 0:512]
    testsrc = np.array([(255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0), (255, 0, 255), (255, 0, 0),
                        (0, 0, 255), (0, 0, 0)], np.uint8)[x * 8 // 512]  # ffmpeg testsrc-like: colour bars ...
    testsrc[144:] = np.stack([x, y, x ^ y], -1)[144:] % 256  # ... over gradients and a pattern
    return [
        Image.new("RGB", (512, 512), (40, 120, 200)),  # the selftest frame
        Image.new("RGB", (512, 288), (255, 255, 255)),
        Image.new("RGB", (64, 64), (0, 0, 0)),  # upscaled
        Image.new("L", (300, 200), 128),  # not RGB: converted first
        Image.fromarray(rng.integers(0, 256, (512, 512, 3), dtype=np.uint8)),
        Image.fromarray(testsrc),
        Image.fromarray(testsrc).convert("CMYK"),
    ]


class ModelTest(unittest.TestCase):
    def test_preprocessing_is_opennsfw2_yahoo_bit_for_bit(self):
        for image in images():
            np.testing.assert_array_equal(opennsfw2.preprocess_image(image), server.preprocess(image), image.mode)

    def test_export_stops_on_layer_options_it_does_not_write(self):
        import keras

        for layer in (keras.layers.Conv2D(2, 3, dilation_rate=2),
                      keras.layers.Conv2D(2, 3, data_format="channels_first"),
                      keras.layers.MaxPooling2D(2, data_format="channels_first"),
                      keras.layers.Dense(2, activation="relu")):
            inputs = keras.Input((8, 8, 3))
            with self.assertRaises(SystemExit, msg=layer.get_config()):  # not assert: python -O would drop it
                export_onnx.convert(keras.Model(inputs, layer(inputs)))

    def test_probabilities_match_keras_jax_within_1e_3_logit_in_server_batches(self):
        frames = images()
        keras = opennsfw2.predict_images(frames, weights_path=WEIGHTS)
        with mock.patch.dict(sys.modules, {"keras": None, "jax": None, "opennsfw2": None}):  # the image has none
            predict = server.load_predictor()
            batches = [frames[i: i + server.MAX_FRAMES] for i in range(0, len(frames), server.MAX_FRAMES)]  # 3, 3, 1
            served = [p for batch in batches for p in predict(batch)]
        print(f"\nkeras+jax {np.array(keras)}\nonnx      {np.array(served)}")
        self.assertTrue(all(isinstance(p, float) for p in served))
        # Logit scale: 1e-3 there is tighter than 1e-3 on p everywhere (|dp| <= p(1-p)|dlogit|), and unlike an absolute
        # bound on p it still sees a shift at p ~ 0.001, where every frame of a clean scan sits.
        logit = lambda p: np.log(np.array(p)) - np.log1p(-np.array(p))  # noqa: E731
        np.testing.assert_allclose(logit(served), logit(keras), rtol=0, atol=1e-3)


if __name__ == "__main__":
    unittest.main()
