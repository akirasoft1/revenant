"""Keep OAuth callback secrets out of logs.

Discord redirects the browser to ``/api/auth/callback?code=<code>&state=<state>``;
uvicorn's access log would print that query verbatim. ``RedactOAuthQuery``
replaces the query of any ``/api/auth/callback`` URL with ``<redacted>`` --
nothing else in the record is shortened (logs are never truncated).
"""
import logging
import re

CALLBACK_PATH = "/api/auth/callback"
_CALLBACK_QUERY = re.compile(re.escape(CALLBACK_PATH) + r"\?[^\s\"']*")
_REPLACEMENT = CALLBACK_PATH + "?<redacted>"


def _scrub(value):
    if isinstance(value, str) and CALLBACK_PATH + "?" in value:
        return _CALLBACK_QUERY.sub(_REPLACEMENT, value)
    return value


class RedactOAuthQuery(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _scrub(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_scrub(a) for a in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: _scrub(v) for k, v in record.args.items()}
        return True


def install(logger_names=("uvicorn.access", "uvicorn.error")) -> None:
    for name in logger_names:
        lg = logging.getLogger(name)
        if not any(isinstance(f, RedactOAuthQuery) for f in lg.filters):
            lg.addFilter(RedactOAuthQuery())
