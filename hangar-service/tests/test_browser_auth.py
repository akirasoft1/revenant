"""Web-editor browser auth: Discord OAuth login/callback/logout, /api/me, the
session principal on writes (acting member, CSRF), /api/v1 aliases and the
member directory. Discord is faked with httpx.MockTransport -- no network."""
import logging
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.discord_oauth import TOKEN_URL, USER_URL
from src.repository import InMemoryShipRepository
from src.session import SESSION_MAX_AGE_S, SessionCodec, SessionUser
from tests.test_app import ADMIN, OTHER, SELF, TAURUS_UUID, H, cfg, fake_verifier, make_catalog

ORIGIN = "https://hangar.aklabs.io"
KEY = "test-session-key-" + "k" * 40
SECRET = "discord-client-secret-value"
CODE = "the-oauth-code-value"
ACCESS = "discord-access-token-value"
BROWSER_ENV = {"DISCORD_CLIENT_ID": "1558216042151419935", "DISCORD_CLIENT_SECRET": SECRET,
               "HANGAR_SESSION_KEY": KEY}


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class FakeDiscord:
    def __init__(self):
        self.calls = []
        self.token_status = 200
        self.user_status = 200
        self.user = {"id": SELF, "username": "akira", "global_name": "Akira", "avatar": "abc"}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        url = str(req.url).split("?")[0]
        if url == TOKEN_URL:
            form = parse_qs(req.content.decode())
            if self.token_status != 200 or form.get("code") != [CODE]:
                return httpx.Response(self.token_status if self.token_status != 200 else 400,
                                      json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": ACCESS, "token_type": "Bearer"})
        if url == USER_URL:
            if self.user_status != 200 or req.headers.get("authorization") != f"Bearer {ACCESS}":
                return httpx.Response(self.user_status if self.user_status != 200 else 401,
                                      json={"message": "401: Unauthorized"})
            return httpx.Response(200, json=self.user)
        return httpx.Response(404)


@pytest.fixture
def discord():
    return FakeDiscord()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def repo():
    return InMemoryShipRepository()


def _app(repo, discord, clock, **env):
    return create_app(cfg(**{**BROWSER_ENV, **env}), catalog=make_catalog(), repository=repo,
                      verifier=fake_verifier, warm=False,
                      discord_transport=httpx.MockTransport(discord), clock=clock)


@pytest.fixture
def client(repo, discord, clock):
    with TestClient(_app(repo, discord, clock), base_url=ORIGIN, follow_redirects=False) as c:
        yield c


def session_cookie(user: SessionUser, clock=None) -> str:
    return SessionCodec(KEY, clock=clock or Clock()).sign_session(user)


ME = SessionUser(SELF, "akira", "Akira", "abc")
ADMIN_USER = SessionUser(ADMIN, "boss", None, None)


def as_user(client, user=ME, clock=None):
    client.cookies.set("hangar_session", session_cookie(user, clock), domain="hangar.aklabs.io")
    return client


def set_cookie_headers(r) -> list[str]:
    return r.headers.get_list("set-cookie")


def cookie_header(r, name) -> str:
    return next(h for h in set_cookie_headers(r) if h.startswith(name + "="))


def login(client, next_path=None):
    r = client.get("/api/auth/login", params={"next": next_path} if next_path else None)
    assert r.status_code == 302, r.text
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    return r, state


# ---------- login ----------

def test_login_redirects_to_discord_with_state_cookie(client):
    r, state = login(client, "/members")
    loc = urlsplit(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == "https://discord.com/oauth2/authorize"
    q = {k: v[0] for k, v in parse_qs(loc.query).items()}
    assert q["client_id"] == "1558216042151419935"
    assert q["redirect_uri"] == "https://hangar.aklabs.io/api/auth/callback"
    assert q["scope"] == "identify" and q["response_type"] == "code"
    assert len(state) >= 32
    h = cookie_header(r, "hangar_oauth_state").lower()
    assert "httponly" in h and "secure" in h and "samesite=lax" in h and "max-age=600" in h
    assert "path=/api/auth" in h
    assert r.headers["cache-control"] == "no-store"


def test_full_login_sets_session_cookie_and_redirects_to_next(client, discord):
    _, state = login(client, "/members")
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    assert r.status_code == 302, r.text
    assert r.headers["location"] == "/members"
    h = cookie_header(r, "hangar_session").lower()
    assert "httponly" in h and "secure" in h and "samesite=lax" in h and "path=/" in h
    assert f"max-age={SESSION_MAX_AGE_S}" in h
    # state cookie is consumed
    assert any(c.startswith("hangar_oauth_state=") and "max-age=0" in c.lower()
               for c in set_cookie_headers(r))
    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json() == {"discordId": SELF, "username": "akira", "globalName": "Akira",
                         "avatarUrl": f"https://cdn.discordapp.com/avatars/{SELF}/abc.png",
                         "isAdmin": False}


def test_login_without_next_lands_on_root(client):
    _, state = login(client)
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    assert r.headers["location"] == "/"


def test_login_unsafe_next_falls_back_to_root(client):
    _, state = login(client, "//evil.example/x")
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    assert r.headers["location"] == "/"


def _assert_login_error(r, code):
    assert r.status_code == 302
    assert r.headers["location"] == f"/?login_error={code}"
    assert not any(c.startswith("hangar_session=") and "max-age=0" not in c.lower()
                   for c in set_cookie_headers(r))


def test_callback_state_mismatch(client, discord):
    login(client)
    r = client.get("/api/auth/callback", params={"code": CODE, "state": "not-the-state"})
    _assert_login_error(r, "state_mismatch")
    assert discord.calls == []          # never exchanged the code


def test_callback_without_state_cookie(client, discord):
    r = client.get("/api/auth/callback", params={"code": CODE, "state": "x"})
    _assert_login_error(r, "state_mismatch")
    assert discord.calls == []


def test_callback_expired_state(client, clock):
    _, state = login(client)
    clock.t += 601
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    _assert_login_error(r, "state_mismatch")


def test_callback_tampered_state_cookie(client):
    _, state = login(client)
    client.cookies.set("hangar_oauth_state", "forged.value.sig", domain="hangar.aklabs.io",
                       path="/api/auth")
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    _assert_login_error(r, "state_mismatch")


def test_callback_user_denied(client):
    _, state = login(client)
    r = client.get("/api/auth/callback", params={"error": "access_denied", "state": state})
    _assert_login_error(r, "denied")


def test_callback_missing_code(client):
    _, state = login(client)
    r = client.get("/api/auth/callback", params={"state": state})
    _assert_login_error(r, "missing_code")


def test_callback_token_error(client, discord):
    discord.token_status = 400
    _, state = login(client)
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    _assert_login_error(r, "token_error")
    assert client.get("/api/me").status_code == 401


def test_callback_user_fetch_error(client, discord):
    discord.user_status = 500
    _, state = login(client)
    r = client.get("/api/auth/callback", params={"code": CODE, "state": state})
    _assert_login_error(r, "user_error")


def test_secrets_codes_tokens_never_logged(client, discord, caplog):
    caplog.set_level(logging.DEBUG)
    _, state = login(client)
    client.get("/api/auth/callback", params={"code": CODE, "state": state})
    discord.token_status = 400
    _, state2 = login(client)
    client.get("/api/auth/callback", params={"code": CODE, "state": state2})
    client.get("/api/me")
    # (the test client's own "httpx2" request log is not the service's)
    text = "\n".join(r.getMessage() for r in caplog.records if not r.name.startswith("httpx2"))
    for secret in (CODE, ACCESS, SECRET, KEY, state, state2):
        assert secret not in text
    assert client.cookies.get("hangar_session") not in text


# ---------- logout / me ----------

def test_logout_clears_session(client):
    as_user(client)
    assert client.get("/api/me").status_code == 200
    r = client.post("/api/auth/logout", headers={"Origin": ORIGIN})
    assert r.status_code == 204
    h = cookie_header(r, "hangar_session").lower()
    assert "max-age=0" in h and "path=/" in h
    assert client.get("/api/me").status_code == 401


def test_me_requires_session(client):
    r = client.get("/api/me")
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"
    # a service bearer token is not a browser session
    assert client.get("/api/me", headers=H()).status_code == 401


def test_me_admin_flag_and_default_avatar(client):
    as_user(client, ADMIN_USER)
    body = client.get("/api/me").json()
    assert body["isAdmin"] is True
    assert body["globalName"] is None and body["username"] == "boss"
    assert body["avatarUrl"].startswith("https://cdn.discordapp.com/embed/avatars/")


def test_tampered_session_cookie_is_401(client):
    client.cookies.set("hangar_session", session_cookie(ME)[:-3] + "xyz", domain="hangar.aklabs.io")
    assert client.get("/api/me").status_code == 401
    r = client.get(f"/api/v1/members/{SELF}/hangar")
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"


def test_expired_session_cookie_is_401(client, clock):
    as_user(client, ME, clock=Clock(clock.t))
    assert client.get("/api/me").status_code == 200
    clock.t += SESSION_MAX_AGE_S + 1
    assert client.get("/api/me").status_code == 401
    assert client.get(f"/api/v1/members/{SELF}/hangar").status_code == 401


# ---------- session principal on the API ----------

def test_session_read_needs_no_origin(client):
    as_user(client)
    r = client.get(f"/api/v1/members/{OTHER}/hangar")
    assert r.status_code == 200 and r.json() == {"member": OTHER, "ships": []}


def test_session_write_same_origin_sets_owner_name(client):
    as_user(client)
    r = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"},
                    headers={"Origin": ORIGIN})
    assert r.status_code == 201, r.text
    ship = r.json()["ship"]
    assert ship["updatedBy"] == SELF and ship["ownerName"] == "Akira"


def test_session_write_owner_name_falls_back_to_username(client):
    as_user(client, SessionUser(SELF, "akira", None, None))
    r = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"},
                    headers={"Referer": ORIGIN + "/"})
    assert r.status_code == 201 and r.json()["ship"]["ownerName"] == "akira"


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://evil.example"},
                                     {"Referer": "https://evil.example/hangar"}, {"Origin": "null"}])
