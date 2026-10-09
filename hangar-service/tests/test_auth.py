"""Auth: Google ID-token verification, the credential-resolver chain, and the
write-permission rule."""
import datetime
import json
import time

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from google.auth import crypt
from google.auth import jwt as gjwt
from starlette.requests import Request

from src.auth import (
    AuthError, AuthUnavailable, Authenticator, CachingRequest, Forbidden,
    GoogleIdTokenResolver, GoogleIdTokenVerifier, Principal, authorize_write,
)

AUD = "https://hangar-service-xyz-uc.a.run.app"
CALLER = "hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com"
CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"


# ---------- a local "Google": RSA key, x509 cert, signed ID tokens ----------

def _keypair(kid: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .sign(key, hashes.SHA256()))
    pem_key = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
    pem_cert = cert.public_bytes(serialization.Encoding.PEM).decode()
    return crypt.RSASigner.from_string(pem_key, key_id=kid), pem_cert


SIGNER, CERT = _keypair("k1")
OTHER_SIGNER, _ = _keypair("k1")   # same kid, different key -> bad signature


def make_token(signer=SIGNER, **overrides) -> str:
    now = int(time.time())
    claims = {"iss": "https://accounts.google.com", "aud": AUD, "sub": "1234",
              "email": CALLER, "email_verified": True, "iat": now, "exp": now + 3600}
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return gjwt.encode(signer, claims).decode()


class FakeResponse:
    def __init__(self, status: int, body: dict):
        self.status = status
        self.data = json.dumps(body).encode()
        self.headers = {}


class FakeGoogle:
    """google.auth.transport.Request stand-in serving the certs endpoint."""

    def __init__(self, status: int = 200):
        self.calls: list[str] = []
        self.status = status

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kw):
        self.calls.append(url)
        return FakeResponse(self.status, {"k1": CERT})


def real_verifier(google=None):
    return GoogleIdTokenVerifier(request=google or FakeGoogle())


# ---------- GoogleIdTokenVerifier (the real google-auth path) ----------

def test_verifier_accepts_a_valid_token():
    claims = real_verifier()(make_token(), AUD)
    assert claims["email"] == CALLER and claims["aud"] == AUD


@pytest.mark.parametrize("token_kw", [
    {"aud": "https://some-other-service.run.app"},          # wrong audience
    {"iss": "https://evil.example.com"},                     # wrong issuer
    {"exp": int(time.time()) - 600, "iat": int(time.time()) - 4000},  # expired
    {"signer": OTHER_SIGNER},                                # bad signature
])
def test_verifier_rejects_bad_tokens(token_kw):
    with pytest.raises(AuthError):
        real_verifier()(make_token(**token_kw), AUD)


def test_verifier_rejects_garbage():
    with pytest.raises(AuthError):
        real_verifier()("not-a-jwt", AUD)


def test_verifier_refuses_to_run_without_an_audience():
    # verify_oauth2_token(audience=None) would SKIP the audience check.
    with pytest.raises(AuthError):
        real_verifier()(make_token(), "")


def test_verifier_cert_fetch_failure_is_unavailable_not_401():
    with pytest.raises(AuthUnavailable):
        real_verifier(FakeGoogle(status=500))(make_token(), AUD)


def test_caching_request_fetches_certs_once_within_ttl():
    google = FakeGoogle()
    t = {"now": 0.0}
    v = GoogleIdTokenVerifier(request=CachingRequest(google, ttl_s=3600, clock=lambda: t["now"]))
    v(make_token(), AUD)
    v(make_token(), AUD)
    assert len(google.calls) == 1
    t["now"] += 3601
    v(make_token(), AUD)
    assert len(google.calls) == 2


def test_caching_request_does_not_cache_failures():
    google = FakeGoogle(status=500)
    req = CachingRequest(google)
    req(CERTS_URL)
    req(CERTS_URL)
    assert len(google.calls) == 2


# ---------- GoogleIdTokenResolver ----------

