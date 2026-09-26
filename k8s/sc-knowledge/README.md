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
| `deployment.yaml` | `RollingUpdate` Deployment, 1 replica, port 8080 (`http`), `httpGet /healthz` readiness+liveness, hardened `securityContext` (non-root uid 1000, read-only rootfs, no capabilities, no privilege escalation), `automountServiceAccountToken: false`. `UEXCORP_BEARER` comes from Secret `sc-knowledge-secrets` (optional -- the service degrades to unauthenticated UEX rate limits without it, never fails to start). |
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
2. Sync org guides into the `sc-knowledge-guides` ConfigMap: `scripts/sync-org-guides.sh`
   (reads the private PDFs under repo-root `OrgGuides/`, never committed -- see that
   script's header). Skipping this is fine; `sc_org_guides` degrades to
   `{"sections": [], "note": "no org guides loaded"}` rather than failing.
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

## Sidecar NetworkPolicy egress (Task 9/11 -- not yet wired here)

Once the agent and voice sidecars gain `sc_*` MCP tool clients, their own
egress NetworkPolicies (`k8s/sandbox/agent-networkpolicy.yaml`,
`k8s/voice/voice-networkpolicy.yaml`) need an additional rule so they can
reach `sc-knowledge` on TCP 8080 in-namespace, e.g.:

```yaml
    - to:
        - podSelector:
            matchLabels:
              app: sc-knowledge
      ports:
        - { protocol: TCP, port: 8080 }
```

This manifest only opens the sc-knowledge side (ingress); the calling
sidecars' egress rules are out of scope for this task.

## Smoke test

```bash
kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot &
curl -s localhost:18080/healthz
# {"ok": true, "version": "<git-short-sha>", "game_version": "4.10.1"}
```
