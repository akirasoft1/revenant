"""_default_credentials_factory branches on the key file's `type`: a
service-account key (unchanged) or a federated (external_account) credential
file that impersonates the caller SA to mint an ID token. No network: nothing
is refreshed."""
import json

import pytest
from google.auth import impersonated_credentials

from src.hangar_edit import _default_credentials_factory

URL = "https://hangar.example.test"
EMAIL = "caller-sa@proj.iam.gserviceaccount.com"
IMPERSONATION = (
    f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{EMAIL}:generateAccessToken")


def _external(tmp_path, url=IMPERSONATION):
    subject = tmp_path / "subject.txt"
    subject.write_text("subject-token")
    info = {
        "type": "external_account",
        "audience": "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q",
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": "https://sts.googleapis.com/v1/token",
        "credential_source": {"file": str(subject)},
    }
    if url is not None:
        info["service_account_impersonation_url"] = url
    path = tmp_path / "cred.json"
    path.write_text(json.dumps(info))
    return path


def test_external_account_impersonates_target_with_email_claim(tmp_path, monkeypatch):
    import google.auth

    def _boom(*a, **k):  # would do a project-id lookup (extra egress)
        raise AssertionError("load_credentials_from_file must not be used")
    monkeypatch.setattr(google.auth, "load_credentials_from_file", _boom)
    creds = _default_credentials_factory(str(_external(tmp_path)), URL)
    assert isinstance(creds, impersonated_credentials.IDTokenCredentials)
    assert creds._target_audience == URL
    assert creds._include_email is True
    target = creds._target_credentials
    assert isinstance(target, impersonated_credentials.Credentials)
    assert target._target_principal == EMAIL
    assert target._target_scopes == ["https://www.googleapis.com/auth/cloud-platform"]
    # One hop: the source is the plain federated credential, with no
    # impersonation of its own.
    assert target._source_credentials._service_account_impersonation_url is None


@pytest.mark.parametrize("url", [None, "https://example.test/not-an-sa-url"])
def test_external_account_without_parsable_impersonation_url_names_the_path(tmp_path, url):
    path = _external(tmp_path, url)
    with pytest.raises(ValueError) as e:
        _default_credentials_factory(str(path), URL)
    assert str(path) in str(e.value)
    assert "subject-token" not in str(e.value)


def test_service_account_key_still_builds_service_account_id_token_credentials(tmp_path):
    """type=service_account keeps the original path (no network: not refreshed)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from google.oauth2 import service_account

    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()
    key = tmp_path / "key.json"
    key.write_text(json.dumps({
        "type": "service_account", "project_id": "p", "private_key_id": "k1",
        "private_key": pem, "client_email": EMAIL,
        "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"}))
    creds = _default_credentials_factory(str(key), URL)
    assert isinstance(creds, service_account.IDTokenCredentials)
    assert creds._target_audience == URL
