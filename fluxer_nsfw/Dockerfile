# syntax=docker/dockerfile:1.7
# SPDX-License-Identifier: AGPL-3.0-or-later
# Build context is fluxer_nsfw/ (.github/workflows/micup-nsfw-imaj.yml). Contract: README.md.

# Model stage, not shipped: OpenNSFW2 on Keras 3 + JAX -> open_nsfw.onnx (export_onnx.py), which must then score like
# Keras+JAX within 1e-3 in logit (test_model.py) or the build fails. Served by Keras+JAX itself the service peaked at
# 1138 MiB RSS under the CI load smoke, hence onnxruntime at runtime.
FROM python:3.12.15-slim-trixie@sha256:29113dcae7aad06daa8e95260fa09f27d62be33b9687ea3774f771d601a02256 AS model

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KERAS_BACKEND=jax

WORKDIR /build

COPY requirements.txt requirements-model.txt ./
RUN pip install --no-deps --only-binary=:all: --require-hashes -r requirements.txt -r requirements-model.txt

# OpenNSFW2 v0.1.0 release weights (Yahoo open_nsfw, BSD-2), fetched once here and checked.
ADD --chmod=0644 --checksum=sha256:14ca261f48bdd88c1eecba96a761bd1579b523adae1b749b0a4ffd8b7ed8babe \
    https://github.com/bhky/opennsfw2/releases/download/v0.1.0/open_nsfw_weights.h5 open_nsfw_weights.h5

# No network: should the weights path ever drift, opennsfw2 would fetch weights past the checksum above.
COPY server.py export_onnx.py test_model.py ./
RUN --network=none python export_onnx.py open_nsfw_weights.h5 open_nsfw.onnx && python -m unittest -v test_model

FROM python:3.12.15-slim-trixie@sha256:29113dcae7aad06daa8e95260fa09f27d62be33b9687ea3774f771d601a02256

ARG BUILD_VERSION=""
ARG SOURCE_SHA=""
ARG SOURCE_DATE=""

LABEL org.opencontainers.image.title="fluxer-nsfw"
LABEL org.opencontainers.image.description="NSFW image classifier (OpenNSFW2) for fluxer_media_proxy"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
LABEL org.opencontainers.image.version="${BUILD_VERSION}"
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
LABEL org.opencontainers.image.created="${SOURCE_DATE}"
LABEL app.fluxer.build-version="${BUILD_VERSION}"

# NSFW_WORKERS inferences at once, each on a single onnxruntime thread (server.py), matching the compose limit cpus: 2.
# OPENBLAS_NUM_THREADS=1: numpy's OpenBLAS would otherwise start a thread per host core. NSFW_QUEUE: README.md.
# Runs with a read-only root filesystem plus a small /tmp tmpfs, as CI tests it (README.md).
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 \
    NSFW_WORKERS=2 \
    NSFW_QUEUE=48

WORKDIR /srv/nsfw

COPY requirements.txt .
RUN pip install --no-deps --only-binary=:all: --require-hashes -r requirements.txt

# The only model file: no weights download and no network at runtime.
COPY --from=model /build/open_nsfw.onnx .
COPY server.py .

ENV BUILD_VERSION="${BUILD_VERSION}"

USER 65532:65532

EXPOSE 8000

STOPSIGNAL SIGINT

HEALTHCHECK --interval=10s --timeout=3s --start-period=180s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]

CMD ["python", "server.py"]
