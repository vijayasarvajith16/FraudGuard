"""Entrypoint: `python -m app`. One process per container; scale with replicas."""

import uvicorn

from .config import load_settings
from .logging_setup import configure_logging
from .main import create_app


def main() -> None:
    settings = load_settings()
    configure_logging(settings.service_name, settings.log_level)
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",  # all interfaces inside the container; only the internal network reaches it
        port=settings.port,
        log_config=None,  # keep the JSON logging configured above
        access_log=False,
        loop="auto",
        http="auto",
        timeout_graceful_shutdown=10,
    )


if __name__ == "__main__":
    main()
