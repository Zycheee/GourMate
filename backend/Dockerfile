# syntax=docker/dockerfile:1.7
#
# GourMate (ChefSight) backend — CPU-only image (no GPU, no CUDA wheels).
#
# Build context is the REPOSITORY ROOT. Fly.io does not change the Docker
# context when `[build] dockerfile` is set, so paths below are prefixed with
# `backend/`. Build locally with:
#
#   docker build -f backend/Dockerfile -t gourmate-api .
#
# Secrets are never baked into this image. GEMINI_API_KEY is injected at
# runtime only, via Fly secrets (`fly secrets set GEMINI_API_KEY`).

# ---------------------------------------------------------------------------
# Stage 1 — builder: install runtime deps into an isolated virtualenv.
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Self-contained venv copied wholesale into the runtime stage.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN pip install --upgrade pip

# faster-whisper (ctranslate2) and silero-vad both depend on PyTorch. The
# default PyPI wheels bundle CUDA/NCCL and are multi-GB; install the CPU-only
# build first so the resolver treats it as satisfied and the image stays small.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio

# Application runtime dependencies.
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# ---------------------------------------------------------------------------
# Stage 2 — runtime: slim image, venv only, non-root user.
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# HF_HOME points at the Fly volume mount so whisper + silero weights are cached
# across machine restarts (architecture §13).
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/data/hf \
    PATH="/opt/venv/bin:${PATH}"

# libgomp1 is the OpenMP runtime required by ctranslate2 / PyTorch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. /data/hf is pre-created and owned by appuser so the
# model cache is writable; the Fly volume mounted at /data inherits this
# ownership on first deploy.
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /data/hf \
    && chown -R appuser:appuser /data

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=appuser:appuser backend/app ./app

USER appuser

EXPOSE 8080

# Readiness probe mirrors Fly's http_service check (architecture §8).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4).status == 200 else 1)"]

# `--ws websockets` matches backend/README.md.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--ws", "websockets"]
