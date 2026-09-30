# syntax=docker/dockerfile:1.7

# Python 3.13 matches the training environment (Colab) recorded in docs/ml-results.md.
ARG PYTHON_VERSION=3.13

# ---- builder: resolve and install dependencies into a self-contained venv ----
FROM python:${PYTHON_VERSION}-slim AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
RUN pip install -r requirements.txt

# ---- runtime ----
FROM python:${PYTHON_VERSION}-slim AS runtime
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8001 \
    GIT_PYTHON_REFRESH=quiet \
    MLFLOW_DISABLE_AGENT_HINT=1

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin app
COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app app ./app

USER app
EXPOSE 8001

# Readiness endpoint. The start period covers the model download at startup.
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '8001')}/health\", timeout=2)"]

CMD ["python", "-m", "app"]
