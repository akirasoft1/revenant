"""Discord OAuth2 client against a fake Discord (httpx.MockTransport, no network)."""
import base64
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from src.discord_oauth import (AUTHORIZE_URL, TOKEN_URL, USER_URL, DiscordOAuth, DiscordOAuthError)

CLIENT_ID = "1558216042151419935"
SECRET = "s3cret-value"
REDIRECT = "https://hangar.aklabs.io/api/auth/callback"


def fake_discord(calls=None, token_status=200, token_body=None, user_status=200, user_body=None,
                 raise_on=None):
    def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req)
        url = str(req.url).split("?")[0]
        if raise_on and raise_on in url:
            raise httpx.ConnectError("boom", request=req)
        if url == TOKEN_URL:
            body = token_body if token_body is not None else {"access_token": "AT-1", "token_type": "Bearer",
                                                              "scope": "identify", "expires_in": 604800}
            return httpx.Response(token_status, json=body)
        if url == USER_URL:
            body = user_body if user_body is not None else {
                "id": "123456789012345678", "username": "akira", "global_name": "Akira", "avatar": "abc"}
            return httpx.Response(user_status, json=body)
        return httpx.Response(404, json={"message": "unrouted"})
    return handler


def oauth(handler):
    return DiscordOAuth(CLIENT_ID, SECRET, REDIRECT, transport=httpx.MockTransport(handler))


def test_urls():
    assert AUTHORIZE_URL == "https://discord.com/oauth2/authorize"
    assert TOKEN_URL == "https://discord.com/api/oauth2/token"
    assert USER_URL == "https://discord.com/api/users/@me"


def test_authorize_url():
    url = oauth(fake_discord()).authorize_url("the-state")
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == AUTHORIZE_URL
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert q == {"response_type": "code", "client_id": CLIENT_ID, "scope": "identify",
                 "redirect_uri": REDIRECT, "state": "the-state"}
    assert SECRET not in url


async def test_exchange_code_and_fetch_user():
    calls = []
    o = oauth(fake_discord(calls))
    token = await o.exchange_code("the-code")
    assert token == "AT-1"
    req = calls[0]
    assert req.method == "POST"
    form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
    assert form == {"grant_type": "authorization_code", "code": "the-code", "redirect_uri": REDIRECT}
    basic = base64.b64decode(req.headers["authorization"].split()[1]).decode()
    assert basic == f"{CLIENT_ID}:{SECRET}"
    user = await o.fetch_user(token)
    assert user.discord_id == "123456789012345678"
    assert user.username == "akira" and user.global_name == "Akira" and user.avatar == "abc"
    assert calls[1].headers["authorization"] == "Bearer AT-1"


@pytest.mark.parametrize("kwargs", [
    {"token_status": 400, "token_body": {"error": "invalid_grant"}},
    {"token_status": 200, "token_body": {"token_type": "Bearer"}},       # no access_token
    {"token_status": 500, "token_body": {"x": 1}},
    {"raise_on": "oauth2/token"},
])
async def test_token_errors(kwargs, caplog):
    with pytest.raises(DiscordOAuthError) as ei:
        await oauth(fake_discord(**kwargs)).exchange_code("the-code")
    assert ei.value.code == "token_error"
    assert "the-code" not in str(ei.value) and SECRET not in str(ei.value)


@pytest.mark.parametrize("kwargs", [
    {"user_status": 401, "user_body": {"message": "401: Unauthorized"}},
    {"user_status": 200, "user_body": {"username": "x"}},                # no id
    {"user_status": 200, "user_body": {"id": "abc", "username": "x"}},   # not a snowflake
    {"raise_on": "users/@me"},
])
async def test_user_errors(kwargs):
    with pytest.raises(DiscordOAuthError) as ei:
        await oauth(fake_discord(**kwargs)).fetch_user("AT-1")
    assert ei.value.code == "user_error"
    assert "AT-1" not in str(ei.value)
