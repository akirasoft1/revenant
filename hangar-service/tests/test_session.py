"""Signed-cookie session + OAuth-state codec: round trip, tamper, expiry."""
import pytest

from src.session import (OAUTH_STATE_MAX_AGE_S, SESSION_MAX_AGE_S, InvalidSession, SessionCodec,
                         SessionUser, safe_next_path)

KEY = "k" * 48


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


USER = SessionUser(discord_id="123456789012345678", username="akira", global_name="Akira",
                   avatar="abc123")


def test_constants_match_spec():
    assert SESSION_MAX_AGE_S == 30 * 24 * 3600
    assert OAUTH_STATE_MAX_AGE_S == 600


def test_session_round_trip():
    clock = Clock()
    codec = SessionCodec(KEY, clock=clock)
    token = codec.sign_session(USER)
    assert isinstance(token, str) and ";" not in token and " " not in token
    user = codec.verify_session(token)
    assert user == USER
    assert user.iat == int(clock.t)


def test_session_payload_carries_iat_and_profile_fields():
    clock = Clock()
    codec = SessionCodec(KEY, clock=clock)
    payload = codec._session.loads(codec.sign_session(USER))
    assert payload == {"discordId": USER.discord_id, "username": "akira", "globalName": "Akira",
                       "avatar": "abc123", "guildId": None, "nick": None, "iat": int(clock.t)}


def test_session_tamper_rejected():
    codec = SessionCodec(KEY, clock=Clock())
    token = codec.sign_session(USER)
    flipped = token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1]
    with pytest.raises(InvalidSession):
        codec.verify_session(flipped)
    with pytest.raises(InvalidSession):
        codec.verify_session("garbage")
    with pytest.raises(InvalidSession):
        codec.verify_session("")


def test_session_signed_with_other_key_rejected():
    token = SessionCodec("x" * 48, clock=Clock()).sign_session(USER)
    with pytest.raises(InvalidSession):
        SessionCodec(KEY, clock=Clock()).verify_session(token)


def test_session_expiry():
    clock = Clock()
    codec = SessionCodec(KEY, clock=clock)
    token = codec.sign_session(USER)
    clock.t += SESSION_MAX_AGE_S - 5
    assert codec.verify_session(token) == USER
    clock.t += 10
    with pytest.raises(InvalidSession):
        codec.verify_session(token)


def test_state_token_is_not_a_session_and_vice_versa():
    codec = SessionCodec(KEY, clock=Clock())
    state = codec.sign_state("st", "/members")
    with pytest.raises(InvalidSession):
        codec.verify_session(state)
    with pytest.raises(InvalidSession):
        codec.verify_state(codec.sign_session(USER))


def test_state_round_trip_and_expiry():
    clock = Clock()
    codec = SessionCodec(KEY, clock=clock)
    tok = codec.sign_state("random-state", "/ships/abc")
    assert codec.verify_state(tok) == ("random-state", "/ships/abc")
    clock.t += OAUTH_STATE_MAX_AGE_S + 1
    with pytest.raises(InvalidSession):
        codec.verify_state(tok)


def test_session_with_bad_discord_id_rejected():
    codec = SessionCodec(KEY, clock=Clock())
    forged = codec._session.dumps({"discordId": "not-a-snowflake", "username": "x", "iat": 1})
    with pytest.raises(InvalidSession):
        codec.verify_session(forged)


def test_display_name_prefers_global_name():
    assert USER.display_name == "Akira"
    assert SessionUser("1", "user", None, None).display_name == "user"


def test_avatar_url():
    assert USER.avatar_url == f"https://cdn.discordapp.com/avatars/{USER.discord_id}/abc123.png"
    anim = SessionUser("1", "u", None, "a_xyz")
    assert anim.avatar_url == "https://cdn.discordapp.com/avatars/1/a_xyz.gif"
    default = SessionUser("123456789012345678", "u", None, None)
    idx = (123456789012345678 >> 22) % 6
    assert default.avatar_url == f"https://cdn.discordapp.com/embed/avatars/{idx}.png"


@pytest.mark.parametrize("raw,expected", [
    (None, "/"), ("", "/"), ("/", "/"), ("/members/1", "/members/1"),
    ("/ships/x?tab=slots#a", "/ships/x?tab=slots#a"),
    ("//evil.com", "/"), ("/\\evil.com", "/"), ("https://evil.com/", "/"),
    ("evil.com", "/"), ("javascript:alert(1)", "/"), ("/a\nb", "/"), ("/" + "a" * 600, "/"),
])
def test_safe_next_path(raw, expected):
    assert safe_next_path(raw) == expected


def test_previous_key_verifies_newest_signs():
    old, new = "o" * 48, "n" * 48
    tok_old = SessionCodec(old, clock=Clock()).sign_session(USER)
    rotated = SessionCodec(new, previous_keys=[old], clock=Clock())
    assert rotated.verify_session(tok_old) == USER
    tok_new = rotated.sign_session(USER)
    assert SessionCodec(new, clock=Clock()).verify_session(tok_new) == USER   # signed with newest
    with pytest.raises(InvalidSession):
        SessionCodec(old, clock=Clock()).verify_session(tok_new)


def test_not_before_rejects_older_iat():
    clock = Clock()
    tok = SessionCodec(KEY, clock=clock).sign_session(USER)
    assert SessionCodec(KEY, clock=clock, not_before=int(clock.t)).verify_session(tok) == USER
    with pytest.raises(InvalidSession):
        SessionCodec(KEY, clock=clock, not_before=int(clock.t) + 1).verify_session(tok)
    # a session with no iat cannot prove it is newer than the cutoff
    no_iat = SessionCodec(KEY, clock=clock)._session.dumps({"discordId": "1", "username": "u"})
    with pytest.raises(InvalidSession):
        SessionCodec(KEY, clock=clock, not_before=1).verify_session(no_iat)


def test_guild_and_nick_round_trip():
    u = SessionUser("1", "u", None, None, guild_id="323349603976216577", nick="Cap")
    back = SessionCodec(KEY, clock=Clock()).verify_session(SessionCodec(KEY, clock=Clock()).sign_session(u))
    assert back.guild_id == "323349603976216577" and back.nick == "Cap"


def test_allowed_guilds_enforced_on_verify():
    codec = SessionCodec(KEY, clock=Clock())
    tok = codec.sign_session(SessionUser("1", "u", None, None, guild_id="10"))
    assert SessionCodec(KEY, clock=Clock(), allowed_guild_ids=frozenset({"10"})).verify_session(tok).guild_id == "10"
    with pytest.raises(InvalidSession):
        SessionCodec(KEY, clock=Clock(), allowed_guild_ids=frozenset({"20"})).verify_session(tok)
    no_guild = codec.sign_session(USER)
    with pytest.raises(InvalidSession):
        SessionCodec(KEY, clock=Clock(), allowed_guild_ids=frozenset({"10"})).verify_session(no_guild)