def test_session_write_cross_origin_is_403(client, repo, headers):
    as_user(client)
    r = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers=headers)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"


@pytest.mark.parametrize("method,suffix,body", [
    ("PATCH", "", {"nickname": "x"}),
    ("DELETE", "", None),
    ("PUT", "/slots/hardpoint_quantum_drive", {"item": "Hemera"}),
    ("DELETE", "/slots/hardpoint_quantum_drive", None),
])
def test_every_session_write_route_checks_origin(client, method, suffix, body):
    as_user(client)
    ship = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": TAURUS_UUID},
                       headers={"Origin": ORIGIN}).json()["ship"]
    path = f"/api/v1/members/{SELF}/ships/{ship['shipId']}{suffix}"
    assert client.request(method, path, json=body).status_code == 403
    r = client.request(method, path, json=body, headers={"Origin": ORIGIN})
    assert r.status_code == 200, r.text
    if method != "DELETE" or suffix:
        assert r.json()["ship"]["ownerName"] == "Akira"


def test_session_acting_member_header_is_ignored(client):
    as_user(client)
    # claiming to be the admin does not let a session write someone else's hangar
    r = client.post(f"/api/v1/members/{OTHER}/ships", json={"vehicle": "harbinger"},
                    headers={"Origin": ORIGIN, "X-Acting-Member": ADMIN})
    assert r.status_code == 403
    # and a bogus header does not stop it writing its own
    r = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"},
                    headers={"Origin": ORIGIN, "X-Acting-Member": OTHER})
    assert r.status_code == 201 and r.json()["ship"]["updatedBy"] == SELF


