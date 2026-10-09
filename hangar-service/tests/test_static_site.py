"""The built hangar-editor SPA served by hangar-service: hashed assets
long-cached, the SPA fallback to index.html (no-cache) for client routes, the
document CSP, /version.txt, reserved API prefixes untouched, and an API that
keeps working when the static directory is missing."""
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.config import load
from src.repository import InMemoryShipRepository
from src.static_site import ASSET_CACHE, NO_CACHE, ROOT_FILE_CACHE, build_csp
from tests.test_app import fake_verifier, make_catalog
from tests.test_app import cfg as _cfg

INDEX = ('<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc123.js"></script>'
         '<link rel="stylesheet" crossorigin href="/assets/index-def456.css"></head>'
         '<body><div id="root"></div></body></html>')


@pytest.fixture
def dist(tmp_path) -> Path:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX)
    (root / "assets" / "index-abc123.js").write_text("console.log('spa')")
    (root / "assets" / "index-def456.css").write_text("body{color:red}")
    (root / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (root / ".hidden").write_text("dotfile")
    (tmp_path / "secret.txt").write_text("TOP-SECRET-OUTSIDE-ROOT")
    return root


def make(static_dir, **env) -> TestClient:
    config = _cfg(HANGAR_STATIC_DIR=str(static_dir), HANGAR_VERSION="abc1234", **env)
    app = create_app(config, catalog=make_catalog(), repository=InMemoryShipRepository(),
                     verifier=fake_verifier, warm=False)
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def client(dist):
    with make(dist) as c:
        yield c


def _is_index(r) -> bool:
    return r.status_code == 200 and r.text == INDEX and r.headers["content-type"].startswith("text/html")


def test_root_serves_index_no_cache_with_csp_and_security_headers(client):
    r = client.get("/")
    assert _is_index(r)
    assert r.headers["cache-control"] == NO_CACHE == "no-cache"
    csp = r.headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "script-src 'self';" in csp
    assert "img-src 'self' https://cdn.discordapp.com data:" in csp
    assert "frame-ancestors 'none'" in csp
    assert "object-src 'none'" in csp and "base-uri 'none'" in csp
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
    assert r.headers["strict-transport-security"].startswith("max-age=")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "vary" not in r.headers or "Cookie" not in r.headers["vary"]


@pytest.mark.parametrize("path", ["/members", "/members/222", "/members/111/ships/abc", "/import",
                                  "/import?member=222", "/no/such/page", "/index.html", "/healthcheck",
                                  "/apiary", "/v1x"])
def test_client_routes_fall_back_to_index(client, path):
    r = client.get(path)
    assert _is_index(r), (path, r.status_code)
    assert r.headers["cache-control"] == "no-cache"
    assert "default-src 'self'" in r.headers["content-security-policy"]


def test_hashed_assets_are_long_cached(client):
    r = client.get("/assets/index-abc123.js")
    assert r.status_code == 200 and r.text == "console.log('spa')"
    assert r.headers["cache-control"] == ASSET_CACHE == "public, max-age=31536000, immutable"
    assert "javascript" in r.headers["content-type"]
    css = client.get("/assets/index-def456.css")
    assert css.headers["cache-control"] == ASSET_CACHE and css.headers["content-type"].startswith("text/css")
    assert r.headers["x-content-type-options"] == "nosniff"


def test_root_files_are_short_cached(client):
    r = client.get("/favicon.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    assert r.headers["cache-control"] == ROOT_FILE_CACHE
    assert "immutable" not in ROOT_FILE_CACHE


@pytest.mark.parametrize("path", ["/assets/index-missing.js", "/assets", "/assets/", "/api/nope", "/api",
                                  "/api/v1/nope", "/v1/nope", "/v1", "/health/x", "/healthz/x"])
def test_reserved_prefixes_never_fall_back_to_index(client, path):
    r = client.get(path)
    assert r.status_code == 404, path
    assert r.json()["error"] == "not_found"


def test_api_routes_are_unchanged(client):
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/healthz").json()["status"] == "ok"
    r = client.get("/api/v1/members")
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"
    assert client.get("/v1/members").status_code == 401
    r = client.post("/members")                                   # writes never hit the SPA
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    assert client.post("/health").status_code == 405           # routing semantics unchanged


@pytest.mark.parametrize("path", ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt",
                                  "/assets/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt", "/.hidden",
                                  "/assets/.%2e/.hidden"])
def test_no_file_outside_the_root_or_dotfile_is_served(client, path):
    r = client.get(path)
    assert "TOP-SECRET" not in r.text and "dotfile" not in r.text
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert _is_index(r)


def test_head_is_served(client):
    r = client.head("/members")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"


def test_version_txt(client):
    r = client.get("/version.txt")
    assert r.status_code == 200 and r.text.strip() == "abc1234"
    assert r.headers["content-type"].startswith("text/plain")
    assert r.headers["cache-control"] == "no-cache"


def test_version_txt_without_static_dir(tmp_path):
    with make(tmp_path / "missing") as c:
        assert c.get("/version.txt").text.strip() == "abc1234"


def test_rum_origins_extend_script_and_connect_src(dist, caplog):
    with caplog.at_level(logging.WARNING):
        with make(dist, HANGAR_RUM_ORIGINS="https://js-cdn.dynatrace.com, https://bf12345abc.bf.dynatrace.com/ "
                                           "javascript:alert(1)") as c:
            csp = c.get("/").headers["content-security-policy"]
    assert "script-src 'self' https://js-cdn.dynatrace.com https://bf12345abc.bf.dynatrace.com;" in csp
    assert "connect-src 'self' https://js-cdn.dynatrace.com https://bf12345abc.bf.dynatrace.com;" in csp
    assert "javascript" not in csp
    assert "HANGAR_RUM_ORIGINS" in caplog.text


def test_build_csp_defaults():
    csp = build_csp(())
    assert csp == ("default-src 'self'; script-src 'self'; style-src 'self'; "
                   "img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; font-src 'self'; "
                   "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def test_missing_static_dir_keeps_the_api_working_and_logs_once(tmp_path, caplog):
    with caplog.at_level(logging.WARNING):
        with make(tmp_path / "nope") as c:
            assert c.get("/health").json()["status"] == "ok"
            r = c.get("/")
            assert r.status_code == 404 and r.json()["error"] == "not_found"
            assert c.get("/members").status_code == 404
            assert c.get("/api/v1/members").status_code == 401
    assert caplog.text.count("web editor NOT served") == 1


def test_static_dir_without_index_counts_as_missing(tmp_path):
    (tmp_path / "empty").mkdir()
    with make(tmp_path / "empty") as c:
        assert c.get("/").status_code == 404


def test_config_static_dir_and_rum_defaults():
    c = load({})
    assert c.static_dir.endswith("hangar-editor/dist")
    assert c.rum_origins == ()
    c = load({"HANGAR_STATIC_DIR": " /app/static ", "HANGAR_RUM_ORIGINS": "https://A.example.com:443 x"})
    assert c.static_dir == "/app/static"
    assert c.rum_origins == ("https://a.example.com",)
    assert c.rum_origin_problems == ("x",)
