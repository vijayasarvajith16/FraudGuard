# syntax=docker/dockerfile:1.7

# Python 3.13 matches the training environment (Colab) recorded in docs/ml-results.md.
ARG PYTHON_VERSION=3.13

# ---- builder: resolve and install dependencies into a self-contained venv ----
FROM python:${PYTHON_VERSION}-slim AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
# The venv gets no pip of its own: the builder's pip installs into it (pip vendors libraries with
# CVEs, and nothing needs it at runtime).
RUN python -m venv --without-pip /opt/venv
COPY requirements.txt .
RUN python -m pip --python /opt/venv/bin/python install -r requirements.txt

# ---- runtime ----
FROM python:${PYTHON_VERSION}-slim AS runtime
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8002 \
    GIT_PYTHON_REFRESH=quiet \
    MLFLOW_DISABLE_AGENT_HINT=1

# Security updates for the base packages; XGBoost's Linux wheel links against the system OpenMP
# runtime; no pip at runtime (see the builder).
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/local/bin/python -m pip uninstall -y -q pip \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin app
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app app ./app

USER app
EXPOSE 8002

# Readiness endpoint. The start period covers the model download at startup.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '8002')}/health\", timeout=2)"]

CMD ["python", "-m", "app"]
