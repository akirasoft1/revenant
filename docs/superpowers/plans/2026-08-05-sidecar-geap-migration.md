# Sidecar → Gemini Enterprise Agent Platform (GEAP) Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ONLY the agent sidecar's Gemini calls off the consumer AI-Studio endpoint (`generativelanguage.googleapis.com`) onto the Gemini Enterprise Agent Platform (GEAP, the rebranded Vertex AI, `aiplatform.googleapis.com`), so the safety-relaxed (`BLOCK_NONE`) dual-use security workload runs on the enterprise-governed surface instead of the consumer abuse-monitored one.

**Architecture:** The sidecar's ADK `Gemini` model builds its client via `google.genai.Client()`, which selects its backend from environment variables. Migration is therefore **primarily configuration**: set `GOOGLE_GENAI_USE_VERTEXAI=true` + project/location + ADC credentials on the sidecar Deployment; add a small startup log so the active backend is observable (avoids a repeat of the June silent-fallback blindness). Image generation (Imagen) and music (Lyria) stay on the consumer `GEMINI_API_KEY` — unchanged. The bot's OpenAI fallback path is untouched.

**Tech Stack:** Python 3.12, `google-adk` 1.31.1, `google-genai` SDK, GCP (`revenant-discord-bot-2`), Kubernetes (RKE2/Harvester, namespace `discord-article-bot`), Docker Hub `mvilliger/discord-article-bot-agent`.

## Global Constraints

