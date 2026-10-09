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
              "HANGAR_SESSION_KEY": KEY, "HANGAR_PUBLIC_ORIGIN": "http://localhost:5173/"})
    assert c.discord_client_id == "1558216042151419935"
    assert c.public_origin == "http://localhost:5173"          # trailing slash dropped
    assert c.redirect_uri == "http://localhost:5173/api/auth/callback"
    assert c.browser_auth_enabled is True
    assert c.browser_auth_problem() is None


import pytest  # noqa: E402


@pytest.mark.parametrize("missing", ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "HANGAR_SESSION_KEY"])
def test_browser_auth_disabled_when_any_missing(missing):
    env = {"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": KEY}
    env.pop(missing)
    c = load(env)
    assert c.browser_auth_enabled is False
    assert missing in c.browser_auth_problem()


def test_short_session_key_disables_browser_auth():
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": "short"})
    assert c.browser_auth_enabled is False
    assert "HANGAR_SESSION_KEY" in c.browser_auth_problem()


@pytest.mark.parametrize("origin", ["hangar.aklabs.io", "https://hangar.aklabs.io/path", "ftp://x"])
def test_bad_public_origin_disables_browser_auth(origin):
    c = load({"DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "sec", "HANGAR_SESSION_KEY": KEY,
              "HANGAR_PUBLIC_ORIGIN": origin})
    assert c.browser_auth_enabled is False
    assert "HANGAR_PUBLIC_ORIGIN" in c.browser_auth_problem()


def test_secrets_not_in_repr():
    c = load({"DISCORD_CLIENT_SECRET": "very-secret-value", "HANGAR_SESSION_KEY": KEY})
    assert "very-secret-value" not in repr(c)
    assert KEY not in repr(c)
