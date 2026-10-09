"""Container entrypoint: ``python -m src.main`` (listens on ``$PORT``, default 8080)."""
import logging

import uvicorn

from .app import create_app
from .config import load


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load()
    uvicorn.run(create_app(config), host="0.0.0.0", port=config.port,
                proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    main()
