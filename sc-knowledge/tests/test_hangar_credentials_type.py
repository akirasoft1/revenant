"""_default_credentials_factory branches on the key file's `type`: a
service-account key (unchanged) or a federated (external_account) credential
file that impersonates the caller SA to mint an ID token. No network: nothing
is refreshed."""
import json

import pytest
from google.auth import impersonated_credentials

from src.hangar import _default_credentials_factory

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
    # load_credentials_from_file asks the credential for its project id, which
    # would call STS; there is no network in this test.
    from google.auth import external_account
    monkeypatch.setattr(external_account.Credentials, "get_project_id", lambda self, request=None: None)
    creds = _default_credentials_factory(str(_external(tmp_path)), URL)
    assert isinstance(creds, impersonated_credentials.IDTokenCredentials)
    assert creds._target_audience == URL
    assert creds._include_email is True
    target = creds._target_credentials
    assert isinstance(target, impersonated_credentials.Credentials)
    assert target._target_principal == EMAIL
    assert target._target_scopes == ["https://www.googleapis.com/auth/cloud-platform"]


@pytest.mark.parametrize("url", [None, "https://example.test/not-an-sa-url"])
def test_external_account_without_parsable_impersonation_url_names_the_path(tmp_path, url):
    path = _external(tmp_path, url)
    with pytest.raises(ValueError) as e:
        _default_credentials_factory(str(path), URL)
    assert str(path) in str(e.value)
    assert "subject-token" not in str(e.value)
