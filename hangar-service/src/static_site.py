"""Serving the built hangar-editor SPA (``hangar-editor/dist``) from hangar-service.

The load balancer sends EVERY path of https://hangar.aklabs.io to this Cloud Run
service (a public GCS bucket is impossible under the org's domain-restricted
sharing policy), so the service serves the editor as well as the API:

* ``/assets/*`` -- Vite's content-hashed bundles: ``Cache-Control: public,
  max-age=31536000, immutable`` (a new build gets new names).
* other real files at the root (``favicon.svg``) -- short cache, not hashed.
* any other GET/HEAD that is not under a reserved prefix (``/api``, ``/v1``,
  ``/health``, ``/healthz``, ``/assets``) -> ``index.html`` with
  ``Cache-Control: no-cache`` so client routes (``/members/…``, ``/import``)
  work on reload and a deploy is picked up on the next navigation.
* the SPA document carries a Content-Security-Policy (``build_csp``).

The fallback hooks the router's 404 instead of registering a catch-all route,
so routing semantics of the API are unchanged (an unknown ``/v1`` path is
still a JSON 404, ``POST /health`` still a 405). A missing static directory
(or one without ``index.html``) leaves the API fully working: the editor
paths answer the JSON 404 and one WARNING is logged.
"""
import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi.responses import FileResponse, Response

log = logging.getLogger(__name__)

ASSET_CACHE = "public, max-age=31536000, immutable"
ROOT_FILE_CACHE = "public, max-age=3600"
NO_CACHE = "no-cache"
# Never answered with index.html: API, health probes and the hashed assets
# (a missing bundle must 404, not return HTML with a JS content type expected).
RESERVED_PREFIXES = ("/api", "/v1", "/health", "/healthz", "/assets")
# Discord avatars (``/api/me`` avatarUrl) are the only off-origin images.
AVATAR_ORIGIN = "https://cdn.discordapp.com"


def build_csp(rum_origins: tuple[str, ...]) -> str:
    """CSP for the SPA document. Vite's build has no inline script or style
    (one module script + one stylesheet, both same-origin; React sets styles
    through the CSSOM, which CSP does not govern), so no 'unsafe-inline'.
    ``rum_origins`` (``HANGAR_RUM_ORIGINS``: the Dynatrace RUM script CDN and
    beacon origins) are allowed for scripts and beacons only when configured."""
    extra = "".join(f" {o}" for o in rum_origins)
    return "; ".join([
        "default-src 'self'",
        f"script-src 'self'{extra}",
        "style-src 'self'",
        f"img-src 'self' {AVATAR_ORIGIN} data:",
        f"connect-src 'self'{extra}",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ])


def is_reserved(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in RESERVED_PREFIXES)


class StaticSite:
    def __init__(self, static_dir: str, csp: str) -> None:
        self.csp = csp
        self.root: Path | None = None
        self.index: bytes | None = None
        root = Path(static_dir) if static_dir else None
        index = root / "index.html" if root else None
        if root is None or index is None or not index.is_file():
            log.warning("hangar: web editor NOT served -- static dir %r has no index.html (the API is "
                        "unaffected; set HANGAR_STATIC_DIR or build hangar-editor)", static_dir)
            return
        self.root = root.resolve()
        self.index = index.read_bytes()
        log.info("hangar: serving the web editor from %s", self.root)

    @property
    def available(self) -> bool:
        return self.index is not None

    def index_response(self) -> Response:
        return Response(self.index, media_type="text/html; charset=utf-8",
                        headers={"Cache-Control": NO_CACHE, "Content-Security-Policy": self.csp})

    def _file(self, path: str) -> Path | None:
        """The real file under the root for a request path, or None. Dot
        segments, dotfiles and anything resolving outside the root are refused."""
        rel = unquote(path).lstrip("/")
        if not rel or "\x00" in rel or "\\" in rel:
            return None
        parts = rel.split("/")
        if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
            return None
        candidate = (self.root / rel).resolve()
        if not candidate.is_relative_to(self.root) or not candidate.is_file():
            return None
        return candidate

    def response(self, path: str) -> Response | None:
        """The response for a GET/HEAD the API router did not match, or None
        (-> the normal JSON 404)."""
        if not self.available:
            return None
        if path in ("/", "/index.html"):
            return self.index_response()
        f = self._file(path)
        if f is not None:
            cache = ASSET_CACHE if path.startswith("/assets/") else ROOT_FILE_CACHE
            return FileResponse(f, headers={"Cache-Control": cache})
        if is_reserved(path) or is_reserved(unquote(path)):
            return None
        return self.index_response()
