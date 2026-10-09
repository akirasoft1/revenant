"""Discord OAuth2 authorization-code flow (scope ``identify``) for the web editor.

The HTTP transport is injectable so tests run against a fake Discord.
Errors are ``DiscordOAuthError`` with a stable ``code`` (``token_error`` /
``user_error``) that the callback turns into ``/?login_error=<code>``. Error
messages carry only HTTP status / Discord's ``error`` field / the exception
type -- never the authorization code, access token or client secret.
"""
import logging
import re
from urllib.parse import urlencode

import httpx

from .session import SessionUser

log = logging.getLogger(__name__)

AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
TOKEN_URL = "https://discord.com/api/oauth2/token"
USER_URL = "https://discord.com/api/users/@me"
SCOPE = "identify"
_SNOWFLAKE = re.compile(r"^[0-9]{1,32}$")


class DiscordOAuthError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _discord_error_field(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except Exception:
        return ""
    if isinstance(body, dict):
        err = body.get("error") or body.get("message")
        if isinstance(err, str) and len(err) <= 100:
            return f" ({err})"
    return ""


class DiscordOAuth:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str, *,
                 transport: httpx.AsyncBaseTransport | None = None, timeout_s: float = 10.0) -> None:
        self._client_id = client_id
        self._secret = client_secret
        self._redirect = redirect_uri
        self._transport = transport
        self._timeout = timeout_s

    def authorize_url(self, state: str) -> str:
        return AUTHORIZE_URL + "?" + urlencode({
            "response_type": "code", "client_id": self._client_id, "scope": SCOPE,
            "redirect_uri": self._redirect, "state": state})

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self._timeout)

    async def exchange_code(self, code: str) -> str:
        """Authorization code -> access token."""
        try:
            async with self._client() as c:
                resp = await c.post(TOKEN_URL, auth=(self._client_id, self._secret),
                                    data={"grant_type": "authorization_code", "code": code,
                                          "redirect_uri": self._redirect},
                                    headers={"Accept": "application/json"})
        except httpx.HTTPError as e:
            raise DiscordOAuthError("token_error",
                                    f"Discord token endpoint unreachable ({type(e).__name__})") from None
        if resp.status_code != 200:
            raise DiscordOAuthError("token_error", f"Discord token endpoint returned HTTP "
                                    f"{resp.status_code}{_discord_error_field(resp)}")
        try:
            token = resp.json().get("access_token")
        except Exception:
            token = None
        if not isinstance(token, str) or not token:
            raise DiscordOAuthError("token_error", "Discord token response had no access_token")
        return token

    async def fetch_user(self, access_token: str) -> SessionUser:
        try:
            async with self._client() as c:
                resp = await c.get(USER_URL, headers={"Authorization": f"Bearer {access_token}",
                                                      "Accept": "application/json"})
        except httpx.HTTPError as e:
            raise DiscordOAuthError("user_error",
                                    f"Discord user endpoint unreachable ({type(e).__name__})") from None
        if resp.status_code != 200:
            raise DiscordOAuthError("user_error", f"Discord user endpoint returned HTTP "
                                    f"{resp.status_code}{_discord_error_field(resp)}")
        try:
            body = resp.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            raise DiscordOAuthError("user_error", "Discord user response is not a JSON object")
        did, username = body.get("id"), body.get("username")
        if not isinstance(did, str) or not _SNOWFLAKE.match(did) or not isinstance(username, str):
            raise DiscordOAuthError("user_error", "Discord user response has no valid id/username")
        gname, avatar = body.get("global_name"), body.get("avatar")
        return SessionUser(did, username, gname if isinstance(gname, str) and gname else None,
                           avatar if isinstance(avatar, str) and avatar else None)
