# sc-knowledge Manifests

These manifests support `sc-knowledge`, a standalone FastMCP (mcp 2.x
`MCPServer`) streamable-HTTP server exposing curated Star Citizen game-data
tools (item lookup, component comparison, faction missions, trade routes,
commodity prices, org guides) at `/mcp` to the agent and voice sidecars. See
`sc-knowledge/README.md` for the service itself.

**These are tracked placeholder manifests** (`deployment.yaml`'s image is
pinned to the literal `mvilliger/sc-knowledge:REPLACE_WITH_SHA`, which does
not exist on Docker Hub). Do not `kubectl apply -f k8s/sc-knowledge/` against
the live cluster -- that rewrites the deployment to a broken tag and stalls
the rollout in `ImagePullBackOff`. Apply from the coordinator-owned,
gitignored **deployed overlay** (`k8s/overlays/deployed/`) instead, same rule
as `k8s/voice/` and `k8s/sandbox/`.

## Files

| File | Purpose |
|---|---|
| `deployment.yaml` | `RollingUpdate` Deployment, 1 replica, port 8080 (`http`), `httpGet /healthz` readiness+liveness (explicit `timeoutSeconds: 2`; `/healthz` never calls upstream -- it reports the cached game version and refreshes it in the background), hardened `securityContext` (non-root uid 1000, read-only rootfs, no capabilities, no privilege escalation), `automountServiceAccountToken: false`. `UEXCORP_BEARER` comes from Secret `sc-knowledge-secrets` (optional -- the service degrades to unauthenticated UEX rate limits without it, never fails to start). |
| `service.yaml` | ClusterIP Service, port 8080 -> 8080. |
| `networkpolicy.yaml` | Ingress from the agent (`app: discord-article-bot-agent`) and voice (`app: discord-article-bot-voice`) sidecar pods on TCP 8080 only. Egress: kube-dns, public TCP 443 (UEX Corp + Star Citizen Wiki APIs, RFC1918 excluded), and Dynatrace OTLP on TCP 4317. |

## Build and push

```bash
docker build -t mvilliger/sc-knowledge:$(git rev-parse --short HEAD) sc-knowledge/
docker push mvilliger/sc-knowledge:$(git rev-parse --short HEAD)
```

## Create the Secret (once, or when the UEX bearer token rotates)

```bash
kubectl create secret generic sc-knowledge-secrets \
  --from-literal=UEXCORP_BEARER=<token> \
  -n discord-article-bot
```

`UEXCORP_BEARER` is optional -- omit the secret entirely (or leave the key
out) to run against UEX's unauthenticated rate limits.

## Apply order

1. Create/update the `sc-knowledge-secrets` Secret (above), if not already present.
2. **Before applying the deployment**, sync org guides into the `sc-org-guides`
   ConfigMap that `deployment.yaml` mounts read-only at `/guides`:
   `scripts/sync-org-guides.sh` (reads the private PDFs under repo-root
   `OrgGuides/`, never committed -- see that script's header). The ConfigMap
   reference on the Deployment is `optional: true`, so skipping this step is
   fine and the pod still starts -- `sc_org_guides` just degrades to
   `{"sections": [], "note": "no org guides loaded"}` rather than failing --
   but run it first when guides should actually be available at startup.
3. Apply the **deployed overlay**, never these tracked placeholders:
   ```bash
   kubectl apply -f k8s/overlays/deployed/sc-knowledge-deployment.yaml \
                 -f k8s/overlays/deployed/sc-knowledge-service.yaml \
                 -f k8s/overlays/deployed/sc-knowledge-networkpolicy.yaml \
                 -n discord-article-bot
   kubectl rollout status deployment/sc-knowledge -n discord-article-bot --timeout=120s
   ```
   Or, for an image-only update:
   ```bash
   kubectl set image deployment/sc-knowledge sc-knowledge=mvilliger/sc-knowledge:<git-short-sha> -n discord-article-bot
   ```

## Sidecar NetworkPolicy egress

Both calling sidecars carry the matching egress rule to reach `sc-knowledge`
on TCP 8080 in-namespace -- `k8s/sandbox/agent-networkpolicy.yaml` (agent)
and `k8s/voice/voice-networkpolicy.yaml` (voice) -- mirrored in their
deployed-overlay copies:

```yaml
    - to:
        - podSelector:
            matchLabels:
              app: sc-knowledge
      ports:
        - { protocol: TCP, port: 8080 }
```

It needs its own rule because the sidecars' public-internet :443 rule
excludes RFC1918, which would otherwise silently drop in-cluster traffic.
This manifest's own NetworkPolicy opens the sc-knowledge side (ingress from
those two sidecars only).

## Host allow-list (421 Invalid Host header)

sc-knowledge's `/mcp` endpoint validates the `Host` header (mcp's
DNS-rebinding protection) against `SC_ALLOWED_HOSTS`, which defaults to every
in-cluster spelling of the Service (`sc-knowledge`,
`sc-knowledge.discord-article-bot`, `...svc`, `...svc.cluster.local`, any
port) plus loopback. A caller using any other name -- a renamed Service, an
ingress hostname -- gets `421 Invalid Host header` on `/mcp` while `/healthz`
stays green; set `SC_ALLOWED_HOSTS` (comma-separated, `name:*` = any port) on
the deployment to add it. A 421 is not a NetworkPolicy problem: the request
reached the pod.

## Smoke test

```bash
kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot &
curl -s localhost:18080/healthz
# {"ok": true, "version": "<git-short-sha>", "game_version": "4.10.1"}
# (game_version is null for the first call after start -- /healthz never
# fetches; it kicks off a background refresh and reports the cached value)
```
