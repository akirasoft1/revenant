from src.config import DEFAULT_ALLOWED_CALLER, load


def test_defaults():
    c = load({})
    assert c.audience == ""
    assert c.allowed_callers == frozenset({DEFAULT_ALLOWED_CALLER})
    assert DEFAULT_ALLOWED_CALLER == "hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com"
    assert c.admin_ids == frozenset()
    assert c.wiki_base == "https://api.star-citizen.wiki/api"
    assert c.project is None
    assert c.port == 8080
    assert c.storage == "firestore"


def test_env_parsing():
    c = load({
        "HANGAR_AUDIENCE": " https://hangar-service-abc-uc.a.run.app ",
        "HANGAR_ALLOWED_CALLERS": "a@x.iam.gserviceaccount.com, B@Y.iam.gserviceaccount.com ,,",
        "HANGAR_ADMIN_IDS": "111, 222 ,",
        "WIKI_BASE": "http://wiki.local/api",
        "GOOGLE_CLOUD_PROJECT": "revenant-discord-bot-2",
        "PORT": "9090",
        "HANGAR_STORAGE": "MEMORY",
        "K_REVISION": "hangar-service-00007-abc",
    })
    assert c.audience == "https://hangar-service-abc-uc.a.run.app"
    # emails compare case-insensitively
    assert c.allowed_callers == frozenset({"a@x.iam.gserviceaccount.com", "b@y.iam.gserviceaccount.com"})
    assert c.admin_ids == frozenset({"111", "222"})
    assert c.wiki_base == "http://wiki.local/api"
    assert c.project == "revenant-discord-bot-2"
    assert c.port == 9090
    assert c.storage == "memory"
    assert c.version == "hangar-service-00007-abc"


def test_blank_allowed_callers_falls_back_to_default():
    assert load({"HANGAR_ALLOWED_CALLERS": "  "}).allowed_callers == frozenset({DEFAULT_ALLOWED_CALLER})


def test_version_prefers_explicit_env():
    assert load({"HANGAR_VERSION": "abc1234", "K_REVISION": "rev"}).version == "abc1234"
    assert load({}).version == "dev"


def test_unknown_storage_rejected():
    import pytest
    with pytest.raises(ValueError):
        load({"HANGAR_STORAGE": "postgres"})


def test_memory_storage_refused_on_cloud_run():
    import pytest
    with pytest.raises(ValueError):
        load({"HANGAR_STORAGE": "memory", "K_SERVICE": "hangar-service"})
    assert load({"K_SERVICE": "hangar-service"}).storage == "firestore"
    assert load({"HANGAR_STORAGE": "memory"}).storage == "memory"


# ---------- browser auth (web editor) ----------

KEY = "k" * 48


def test_browser_auth_defaults_disabled():
    c = load({})
    assert c.public_origin == "https://hangar.aklabs.io"
    assert c.redirect_uri == "https://hangar.aklabs.io/api/auth/callback"
    assert c.discord_client_id == ""
    assert c.discord_client_secret == ""
    assert c.session_key == ""
    assert c.browser_auth_problem() is not None
    assert c.browser_auth_enabled is False


def test_browser_auth_enabled_when_all_set():
    c = load({"DISCORD_CLIENT_ID": " 1558216042151419935 ", "DISCORD_CLIENT_SECRET": "sec",
              "HANGAR_SESSION_KEY": KEY, "HANGAR_PUBLIC_ORIGIN": "http://localhost:5173/",
              "HANGAR_ALLOWED_GUILD_IDS": " 323349603976216577 , 42,"})
    assert c.allowed_guild_ids == frozenset({"323349603976216577", "42"})
    assert c.discord_client_id == "1558216042151419935"
    assert c.public_origin == "http://localhost:5173"          # trailing slash dropped
    assert c.redirect_uri == "http://localhost:5173/api/auth/callback"
    assert c.browser_auth_enabled is True
    assert c.browser_auth_problem() is None


import pytest  # noqa: E402


@pytest.mark.parametrize("missing", ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "HANGAR_SESSION_KEY",
                                     "HANGAR_ALLOWED_GUILD_IDS"])
