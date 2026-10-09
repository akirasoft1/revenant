"""Seed / clean up the fake members the SC eval's member-hangar cases read.

Standalone on purpose (stdlib + google-auth only, no `src`/`eval` imports) so
it can be piped into the sc-knowledge pod, which mounts Secret `hangar-api-sa`
at /var/secrets/hangar/key.json, carries HANGAR_API_URL, and has Python +
google-auth. Run it ONLY there: the bot image also mounts the key but is a
Node image with no Python or google-auth.

  kubectl exec -i -n discord-article-bot deploy/sc-knowledge -- \
      python - --seed < agent-sidecar/eval/seed_hangar_eval.py      # before the eval
  kubectl exec -i -n discord-article-bot deploy/sc-knowledge -- \
      python - --cleanup < agent-sidecar/eval/seed_hangar_eval.py   # after it

Env: HANGAR_API_URL (also the ID-token audience -- must equal the service's
HANGAR_AUDIENCE byte for byte, no trailing slash), HANGAR_SA_KEY_PATH
(default /var/secrets/hangar/key.json).

Writes go through the real API as the member themselves (X-Acting-Member =
the path member id), so no admin id is needed. `--seed` is idempotent and
resets the two members to EXACTLY the fixture (extra ships deleted, refitted
fixture ships put back to stock -- the hangar chat-edit cases really write;
eval_sc.py also calls `seed()` itself before the run and after every run of
an edit case); `--cleanup`
deletes EVERY ship of the two fake members -- they exist only for the eval.
The ids are fake (no Discord account has them).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HANGAR_MEMBER_AKIRA = "100000000000000001"
HANGAR_MEMBER_MICRO = "100000000000000002"

# (member id, vehicle as the catalog names it, nickname or None)
SEED_SHIPS = [
    (HANGAR_MEMBER_AKIRA, "Vanguard Harbinger", "Harby"),
    (HANGAR_MEMBER_AKIRA, "Constellation Taurus", "Connie"),
    (HANGAR_MEMBER_MICRO, "Avenger Titan", None),
]
MEMBERS = [HANGAR_MEMBER_AKIRA, HANGAR_MEMBER_MICRO]

DEFAULT_KEY_PATH = "/var/secrets/hangar/key.json"
TIMEOUT_S = 30


class HangarSeedError(RuntimeError):
    pass


class UrllibHttp:
    """Tiny JSON-over-HTTP client: request() -> (status, parsed body)."""

    def request(self, method, url, headers=None, body=None):
        req = urllib.request.Request(url, data=body.encode() if body is not None else None,
                                     method=method, headers=dict(headers or {}))
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        try:
            return status, json.loads(raw) if raw else None
        except ValueError:
            return status, raw.decode(errors="replace")


def mint_id_token(audience: str, key_path: str) -> str:
    """Google ID token for `audience` from the service-account key file."""
    import google.auth.transport.requests
    from google.oauth2 import service_account

    creds = service_account.IDTokenCredentials.from_service_account_file(
        key_path, target_audience=audience)
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def _headers(token: str, acting_member: str | None = None) -> dict:
    h = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if acting_member is not None:
        h["X-Acting-Member"] = acting_member
        h["Content-Type"] = "application/json"
    return h


def _check(status, body, what):
    if not 200 <= status < 300:
        raise HangarSeedError(f"{what} failed: HTTP {status}: {json.dumps(body) if not isinstance(body, str) else body}")
    return body


def _hangar(base, member, token, http):
    status, body = http.request("GET", f"{base}/v1/members/{member}/hangar", headers=_headers(token))
    return _check(status, body, f"GET hangar of {member}").get("ships", [])


def seed(base: str, *, token: str, http=None) -> None:
    """Put both fake members' hangars into EXACTLY the SEED_SHIPS state.

    Idempotent, and also the reset the hangar chat-edit cases need between
    runs (they really write: a Hemera fitted into the Connie, a Cutlass Black
    added): a ship matching a fixture entry (vehicle + nickname) is kept, and
    put back to stock (`POST .../ships/{shipId}/reset {"slot": "all"}`) if
    anything is fitted; any other ship of the two members -- and a duplicate
    of a fixture ship -- is deleted; a missing fixture ship is added."""
    http = http or UrllibHttp()
    base = base.rstrip("/")
    for member in MEMBERS:
        wanted = [(vehicle, nickname) for m, vehicle, nickname in SEED_SHIPS if m == member]
        kept: dict = {}
        for ship in _hangar(base, member, token, http):
            key = (ship.get("vehicleName"), ship.get("nickname"))
            if key in wanted and key not in kept:
                kept[key] = ship
                continue
            ship_id = ship["shipId"]
            status, body = http.request("DELETE", f"{base}/v1/members/{member}/ships/{ship_id}",
                                        headers=_headers(token, member))
            _check(status, body, f"DELETE {ship_id} of {member}")
            print(f"seed: {member} -= {ship.get('vehicleName')} ({ship_id}) -- not in the fixture")
        for vehicle, nickname in wanted:
            ship = kept.get((vehicle, nickname))
            if ship is not None:
                if ship.get("fitted"):
                    ship_id = ship["shipId"]
                    status, body = http.request(
                        "POST", f"{base}/v1/members/{member}/ships/{ship_id}/reset",
                        headers=_headers(token, member), body=json.dumps({"slot": "all"}))
                    _check(status, body, f"reset {vehicle} ({ship_id}) of {member}")
                    print(f"seed: {member} {vehicle} ({ship_id}) reset to stock")
                else:
                    print(f"seed: {member} already owns {vehicle} (stock) -- skipped")
                continue
            status, body = http.request(
                "POST", f"{base}/v1/members/{member}/ships", headers=_headers(token, member),
                body=json.dumps({"vehicle": vehicle, "nickname": nickname}))
            ship = _check(status, body, f"POST {vehicle} for {member}").get("ship", {})
            print(f"seed: {member} += {vehicle} (nickname {nickname!r}, shipId {ship.get('shipId')})")


def cleanup(base: str, *, token: str, http=None) -> None:
    http = http or UrllibHttp()
    base = base.rstrip("/")
    for member in MEMBERS:
        for ship in _hangar(base, member, token, http):
            ship_id = ship["shipId"]
            status, body = http.request("DELETE", f"{base}/v1/members/{member}/ships/{ship_id}",
                                        headers=_headers(token, member))
            _check(status, body, f"DELETE {ship_id} of {member}")
            print(f"cleanup: {member} -= {ship.get('vehicleName')} ({ship_id})")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--seed", action="store_true")
    mode.add_argument("--cleanup", action="store_true")
    args = ap.parse_args(argv)

    base = os.environ.get("HANGAR_API_URL", "").strip().rstrip("/")
    if not base:
        print("seed_hangar_eval: HANGAR_API_URL is not set", file=sys.stderr)
        return 2
    key_path = os.environ.get("HANGAR_SA_KEY_PATH", DEFAULT_KEY_PATH)
    token = mint_id_token(base, key_path)
    try:
        (seed if args.seed else cleanup)(base, token=token)
    except HangarSeedError as e:
        print(f"seed_hangar_eval: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