def test_admin_session_writes_other_member_without_renaming_owner(client):
    as_user(client, ADMIN_USER)
    r = client.post(f"/api/v1/members/{OTHER}/ships", json={"vehicle": "harbinger"},
                    headers={"Origin": ORIGIN})
    assert r.status_code == 201
    ship = r.json()["ship"]
    assert ship["updatedBy"] == ADMIN and ship["ownerName"] is None


def test_session_cookie_also_works_on_v1_prefix(client):
    as_user(client)
    assert client.get(f"/v1/members/{SELF}/hangar").status_code == 200


def test_service_bearer_unchanged_on_both_prefixes_without_origin(client):
    for prefix in ("/v1", "/api/v1"):
        r = client.post(f"{prefix}/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers=H())
        assert r.status_code == 201, r.text
        assert r.json()["ship"]["ownerName"] is None
        assert client.get(f"{prefix}/members/{SELF}/hangar", headers=H(acting=None)).status_code == 200


def test_bearer_wins_over_session_cookie(client):
    as_user(client)
    # bearer + acting header for OTHER: a service principal acting as OTHER may write OTHER
    r = client.post(f"/api/v1/members/{OTHER}/ships", json={"vehicle": "harbinger"}, headers=H(OTHER))
    assert r.status_code == 201 and r.json()["ship"]["ownerName"] is None


# ---------- member directory ----------

def test_members_directory(client):
    as_user(client)
    client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers={"Origin": ORIGIN})
    client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers={"Origin": ORIGIN})
    client.post(f"/v1/members/{OTHER}/ships", json={"vehicle": "harbinger"}, headers=H(OTHER))
    r = client.get("/api/v1/members")
    assert r.status_code == 200
    members = r.json()["members"]
    assert {"discordId": SELF, "shipCount": 2, "displayName": "Akira"} in members
    assert {"discordId": OTHER, "shipCount": 1} in members        # no name known -> omitted
    assert len(members) == 2


