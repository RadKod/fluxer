# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build stage only (Dockerfile): OpenNSFW2's Keras 3 model and weights -> open_nsfw.onnx for onnxruntime.

Keras' own model.export(format="onnx") goes through jax2onnx, which pulls ~17 more build packages and writes the
max pool as a 4-D MaxPool that onnxruntime rejects ("Unsupported pooling size"). The model uses only the layer types
below, so they are written out directly, NCHW, from the built Keras model (topology and weights as Keras loaded them).
Any other layer or option stops the build. test_model.py then holds the result to Keras+JAX within 1e-3 in logit.

  python export_onnx.py open_nsfw_weights.h5 open_nsfw.onnx
"""

import sys

import numpy as np
import onnx
import opennsfw2
from onnx import TensorProto, helper, numpy_helper

PADDING = {"same": "SAME_UPPER", "valid": "VALID"}  # Keras/XLA "same" puts the odd pixel at the end, as SAME_UPPER


def convert(model):
    nodes = [helper.make_node("Transpose", ["input"], ["nchw"], perm=[0, 3, 1, 2])]
    weights = []
    names = {id(model.input): "nchw"}

    def const(name, value, dtype=np.float32):
        weights.append(numpy_helper.from_array(np.asarray(value, dtype), name))
        return name

    def require(ok, what):  # not assert: python -O drops asserts
        if not ok:
            raise SystemExit(f"export_onnx.py: layer {layer.name} ({kind}): {what} is not supported")

    for layer in model.layers[1:]:
        kind, config, w = type(layer).__name__, layer.get_config(), layer.get_weights()
        data_format = config.get("data_format", "channels_last")
        require(data_format == "channels_last", f"data_format {data_format}")
        inputs = [names[id(t)] for t in (layer.input if isinstance(layer.input, list) else [layer.input])]
        out = names[id(layer.output)] = layer.name
        if kind == "ZeroPadding2D":
            (top, bottom), (left, right) = config["padding"]
            pads = const(f"{out}.pads", [0, 0, top, left, 0, 0, bottom, right], np.int64)
            nodes.append(helper.make_node("Pad", [inputs[0], pads], [out]))
        elif kind == "Conv2D":
            require(config["dilation_rate"] == (1, 1), "dilation")
            require(config["groups"] == 1, "groups")
            require(config["activation"] == "linear", "a fused activation")
            kernel, bias = w  # HWIO -> OIHW
            nodes.append(helper.make_node(
                "Conv", [inputs[0], const(f"{out}.w", kernel.transpose(3, 2, 0, 1)), const(f"{out}.b", bias)], [out],
                kernel_shape=kernel.shape[:2], strides=config["strides"], auto_pad=PADDING[config["padding"]]))
        elif kind == "BatchNormalization":
            require(config["center"] and config["scale"], "center/scale off")
            require(config["axis"] in (-1, 3), f"axis {config['axis']}")
            gamma, beta, mean, variance = (const(f"{out}.{i}", v) for i, v in enumerate(w))
            nodes.append(helper.make_node("BatchNormalization", [inputs[0], gamma, beta, mean, variance], [out],
                                          epsilon=config["epsilon"]))
        elif kind == "Activation":
            op = {"relu": "Relu", "softmax": "Softmax"}[config["activation"]]
            nodes.append(helper.make_node(op, inputs, [out], **({"axis": -1} if op == "Softmax" else {})))
        elif kind == "MaxPooling2D":
            nodes.append(helper.make_node("MaxPool", inputs, [out], kernel_shape=config["pool_size"],
                                          strides=config["strides"], auto_pad=PADDING[config["padding"]]))
        elif kind == "Add":
            nodes.append(helper.make_node("Add", inputs, [out]))
        elif kind == "GlobalAveragePooling2D":
            require(not config["keepdims"], "keepdims")
            nodes.append(helper.make_node("GlobalAveragePool", inputs, [f"{out}.4d"]))
            nodes.append(helper.make_node("Flatten", [f"{out}.4d"], [out]))
        elif kind == "Dense":
            require(config["activation"] == "linear", "a fused activation")
            nodes.append(helper.make_node("Gemm", [inputs[0], const(f"{out}.w", w[0]), const(f"{out}.b", w[1])], [out]))
        else:
            raise SystemExit(f"export_onnx.py: layer {layer.name} ({kind}) is not supported")

    graph = helper.make_graph(
        nodes, "opennsfw2", [helper.make_tensor_value_info("input", TensorProto.FLOAT, ["batch", 224, 224, 3])],
        [helper.make_tensor_value_info(names[id(model.output)], TensorProto.FLOAT, ["batch", 2])], weights)
    # IR 8 is opset 17's (onnx 1.12); onnx's own default IR can be newer than onnxruntime reads.
    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8,
                                   producer_name="fluxer-nsfw")
    onnx.checker.check_model(onnx_model, full_check=True)
    return onnx_model


if __name__ == "__main__":
    onnx.save(convert(opennsfw2.make_open_nsfw_model(weights_path=sys.argv[1])), sys.argv[2])
