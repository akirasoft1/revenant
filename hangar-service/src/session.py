"""Signed browser-session and OAuth-state cookies (web editor).

Both are itsdangerous ``URLSafeTimedSerializer`` tokens -- HMAC-signed (not
encrypted) JSON with an embedded timestamp -- keyed by ``HANGAR_SESSION_KEY``
and separated by salt, so a state token can never be replayed as a session
and vice versa. There is no server-side session store: a cookie is valid
while its signature verifies and it is younger than its max age.

The session carries only public Discord profile fields
(``{discordId, username, globalName, avatar, iat}``).

Rotation / revocation: ``previous_keys`` (``HANGAR_SESSION_KEY_PREVIOUS``) are
accepted for verification while the current key signs everything new;
``not_before`` (``HANGAR_SESSION_NOT_BEFORE``, unix seconds) rejects every
session issued before it -- a global "log everyone out" without a key change.
"""
import re
import time
from dataclasses import dataclass, field
from typing import Callable

from itsdangerous import BadData, URLSafeTimedSerializer
from itsdangerous.timed import TimestampSigner

# ``__Host-`` prefix: the browser only accepts these cookies with Secure,
# Path=/ and no Domain, so a sibling subdomain can never set or shadow them.
SESSION_COOKIE = "__Host-hangar_session"
OAUTH_STATE_COOKIE = "__Host-hangar_oauth_state"
SESSION_MAX_AGE_S = 30 * 24 * 3600
OAUTH_STATE_MAX_AGE_S = 600
NEXT_PATH_MAX = 512

_SESSION_SALT = "hangar-session-v1"
_STATE_SALT = "hangar-oauth-state-v1"
_SNOWFLAKE = re.compile(r"^[0-9]{1,32}$")
_CDN = "https://cdn.discordapp.com"


class InvalidSession(Exception):
    """Missing, tampered, expired or malformed token."""


@dataclass(frozen=True)
class SessionUser:
    discord_id: str
    username: str
    global_name: str | None
    avatar: str | None
    iat: int | None = field(default=None, compare=False)

    @property
    def display_name(self) -> str:
        return self.global_name or self.username

    @property
    def avatar_url(self) -> str:
        if self.avatar:
            ext = "gif" if self.avatar.startswith("a_") else "png"
            return f"{_CDN}/avatars/{self.discord_id}/{self.avatar}.{ext}"
        # Discord's default avatar for new-style usernames: (id >> 22) % 6.
        return f"{_CDN}/embed/avatars/{(int(self.discord_id) >> 22) % 6}.png"


def _signer_with_clock(clock: Callable[[], float]) -> type[TimestampSigner]:
    class _ClockSigner(TimestampSigner):
        def get_timestamp(self) -> int:
            return int(clock())
    return _ClockSigner


def safe_next_path(raw: str | None) -> str:
    """A same-origin path to return to after login, or ``/``. Rejects absolute
    and scheme-relative URLs (``//host``, ``/\\host``), control characters and
    overlong values -- an open redirect would make the login page a phishing aid."""
    if not raw or not isinstance(raw, str) or len(raw) > NEXT_PATH_MAX:
        return "/"
    if not raw.startswith("/") or raw.startswith("//") or raw.startswith("/\\"):
        return "/"
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw):
        return "/"
    return raw


class SessionCodec:
    def __init__(self, key: str, clock: Callable[[], float] = time.time, *,
                 previous_keys: list[str] | tuple[str, ...] = (), not_before: int | None = None) -> None:
        if not key:
            raise ValueError("session key is required")
        signer = _signer_with_clock(clock)
        self._clock = clock
        self._not_before = not_before
        # itsdangerous: with a key list, the LAST key signs and all keys verify.
        keys = [k for k in previous_keys if k] + [key]
        self._session = URLSafeTimedSerializer(keys, salt=_SESSION_SALT, signer=signer)
        self._state = URLSafeTimedSerializer(keys, salt=_STATE_SALT, signer=signer)

    # ----- session -----

    def sign_session(self, user: SessionUser) -> str:
        return self._session.dumps({"discordId": user.discord_id, "username": user.username,
                                    "globalName": user.global_name, "avatar": user.avatar,
                                    "iat": int(self._clock())})

    def verify_session(self, token: str | None) -> SessionUser:
        if not token:
            raise InvalidSession("no session")
        try:
            data = self._session.loads(token, max_age=SESSION_MAX_AGE_S)
        except BadData as e:
            # type name only: the message can echo token fragments
            raise InvalidSession(f"session rejected ({type(e).__name__})") from None
        if not isinstance(data, dict):
            raise InvalidSession("session payload is not an object")
        did, username = data.get("discordId"), data.get("username")
        if not isinstance(did, str) or not _SNOWFLAKE.match(did):
            raise InvalidSession("session has no valid discordId")
        if not isinstance(username, str):
            raise InvalidSession("session has no username")
        gname, avatar, iat = data.get("globalName"), data.get("avatar"), data.get("iat")
        if self._not_before is not None and (not isinstance(iat, int) or iat < self._not_before):
            raise InvalidSession("session issued before HANGAR_SESSION_NOT_BEFORE")
        return SessionUser(did, username, gname if isinstance(gname, str) else None,
                           avatar if isinstance(avatar, str) else None,
                           iat if isinstance(iat, int) else None)

    # ----- OAuth state -----

    def sign_state(self, state: str, next_path: str) -> str:
        return self._state.dumps({"state": state, "next": safe_next_path(next_path)})

    def verify_state(self, token: str | None) -> tuple[str, str]:
        if not token:
            raise InvalidSession("no state cookie")
        try:
            data = self._state.loads(token, max_age=OAUTH_STATE_MAX_AGE_S)
        except BadData as e:
            raise InvalidSession(f"state rejected ({type(e).__name__})") from None
        if not isinstance(data, dict) or not isinstance(data.get("state"), str):
            raise InvalidSession("state payload malformed")
        return data["state"], safe_next_path(data.get("next"))