def _request(headers: dict | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


def fake_verifier(claims_by_token: dict):
    """Fake TokenVerifier: known token -> claims (audience checked like Google)."""
    def verify(token, audience):
        claims = claims_by_token.get(token)
        if claims is None:
            raise AuthError("invalid token")
        if claims.get("aud") != audience:
            raise AuthError("wrong audience")
        return claims
    return verify


GOOD = {"aud": AUD, "email": CALLER, "email_verified": True}


def resolver(claims_by_token=None, allowed=(CALLER,), audience=AUD):
    return GoogleIdTokenResolver(audience=audience, allowed_callers=frozenset(allowed),
                                 verifier=fake_verifier(claims_by_token or {"good": GOOD}))


async def test_resolver_not_applicable_without_bearer():
    assert await resolver().resolve(_request()) is None
    assert await resolver().resolve(_request({"Authorization": "Basic Zm9vOmJhcg=="})) is None


async def test_resolver_returns_service_principal_with_acting_member():
    p = await resolver().resolve(_request({"Authorization": "Bearer good", "X-Acting-Member": "111"}))
    assert p == Principal(kind="service", subject=CALLER, acting_member="111")


async def test_resolver_acting_member_optional_on_reads():
    p = await resolver().resolve(_request({"Authorization": "Bearer good"}))
    assert p.acting_member is None


@pytest.mark.parametrize("claims", [
    {**GOOD, "email": "someone-else@evil.iam.gserviceaccount.com"},   # not allow-listed
    {**GOOD, "email_verified": False},
    {**GOOD, "email_verified": None},
    {k: v for k, v in GOOD.items() if k != "email"},
    {**GOOD, "aud": "https://other.run.app"},
])
async def test_resolver_rejects_disallowed_claims(claims):
    with pytest.raises(AuthError):
        await resolver({"t": claims}).resolve(_request({"Authorization": "Bearer t"}))


async def test_resolver_email_allow_list_is_case_insensitive():
    claims = {**GOOD, "email": CALLER.upper()}
    p = await resolver({"t": claims}).resolve(_request({"Authorization": "Bearer t"}))
    assert p.subject == CALLER


async def test_resolver_rejects_unknown_and_empty_bearer():
    with pytest.raises(AuthError):
        await resolver().resolve(_request({"Authorization": "Bearer nope"}))
    with pytest.raises(AuthError):
        await resolver().resolve(_request({"Authorization": "Bearer "}))


async def test_resolver_with_real_verifier_end_to_end():
    r = GoogleIdTokenResolver(audience=AUD, allowed_callers=frozenset({CALLER}),
                              verifier=real_verifier())
    p = await r.resolve(_request({"Authorization": f"Bearer {make_token()}"}))
    assert p.subject == CALLER
    with pytest.raises(AuthError):
        await r.resolve(_request({"Authorization": f"Bearer {make_token(aud='https://x.run.app')}"}))


# ---------- Authenticator (resolver chain) ----------

class StaticResolver:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def resolve(self, request):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


async def test_authenticator_first_applicable_resolver_wins():
    p = Principal("discord_session", "222", "222")
    first, second = StaticResolver(None), StaticResolver(p)
    assert await Authenticator([first, second]).authenticate(_request()) == p
    assert first.calls == 1 and second.calls == 1


async def test_authenticator_no_credentials_is_401():
    with pytest.raises(AuthError):
        await Authenticator([StaticResolver(None)]).authenticate(_request())


async def test_authenticator_presented_but_invalid_credential_stops_the_chain():
    later = StaticResolver(Principal("x", "y", None))
    with pytest.raises(AuthError):
        await Authenticator([StaticResolver(AuthError("bad")), later]).authenticate(_request())
    assert later.calls == 0


# ---------- write rule ----------

ADMINS = frozenset({"999"})


def test_write_self_allowed():
    authorize_write(Principal("service", CALLER, "111"), "111", ADMINS)


def test_write_admin_for_other_allowed():
    authorize_write(Principal("service", CALLER, "999"), "111", ADMINS)


def test_write_other_non_admin_forbidden():
    with pytest.raises(Forbidden):
        authorize_write(Principal("service", CALLER, "222"), "111", ADMINS)


def test_write_without_acting_member_forbidden():
    with pytest.raises(Forbidden) as e:
        authorize_write(Principal("service", CALLER, None), "111", ADMINS)
    assert "X-Acting-Member" in str(e.value)


# ---------- Discord session resolver + same-origin check (web editor) ----------

from src.auth import SESSION_COOKIE, DiscordSessionResolver, check_same_origin  # noqa: E402
from src.session import SessionCodec, SessionUser  # noqa: E402

ORIGIN = "https://hangar.aklabs.io"
SUSER = SessionUser("123456789012345678", "akira", "Akira", None)


def _codec():
    return SessionCodec("k" * 48)


async def test_session_resolver_no_cookie_is_not_applicable():
    assert await DiscordSessionResolver(_codec()).resolve(_request()) is None


async def test_session_resolver_valid_cookie_is_session_principal_ignoring_acting_header():
    codec = _codec()
    req = _request({"Cookie": f"{SESSION_COOKIE}={codec.sign_session(SUSER)}",
                    "X-Acting-Member": "999"})
    p = await DiscordSessionResolver(codec).resolve(req)
    assert p.kind == "session"
    assert p.subject == SUSER.discord_id
    assert p.acting_member == SUSER.discord_id      # header ignored
    assert p.user == SUSER


async def test_session_resolver_bad_cookie_is_401():
    req = _request({"Cookie": f"{SESSION_COOKIE}=tampered.value.sig"})
    with pytest.raises(AuthError):
        await DiscordSessionResolver(_codec()).resolve(req)


async def test_google_bearer_wins_over_a_session_cookie_in_the_chain():
    codec = _codec()
    google = GoogleIdTokenResolver(AUD, frozenset({CALLER}),
                                   fake_verifier({"good": {"aud": AUD, "email": CALLER,
                                                           "email_verified": True}}))
    req = _request({"Authorization": "Bearer good", "X-Acting-Member": "222",
                    "Cookie": f"{SESSION_COOKIE}={codec.sign_session(SUSER)}"})
    p = await Authenticator([google, DiscordSessionResolver(codec)]).authenticate(req)
    assert p.kind == "service" and p.acting_member == "222"


@pytest.mark.parametrize("headers", [
    {"Origin": ORIGIN},
    {"Referer": ORIGIN + "/ships/abc"},
    {"Referer": ORIGIN},
    {"Origin": ORIGIN, "Referer": "https://evil.example/x"},   # Origin decides when present
])
def test_same_origin_ok(headers):
    check_same_origin(_request(headers), ORIGIN)


@pytest.mark.parametrize("headers", [
    {},
    {"Origin": "https://evil.example"},
    {"Origin": "null"},
    {"Origin": ORIGIN + ".evil.example"},
    {"Origin": "http://hangar.aklabs.io"},
    {"Referer": ORIGIN + ".evil.example/x"},
    {"Referer": "https://evil.example/?u=" + ORIGIN},
    {"Origin": "https://evil.example", "Referer": ORIGIN + "/"},
])
def test_same_origin_rejected(headers):
    with pytest.raises(Forbidden):
        check_same_origin(_request(headers), ORIGIN)


def test_session_principal_write_rule_unchanged():
    p = Principal("session", "111", "111", user=SUSER)
    authorize_write(p, "111", frozenset())
    with pytest.raises(Forbidden):
        authorize_write(p, "222", frozenset())
    authorize_write(p, "222", frozenset({"111"}))
