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
