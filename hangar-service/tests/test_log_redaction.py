"""The OAuth callback's query (?code=...&state=...) must never reach the access log."""
import logging

from src.log_redaction import RedactOAuthQuery, install


def _access_record(path):
    # uvicorn.access: '%s - "%s %s HTTP/%s" %d' % (client, method, path, version, status)
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             '%s - "%s %s HTTP/%s" %d', ("1.2.3.4:5", "GET", path, "1.1", 302), None)


def test_callback_query_redacted():
    rec = _access_record("/api/auth/callback?code=SECRETCODE&state=SECRETSTATE")
    assert RedactOAuthQuery().filter(rec) is True
    msg = rec.getMessage()
    assert "SECRETCODE" not in msg and "SECRETSTATE" not in msg
    assert "/api/auth/callback?<redacted>" in msg


def test_other_paths_untouched():
    rec = _access_record("/api/v1/catalog/vehicles?q=harbinger")
    RedactOAuthQuery().filter(rec)
    assert "/api/v1/catalog/vehicles?q=harbinger" in rec.getMessage()
    rec = _access_record("/api/auth/callback")
    RedactOAuthQuery().filter(rec)
    assert '"GET /api/auth/callback HTTP/1.1"' in rec.getMessage()


def test_any_record_with_callback_query_in_message_is_redacted():
    rec = logging.LogRecord("x", logging.INFO, __file__, 1,
                            "GET /api/auth/callback?code=ABC&state=DEF done", None, None)
    RedactOAuthQuery().filter(rec)
    assert "ABC" not in rec.getMessage() and "DEF" not in rec.getMessage()


def test_install_attaches_to_uvicorn_access_once():
    lg = logging.getLogger("uvicorn.access")
    before = list(lg.filters)
    try:
        install()
        install()
        assert sum(isinstance(f, RedactOAuthQuery) for f in lg.filters) == 1
    finally:
        lg.filters[:] = before