def test_browser_auth_disabled_when_any_missing(missing):
    env = {"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7"}
    env.pop(missing)
    c = load(env)
    assert c.browser_auth_enabled is False
    assert missing in c.browser_auth_problem()


def test_short_session_key_disables_browser_auth():
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": "short",
              "HANGAR_ALLOWED_GUILD_IDS": "7"})
    assert c.browser_auth_enabled is False
    assert "HANGAR_SESSION_KEY" in c.browser_auth_problem()


@pytest.mark.parametrize("origin", ["hangar.aklabs.io", "https://hangar.aklabs.io/path", "ftp://x"])
def test_bad_public_origin_disables_browser_auth(origin):
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_PUBLIC_ORIGIN": origin})
    assert c.browser_auth_enabled is False
    assert "HANGAR_PUBLIC_ORIGIN" in c.browser_auth_problem()


def test_secrets_not_in_repr():
    c = load({"DISCORD_CLIENT_SECRET": "very-secret-value", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7"})
    assert "very-secret-value" not in repr(c)
    assert KEY not in repr(c)


# ---------- fix round 1 ----------

@pytest.mark.parametrize("raw,expected", [
    ("HTTPS://Hangar.AKLabs.io", "https://hangar.aklabs.io"),
    ("https://hangar.aklabs.io:443", "https://hangar.aklabs.io"),
    ("https://hangar.aklabs.io:443/", "https://hangar.aklabs.io"),
    ("http://localhost:80", "http://localhost"),
    ("http://localhost:5173", "http://localhost:5173"),
    ("https://hangar.aklabs.io:8443", "https://hangar.aklabs.io:8443"),
])
def test_public_origin_normalized(raw, expected):
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_PUBLIC_ORIGIN": raw})
    assert c.public_origin == expected
    assert c.browser_auth_enabled


@pytest.mark.parametrize("raw", ["https://hangar.aklabs.io/x", "https://hangar.aklabs.io?x=1",
                                 "https://hangar.aklabs.io#f", "https://u@hangar.aklabs.io",
                                 "https://hangar.aklabs.io:notaport", "https://", "hangar.aklabs.io"])
def test_public_origin_junk_rejected(raw):
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_PUBLIC_ORIGIN": raw})
    assert not c.browser_auth_enabled
    assert "HANGAR_PUBLIC_ORIGIN" in c.browser_auth_problem()


def test_max_ships_per_member():
    assert load({}).max_ships_per_member == 200
    assert load({"HANGAR_MAX_SHIPS_PER_MEMBER": "5"}).max_ships_per_member == 5
    for bad in ("0", "-1", "x"):
        with pytest.raises(ValueError):
            load({"HANGAR_MAX_SHIPS_PER_MEMBER": bad})


def test_session_rotation_settings():
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_SESSION_KEY_PREVIOUS": "p" * 40, "HANGAR_SESSION_NOT_BEFORE": "1800000000"})
    assert c.session_key_previous == "p" * 40 and "p" * 40 not in repr(c)
    assert c.session_not_before == 1800000000
    assert c.browser_auth_enabled
    assert load({}).session_not_before is None


@pytest.mark.parametrize("bad", ["soon", "-5", "1.5"])
def test_bad_session_not_before_disables_browser_auth(bad):
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_SESSION_NOT_BEFORE": bad})
    assert not c.browser_auth_enabled and "HANGAR_SESSION_NOT_BEFORE" in c.browser_auth_problem()


def test_short_previous_key_disables_browser_auth():
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY, "HANGAR_ALLOWED_GUILD_IDS": "7",
              "HANGAR_SESSION_KEY_PREVIOUS": "short"})
    assert not c.browser_auth_enabled and "HANGAR_SESSION_KEY_PREVIOUS" in c.browser_auth_problem()


def test_allowed_guilds_must_be_snowflakes():
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "HANGAR_SESSION_KEY": KEY,
              "HANGAR_ALLOWED_GUILD_IDS": "323349603976216577,my-server"})
    assert not c.browser_auth_enabled and "HANGAR_ALLOWED_GUILD_IDS" in c.browser_auth_problem()
    assert load({}).allowed_guild_ids == frozenset()