def test_members_directory_requires_auth(client):
    r = client.get("/api/v1/members")
    assert r.status_code == 401
    assert client.get("/api/v1/members", headers=H(acting=None)).status_code == 200


def test_members_directory_storage_down_503(client, repo):
    as_user(client)
    repo.fail_with = RuntimeError("down")
    r = client.get("/api/v1/members")
    assert r.status_code == 503 and r.json()["error"] == "unavailable"


# ---------- dual prefixes ----------

@pytest.mark.parametrize("path", [
    f"/members/{SELF}/hangar", "/catalog/vehicles?q=harbinger", f"/catalog/vehicles/{TAURUS_UUID}/slots",
    "/catalog/items?type=QuantumDrive&size=2", "/members",
])
def test_api_v1_alias_serves_the_same_handler(client, path):
    client.post(f"/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers=H())
    a = client.get("/v1" + path, headers=H())
    b = client.get("/api/v1" + path, headers=H())
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    assert a.json() == b.json()


def test_api_v1_alias_writes(client):
    ship = client.post(f"/api/v1/members/{SELF}/ships", json={"vehicle": TAURUS_UUID}, headers=H()).json()["ship"]
    base = f"/api/v1/members/{SELF}/ships/{ship['shipId']}"
    assert client.patch(base, json={"nickname": "n"}, headers=H()).status_code == 200
    assert client.put(base + "/slots/hardpoint_quantum_drive", json={"item": "Hemera"},
                      headers=H()).status_code == 200
    assert client.delete(base + "/slots/hardpoint_quantum_drive", headers=H()).status_code == 200
    assert client.delete(base, headers=H()).status_code == 200


# ---------- browser auth not configured ----------

@pytest.mark.parametrize("missing", ["DISCORD_CLIENT_SECRET", "HANGAR_SESSION_KEY", "DISCORD_CLIENT_ID"])
def test_browser_auth_unconfigured_is_503_but_service_callers_work(repo, discord, clock, missing):
    app = _app(repo, discord, clock, **{missing: ""})
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as c:
        for method, path in (("GET", "/api/auth/login"), ("GET", "/api/auth/callback?code=x&state=y"),
                             ("GET", "/api/me")):
            r = c.request(method, path)
            assert r.status_code == 503, path
            assert r.json()["error"] == "unavailable"
        # a session cookie is simply not a credential: no resolver for it
        as_user(c)
        assert c.get(f"/api/v1/members/{SELF}/hangar").status_code == 401
        assert c.post(f"/v1/members/{SELF}/ships", json={"vehicle": "harbinger"},
                      headers=H()).status_code == 201
        assert c.get("/health").status_code == 200
