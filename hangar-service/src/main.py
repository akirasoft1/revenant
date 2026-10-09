"""Container entrypoint: ``python -m src.main`` (listens on ``$PORT``, default 8080)."""
import logging

import uvicorn

from .app import create_app
from .config import load
from .log_redaction import install as install_log_redaction


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    install_log_redaction()   # OAuth callback ?code=&state= never reaches the access log
    config = load()
    uvicorn.run(create_app(config), host="0.0.0.0", port=config.port,
                proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    main()