- Migrate **sidecar only**. Do NOT touch ImagenService/LyriaService or the bot's `GEMINI_API_KEY` usage.
- Sidecar model stays **`gemini-3-flash-preview`/`gemini-3.5-flash`** for this migration (backend change only; model bump to `gemini-3.6-flash` is a separate follow-up). Confirm the live `AGENT_MODEL` value before deploy; do not change it here.
- GCP project: **`revenant-discord-bot-2`** (proj# 278098364045), GEAP location **`global`** (VERIFIED 2026-08-05: the Gemini flash models 404 at `us-central1` on this project but serve from `global`), billing already linked.
- Auth: **service-account key mounted via k8s Secret** (WIF not practical on Harvester/RKE2). The key file MUST NOT be committed or baked into an image (`.dockerignore` already excludes `*_key.json`; the sidecar Dockerfile copies only `src/ proto/ requirements.txt`, so it's already safe).
- Image tags pinned to git short-SHA. The sidecar image and its `SANDBOX_BASE_IMAGE` env move in lockstep ONLY when the sandbox base changes — this migration does NOT change the sandbox base, so `SANDBOX_BASE_IMAGE` stays put.
- Sidecar is single-replica `Recreate`. Do NOT scale. Rollout restart is a full stop/start.
- The sidecar receives `GEMINI_API_KEY` via `envFrom: secretRef: discord-article-bot-secrets`. The Vertex flag must take precedence; Task 2 blanks `GEMINI_API_KEY` in the sidecar env as a belt-and-suspenders measure.

---

### Task 1: GCP — enable GEAP API, create service account + key, prove model access

**Files:**
- Create: `agent-sidecar/genai-sa-key.json` (gitignored scratch — verify `git check-ignore` passes; it matches `*_key.json` → NOT ignored by that pattern! use a name that IS ignored, see step)

**Interfaces:**
- Produces: a GCP service account `agent-genai@revenant-discord-bot-2.iam.gserviceaccount.com` with `roles/aiplatform.user`, and a JSON key file on disk for Task 2.

- [ ] **Step 1: Enable the GEAP API on the new project**

```bash
gcloud services enable aiplatform.googleapis.com --project=revenant-discord-bot-2
```
Expected: `Operation ... finished successfully.`

- [ ] **Step 2: Create the service account**

```bash
gcloud iam service-accounts create agent-genai \
  --project=revenant-discord-bot-2 \
  --display-name="agent sidecar GEAP inference"
```

- [ ] **Step 3: Grant the inference role**

```bash
gcloud projects add-iam-policy-binding revenant-discord-bot-2 \
  --member="serviceAccount:agent-genai@revenant-discord-bot-2.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user" --condition=None
```

- [ ] **Step 4: Create a key file (into a path git ignores)**

Confirm the target path is ignored FIRST (repo `.dockerignore` excludes `*_key.json`, and `.gitignore` must too — if not, write to the scratchpad instead):
```bash
git -C /home/ubuntu/workspace/revenant check-ignore agent-sidecar/genai-sa-key.json || echo "NOT IGNORED — use scratchpad path instead"
gcloud iam service-accounts keys create /home/ubuntu/workspace/revenant/agent-sidecar/genai-sa-key.json \
  --iam-account=agent-genai@revenant-discord-bot-2.iam.gserviceaccount.com
```
If the path is not git-ignored, add `agent-sidecar/genai-sa-key.json` to `.gitignore` before creating the key.

- [ ] **Step 5: Prove auth + model availability on GEAP end-to-end (the gating check)**

This validates ADC, the role, AND that `gemini-3.5-flash` answers on the enterprise backend — BEFORE any deployment change.
```bash
cd /home/ubuntu/workspace/revenant/agent-sidecar
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json \
GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
GOOGLE_CLOUD_LOCATION=global \
python3 -c "
from google import genai
c = genai.Client()
print('backend vertexai=', c._api_client.vertexai)
r = c.models.generate_content(model='gemini-3.5-flash', contents='reply with the single word: ok')
print('response:', r.text.strip())
"
```
Expected: `backend vertexai= True` and `response: ok`. If the model 404s on GEAP, STOP — escalate model choice (try `gemini-3.6-flash`) before proceeding.

- [ ] **Step 6: Confirm the Vertex flag wins when GEMINI_API_KEY is also present**

Reproduce the sidecar's real env collision (both a key AND the Vertex flag set):
```bash
cd /home/ubuntu/workspace/revenant/agent-sidecar
GEMINI_API_KEY=dummy-should-be-ignored \
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json \
GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
GOOGLE_CLOUD_LOCATION=global \
python3 -c "from google import genai; print('vertexai=', genai.Client()._api_client.vertexai)"
```
Expected: `vertexai= True` (flag wins). If it prints `False` or errors, Task 2's blanking of `GEMINI_API_KEY` in the sidecar env becomes MANDATORY, not just defensive — note the result.

---

### Task 2: agent.py — make the active backend observable (TDD)

**Files:**
- Modify: `agent-sidecar/src/agent.py` (add `active_genai_backend()` helper near `_build_model`)
- Modify: `agent-sidecar/src/server.py` (log the backend once at startup)
- Test: `agent-sidecar/tests/test_agent_model.py` (add backend-detection tests)

**Interfaces:**
- Produces: `active_genai_backend() -> str` returning `"enterprise"` when `GOOGLE_GENAI_USE_VERTEXAI` or `GOOGLE_GENAI_USE_ENTERPRISE` is truthy, else `"developer-api"`. Used by `server.py` startup logging.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_agent_model.py  (add)
import importlib
from src import agent

def test_backend_enterprise_when_vertex_flag_set(monkeypatch):
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    assert agent.active_genai_backend() == "enterprise"

def test_backend_enterprise_when_enterprise_flag_set(monkeypatch):
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.setenv("GOOGLE_GENAI_USE_ENTERPRISE", "1")
    assert agent.active_genai_backend() == "enterprise"

def test_backend_developer_api_by_default(monkeypatch):
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_ENTERPRISE", raising=False)
    assert agent.active_genai_backend() == "developer-api"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-sidecar && python -m pytest tests/test_agent_model.py -k backend -v`
Expected: FAIL with `AttributeError: module 'src.agent' has no attribute 'active_genai_backend'`

- [ ] **Step 3: Implement the helper**

```python
# agent-sidecar/src/agent.py  (add near top, after imports)
import os

def active_genai_backend() -> str:
    """Which google-genai backend the ADK Gemini path will use, derived from
    the same env vars the SDK reads. 'enterprise' = Gemini Enterprise Agent
    Platform (formerly Vertex AI, aiplatform.googleapis.com); 'developer-api'
    = consumer AI-Studio (generativelanguage.googleapis.com)."""
    for var in ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE"):
        val = os.environ.get(var, "").strip().lower()
        if val in ("1", "true", "yes"):
            return "enterprise"
    return "developer-api"
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd agent-sidecar && python -m pytest tests/test_agent_model.py -k backend -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Log the backend at startup**

In `agent-sidecar/src/server.py`, at the point where the server logs it is coming up (after `config.load()`), add:
```python
from .agent import active_genai_backend
log.info(
    "genai backend=%s project=%s location=%s model=%s",
    active_genai_backend(),
    os.environ.get("GOOGLE_CLOUD_PROJECT", "-"),
    os.environ.get("GOOGLE_CLOUD_LOCATION", "-"),
    os.environ.get("AGENT_MODEL", "gemini-3-flash-preview"),
)
```
(Ensure `import os` and the module `log` exist in server.py; add `import os` if missing.)

- [ ] **Step 6: Run the full sidecar test suite**

Run: `cd agent-sidecar && python -m pytest -q`
Expected: all pass (no regressions).

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/src/agent.py agent-sidecar/src/server.py agent-sidecar/tests/test_agent_model.py
git commit -m "feat(sidecar): expose active genai backend + startup log (GEAP migration)"
```

---

### Task 3: k8s — SA-key Secret + sidecar env/mount wiring

**Files:**
- Modify: `k8s/overlays/deployed/agent-deployment.yaml` (add env vars, volume, volumeMount)
- Create (cluster only): Secret `agent-genai-sa` in namespace `discord-article-bot`

**Interfaces:**
- Consumes: `agent-sidecar/genai-sa-key.json` from Task 1.
- Produces: a sidecar pod whose env selects the GEAP backend.

- [ ] **Step 1: Create the SA-key Secret in the cluster**

```bash
kubectl create secret generic agent-genai-sa \
  -n discord-article-bot \
  --from-file=key.json=/home/ubuntu/workspace/revenant/agent-sidecar/genai-sa-key.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

- [ ] **Step 2: Edit `agent-deployment.yaml` — add env vars**

Under `spec.template.spec.containers[0].env` (after `OTEL_EXPORTER_OTLP_ENDPOINT`), add:
```yaml
            - name: GOOGLE_GENAI_USE_VERTEXAI
              value: "true"
            - name: GOOGLE_CLOUD_PROJECT
              value: "revenant-discord-bot-2"
            - name: GOOGLE_CLOUD_LOCATION
              value: "global"
            - name: GOOGLE_APPLICATION_CREDENTIALS
              value: "/var/secrets/genai/key.json"
            # Belt-and-suspenders: the shared secret injects GEMINI_API_KEY via
            # envFrom below; blank it here so the SDK cannot pick the consumer
            # backend. (Explicit env overrides envFrom.) Confirm Task 1 Step 6.
            - name: GEMINI_API_KEY
              value: ""
```

- [ ] **Step 3: Edit `agent-deployment.yaml` — add volume + mount**

Add a `volumeMounts` entry to the container:
```yaml
          volumeMounts:
            - name: genai-sa
              mountPath: /var/secrets/genai
              readOnly: true
```
Add a `volumes` list to `spec.template.spec` (sibling of `containers`):
```yaml
      volumes:
        - name: genai-sa
          secret:
            secretName: agent-genai-sa
```

- [ ] **Step 4: Sanity-check the manifest parses**

Run: `kubectl apply --dry-run=client -f k8s/overlays/deployed/agent-deployment.yaml`
Expected: `deployment.apps/discord-article-bot-agent configured (dry run)` with no schema errors. (Do NOT apply for real yet — the new image from Task 4 goes out together.)

---

### Task 4: Build, deploy, and verify the cutover

**Files:**
- Modify: `k8s/overlays/deployed/agent-deployment.yaml` (image tag)

**Interfaces:**
- Consumes: committed code from Task 2, wired manifest from Task 3.

- [ ] **Step 1: Get the new sidecar image tag (git SHA after Task 2 commit)**

```bash
SHA=$(git -C /home/ubuntu/workspace/revenant rev-parse --short HEAD); echo "$SHA"
```

- [ ] **Step 2: Build + push the sidecar image**

```bash
cd /home/ubuntu/workspace/revenant/agent-sidecar
docker build -t mvilliger/discord-article-bot-agent:$SHA .
docker push mvilliger/discord-article-bot-agent:$SHA
```
(Do NOT rebuild `sandbox-base`; `SANDBOX_BASE_IMAGE` stays at its current tag.)

- [ ] **Step 3: Set the new image in the manifest, then apply the full deployment**

```bash
cd /home/ubuntu/workspace/revenant
sed -i "s#mvilliger/discord-article-bot-agent:[^\"]*#mvilliger/discord-article-bot-agent:$SHA#" k8s/overlays/deployed/agent-deployment.yaml
kubectl apply -f k8s/overlays/deployed/agent-deployment.yaml
kubectl rollout status deployment/discord-article-bot-agent -n discord-article-bot --timeout=150s
```

- [ ] **Step 4: Verify the backend from the sidecar's own startup log**

```bash
POD=$(kubectl get pods -n discord-article-bot -l app=discord-article-bot-agent -o jsonpath='{.items[0].metadata.name}')
kubectl logs "$POD" -n discord-article-bot | grep -i "genai backend"
```
Expected: `genai backend=enterprise project=revenant-discord-bot-2 location=global model=...`

- [ ] **Step 5: Verify ADC + model live from inside the pod**

```bash
kubectl exec "$POD" -n discord-article-bot -- python3 -c "
from google import genai
c=genai.Client(); print('vertexai=', c._api_client.vertexai)
print(c.models.generate_content(model='gemini-3.5-flash', contents='say ok').text.strip())
"
```
Expected: `vertexai= True` and `ok`.

- [ ] **Step 6: End-to-end — exercise the real sandbox agent path from Discord**

Send a channel-voice message that triggers a `run_in_sandbox` call (e.g. "run `echo hello` in a sandbox"). Then confirm no consumer-API 403 / no silent OpenAI fallback:
```bash
kubectl logs "$POD" -n discord-article-bot --tail=100 | grep -iE "PERMISSION_DENIED|suspended|fallback|generativelanguage" || echo "clean — no consumer-endpoint errors"
```
Expected: `clean — no consumer-endpoint errors`, and the bot reply reflects a real sandbox execution.

- [ ] **Step 7: Commit the manifest change**

```bash
git add k8s/overlays/deployed/agent-deployment.yaml
git commit -m "deploy(sidecar): route Gemini via GEAP (enterprise backend) on revenant-discord-bot-2"
```
(Note: `agent-deployment.yaml` is under the gitignored deployed overlay — this commit only lands if the file is tracked; if `git add` reports it ignored, skip this step, the live cluster is already updated.)

---

### Task 5: Docs + memory

**Files:**
- Modify: `CLAUDE.md` (Agentic Sandbox section)
- Modify: memory `project_gcp_project_rotation.md` (mark BLOCK_NONE risk mitigated for the sidecar)

- [ ] **Step 1: Update CLAUDE.md**

In the "Agentic Sandbox" section, add a line: the sidecar's Gemini calls run on the **Gemini Enterprise Agent Platform** (`GOOGLE_GENAI_USE_VERTEXAI=true`, project `revenant-discord-bot-2`, ADC via the `agent-genai-sa` Secret at `/var/secrets/genai/key.json`), NOT the consumer AI-Studio endpoint. Imagen/Lyria remain on the consumer `GEMINI_API_KEY`.

- [ ] **Step 2: Update memory**

In `project_gcp_project_rotation.md`, note the `BLOCK_NONE` abuse risk is now mitigated for the sidecar (moved to GEAP on 2026-08-05); Imagen/Lyria still on the consumer surface (lower risk). Record the SA `agent-genai@revenant-discord-bot-2` + `roles/aiplatform.user`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: sidecar Gemini runs on GEAP enterprise backend"
```

---

## Follow-ups (out of scope — track separately)

- Bump sidecar `AGENT_MODEL` to `gemini-3.6-flash` (GA, cheaper/more efficient than 3.5-flash) once GEAP is proven.
- `IMAGEGEN_MODEL=gemini-3.1-flash-image-preview` is deprecated on the consumer API and allowlist-only on GEAP — pick a supported successor before it's shut off.
- Decide whether to file an appeal for / delete the abandoned suspended `revenant-discord-bot` project.
