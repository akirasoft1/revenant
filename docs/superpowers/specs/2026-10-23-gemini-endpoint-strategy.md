# Gemini endpoint strategy: global vs regional, and failover (spike)

Date: 2026-10-23. Status: research spike, no code changed. Branch `spike/gemini-endpoints`.

Legend used below: **[doc]** = verified from an official Google page (URL given); **[src]** = verified by reading the installed library source (google-adk 2.12.0 / google-genai 2.33.0, the versions `pip install "google-adk>=2.10.0"` resolves today, plus the google-adk 2.10.0 wheel for comparison); **[repo]** = verified in this repo; **[inferred]** = my reasoning, not stated by Google; **[community]** = forum reports, not official.

## 1. Recommendation

**Keep `global` as the primary. Do not switch to `us-central1`: `gemini-3.8-flash` is not served there.** Add a failover to the **`us` multi-region endpoint** (`aiplatform.us.rep.googleapis.com`), and make the failover trigger on *slowness* (a client-side timeout), not only on error codes.

Why, tied to today's incident (global, ~15:55–16:11 UTC: one call hung ~534 s and then returned 429, others took 118 s and 375 s, several fast 429s, normal p50 ~3.4 s):

1. **`us-central1` is not an option for this model.** The Gemini 3.8 Flash model page lists only `global` and the multi-regions `us` and `eu` for availability, Standard PayGo and Provisioned Throughput, and `us`/`eu` for ML processing. `us-central1` is not listed [doc: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-8-flash]. That matches `agent-sidecar/CLAUDE.md`, which records that the flash models 404 at `us-central1` on this project [repo]. (The general locations page lists 3.8 Flash under both global and us-central1 when summarised, which conflicts. I trust the model page plus the observed 404. See open question Q1.)
2. **Google's own first-line advice for 429s is the global endpoint**, which we already use: "Use the global endpoint instead of a regional endpoint whenever possible" [doc: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/error-code-429]. Single-region endpoints "have the lowest capacity headroom", and the multi-regions "don't share the `global` endpoint's worldwide throughput capacity" [doc: Standard PayGo page, reached via https://docs.cloud.google.com/vertex-ai/generative-ai/docs/dynamic-shared-quota]. So moving the *primary* away from global would make 429s more likely, not less.
3. **But global is still one shared failure domain.** Today's incident was on global. The Google Cloud status page also shows a 27 Feb 2026 incident titled "Vertex AI Gemini API customers experienced increased error rates when accessing the global endpoint" [doc: https://status.cloud.google.com/summary]. A second, independently pooled endpoint is a real hedge. `us` is the only one that fits: it serves this model, it is near the owner and the cluster, and it keeps ML processing in the US [doc: model page above].
4. **Today's failure was a *hang*, and status-code failover would not have helped.** The bad request sat for ~534 s before its 429 arrived. ADK's built-in `FallbackModel` fails over only on errors that carry a status code (429/500/502/503/504), and a client-side timeout carries none [src: `google/adk/models/_fallback_model.py` `_status_code`, `_should_fall_back`]. So the failover must also fire on a per-attempt timeout, and the timeout must be short enough that a failover still fits inside the 540 s turn budget.

Secondary option, and not a substitute for the above: **Priority PayGo** on global (or `us`). It supports `gemini-3.8-flash`, costs more per token, and "Requests are downgraded to Standard PayGo only when there isn't spare capacity" [doc: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo]. It is a one-header change worth trialling if contention keeps recurring. It does not fix a regional or global outage, and Google documents no latency guarantee for it.

**Provisioned Throughput** is the only option Google positions as assured capacity [doc: 429 page above]. It is out of scope for a hobby bot's budget [inferred].

## 2. Findings

### 2.1 What the global endpoint is
- Hostname `aiplatform.googleapis.com`. "Global endpoints cover the entire world and provide higher availability and reliability than single regions." Choosing it "can improve overall availability and reduce resource exhausted (429) errors" [doc: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations].
- Routing is opaque: "you can't control or know which region your ML processing requests are sent to" [doc: locations]. It "routes requests to the location with the most availability" [doc: Standard PayGo page].
- No data-residency guarantee: "Don't use the global endpoint if you have ML processing requirements" [doc: locations]. That does not matter for this bot [inferred].
- Not available on global: tuning, batch prediction for Anthropic and OpenMaaS models, and RAG corpus management. Provisioned Throughput on global covers only listed models, and Gemini 3.8 Live is not among them [doc: locations]. None of these affect the text agent.
- Pricing: the locations page does not mention any global-vs-regional price difference [doc]. I found no documented price difference for 3.8 Flash between `global` and `us` [inferred, unverified].
- [community] Forum answers say global "does not guarantee free capacity, it only balances traffic", and one user saw the quota dashboard attribute global traffic to a single region: https://discuss.google.dev/t/google-vertex-not-suitable-for-small-production-workloads-in-practice-error-429-resources-exhausted/332643 , https://discuss.google.dev/t/high-429-error-rates-with-gemini-2-0-flash-on-vertex-ai/193339

### 2.2 Regional and multi-region endpoints
- Single-region (for example `us-central1`): "restricted to a single data center cluster" with "the lowest capacity headroom" [doc: Standard PayGo page].
- Multi-region `us` and `eu`: these pool capacity within a geography but don't share global's worldwide pool [doc: same]. REST host `aiplatform.us.rep.googleapis.com` [doc: Priority PayGo page]. google-genai maps `location="us"` to that host automatically (`_MULTI_REGIONAL_LOCATIONS = {'us', 'eu'}`) [src: `google/genai/_api_client.py`].
- `gemini-3.8-flash`: global, `us` and `eu` only. GA since 2026-09-02. Grounding with Google Search is listed as a supported tool for the model [doc: 3.8 Flash model page]. **The page does not say whether Google Search grounding behaves identically on `us`.** A Gemini Enterprise page warns that multi-region APIs "might not produce identical results to the global API" [doc: https://docs.cloud.google.com/gemini/enterprise/docs/locations , a different product, so the relevance is unverified]. This must be tested (Q2).
- The voice sidecar's `gemini-3.8-live` is served only in `us-central1` on this project [repo: `voice-sidecar/CLAUDE.md`], so it is out of scope here. Global Provisioned Throughput doesn't cover it either [doc: locations].

### 2.3 Quota model and 429s
- 3.8 Flash runs on **Standard PayGo with usage tiers**, the successor to Dynamic Shared Quota. The old DSQ URL now lands on the Standard PayGo page. There, a 429 "doesn't indicate that you've hit a fixed quota". Instead it "indicates temporary high contention for a specific shared resource" [doc: Standard PayGo page]. Today's 429s were contention, not a project quota problem [inferred, consistent with the doc].
- Google's 429 guidance: use global; "Implement a retry strategy by using truncated exponential backoff"; smooth traffic and avoid second-level spikes; ramp up gradually; use Provisioned Throughput for consistency [doc: 429 page]. Priority PayGo is suggested for workloads that need more consistent performance [doc: Standard PayGo page].
- Consumption tiers that apply to 3.8 Flash:
  - **Priority PayGo**: header `X-Vertex-AI-LLM-Shared-Request-Type: priority`, on global, `us` and `eu`. It is billed higher. The response's `usageMetadata.trafficType` (SDK: `traffic_type`) reads `ON_DEMAND_PRIORITY`, or `ON_DEMAND` when downgraded. GA since 2026-05-14 [doc: priority-paygo page and release notes].
  - **Flex PayGo**: 50% cheaper with "longer expected latency". Global only and Pre-GA. **Wrong for interactive chat** [doc: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo].
  - ADK 2.12 exposes a `ServiceTier` enum (`flex`/`standard`/`priority`/`deferred`) for the interactions API only [src: `google/adk/models/_service_tier.py`]. We use generateContent, so set the header through `HttpOptions.headers` instead.

### 2.4 Failover patterns and the SDK and ADK seams
- Google's documentation recommends global plus backoff, and Provisioned Throughput or Priority for consistency. **I found no official Google guidance prescribing client-side region failover for Gemini** [doc search, negative result]. Model failover is now a first-class ADK feature: `google.adk.models.FallbackModel` (experimental, on by default, present in 2.10.0 and 2.12.0). It "tries a sequence of models in order", trying each one once. Per-model retry is left to that model's own `retry_options` "so that a single failure is not retried twice over by two layers" [src: `_fallback_model.py`]. Its entries can be `Gemini(...)` instances with their own settings.
- **Location per model instance:** `Gemini(model=..., client_kwargs={"location": "us"})` is documented in ADK's `Gemini` docstring, and those kwargs override the env defaults (`get_gcp_client_defaults`) [src: `google/adk/models/google_llm.py` `api_client`; field present in 2.10.0]. So one process can hold a `global` model and a `us` model side by side. Each builds its own per-event-loop `genai.Client`.
- `FallbackModel` fails over only before the first response is yielded. Our agent runs non-streaming (no `StreamingMode` in `agent-sidecar/src`) [repo], so each model call yields once and can fall back [src docstring].
- **Gap 1, timeouts:** `_status_code()` returns `None` for an `httpx.TimeoutException`, so a timeout never fails over [src].
- **Gap 2, timeouts are retried on the same endpoint:** google-genai's `HttpRetryOptions` predicate retries `httpx.TimeoutException` and `ConnectError`, as well as the listed status codes [src: `_api_client.py` `retry_args`, `_HTTPX_TRANSIENT_EXC`]. With the planned 300 s per-request timeout and 5 attempts, the worst case is about 1,500 s on one endpoint, far over the 540 s turn budget. **The timeout branch should account for this whatever happens with failover.**
- **Gap 3, web search gate:** `_web_search_attached` requires `isinstance(model, Gemini)` [repo: `agent.py`]. A `FallbackModel` wrapper fails that check and would silently drop `google_search`.

### 2.5 Versions
- `requirements.txt` pins only `google-adk[extensions]>=2.10.0`, and google-genai arrives transitively: adk 2.10.0 requires `google-genai>=2.19,<3`, adk 2.12.0 requires `>=2.30,<3` [src: wheel METADATA]. The image therefore floats to the newest compatible versions on each build. Today that is adk 2.12.0 and genai 2.33.0 [inferred about the image; check with `pip freeze` in the running pod].
- `HttpOptions` carries `base_url`, `api_version`, `headers`, `timeout` (milliseconds) and `retry_options` [src: `google/genai/types.py`].
- Discrepancy: `_gemini_retry_options` on `origin/main` is **4 attempts, 0.5 s to 8 s**, matching `agent-sidecar/CLAUDE.md` [repo]. The brief for this spike said 5 attempts, 0.5 s to 15 s, which presumably comes from the in-flight timeout branch. Reconcile when merging.

### 2.6 Probe
**Not run.** Local `gcloud auth print-access-token` fails ("Reauthentication failed. cannot prompt during non-interactive execution"), so I sent no requests. The probe to run, from inside the cluster (local latency would not be representative anyway), is at most 6 calls to each of `https://aiplatform.googleapis.com/v1/projects/revenant-discord-bot-2/locations/global/publishers/google/models/gemini-3.8-flash:generateContent` and `https://aiplatform.us.rep.googleapis.com/v1/projects/revenant-discord-bot-2/locations/us/publishers/google/models/gemini-3.8-flash:generateContent`. Do one more call to `https://us-central1-aiplatform.googleapis.com/...locations/us-central1/...` to confirm the 404. Then make one call to `us` with `tools:[{googleSearch:{}}]` to answer Q2.

## 3. Design sketch (recommended option)

Goal: within the 540 s `AGENT_CHAT_TIMEOUT_SECONDS`, a hung or overloaded `global` call fails over to `us` long before the bot gives up and falls back to OpenAI.

**Files**
- `agent-sidecar/src/config.py`: new env vars:
  - `AGENT_GEMINI_PRIMARY_LOCATION` (default `global`).
  - `AGENT_GEMINI_FALLBACK_LOCATION` (default empty, meaning failover is off. Set it to `us` to enable, so the change can be reverted with a config edit).
  - `AGENT_GEMINI_REQUEST_TIMEOUT_SECONDS`, from the timeout branch. Proposed default about 90 s once failover exists (see the budget below).
  - `AGENT_GEMINI_ATTEMPTS_PER_LOCATION` (default 2).
  - Optional `AGENT_GEMINI_PRIORITY` (`true` sends the Priority header).
- `agent-sidecar/src/agent.py`:
  - `_build_model` returns `Gemini(model, retry_options=…, client_kwargs={"location": primary}, timeout)` when no fallback is set. Otherwise it returns a `RegionFailoverModel` wrapping two such `Gemini`s, the second with `client_kwargs={"location": "us"}`.
  - `RegionFailoverModel` should subclass ADK `FallbackModel` and override `_should_fall_back` to *also* return True for genai/httpx timeout and connect errors. That keeps ADK's request snapshot and rollback logic. The override touches a private method, so pin it with a test that raises `httpx.ReadTimeout` from the primary and asserts the secondary is called (the same posture as the `_install_ws_connect_timeout` monkeypatch). If overriding a private method is unacceptable, write a ~60-line `BaseLlm` wrapper instead. It must handle request snapshots itself.
  - Update `_web_search_attached` to unwrap: search is attached when every delegate is a native `Gemini` that passes `is_gemini_model`. Otherwise the wrapper drops search silently (gap 3).
  - Retry options per location: attempts = `AGENT_GEMINI_ATTEMPTS_PER_LOCATION`, keeping 429/500/502/503/504. Timeouts are retried implicitly by genai.
- `agent-sidecar/src/observability_agent.py` uses `_build_model` too, so it inherits the change.
- `k8s/sandbox/agent-deployment.yaml` (tracked placeholder) and the deployed overlay: add the env vars. **This spike changes neither.**

**Budget arithmetic** [inferred, needs p99 data first]:
- With timeout T = 90 s, 2 attempts per location and backoff of about 1 s, the worst case is 2×90 + 1 + 2×90 ≈ 361 s, under 540 s with room for tool calls in a multi-step turn.
- Note that the per-turn budget covers *all* model calls in a turn (tool loops make several), so T must sit well above the legitimate long tail. Normal p50 is 3.4 s, but a grounded-search call has been seen at 220 s. That call may itself have been contention. Pull p99/p999 of the GenAI call spans before picking T. A first-attempt T of 60–90 s with a second attempt longer is an option.
- `AGENT_CHAT_TIMEOUT_SECONDS` (540) and the bot's 600 s deadline stay unchanged.

**Observability (Dynatrace)**
- On the `agent.chat` span: `gemini.location.primary`, `gemini.location.served` (the endpoint that produced the final answer), `gemini.failover` (bool), `gemini.failover.reason` (`429`/`503`/`timeout`/...), `gemini.failover.count`, and `gemini.traffic_type` from `usage_metadata.traffic_type` when Priority is on.
- The wrapper records these into a per-turn contextvar or accumulator, which `server.py` reads the way it reads `sandbox.call_count` today. Also log one INFO line per failover.
- Example check, after loading the dt-dql-essentials skill and confirming field names:
  `fetch spans | filter span.name == "agent.chat" | summarize turns = count(), failovers = countIf(gemini.failover == true), by: {bin(timestamp, 5m), gemini.location.served}`.
- Alert idea: failover rate above 20% over 15 minutes means global is degraded.

**Tests**
- A timeout fails over.
- A 429 fails over.
- A 400 does not fail over.
- No failover happens after the first response.
- Web search stays attached with the wrapper.
- An unset fallback location is byte-identical to today's model construction.

## 4. Risks and open questions
- **Q1 (blocking):** confirm that `gemini-3.8-flash` 404s on `us-central1` and serves on `us` for project `revenant-discord-bot-2`, with an in-cluster probe. If it *does* serve on `us-central1`, the docs say a single region has the least headroom, so `us` is still the better secondary.
- **Q2:** does Grounding with Google Search work on `us`, with the same `grounding_metadata`? Not documented. If not, the secondary must drop search, or failover is acceptable only on turns without it.
- **Q3:** on the `us` endpoint, is quota or contention independent of global in practice? Google says the pools are distinct [doc], and a forum user saw global traffic billed to one region [community]. If global's backing capacity overlaps `us`, failover helps less during US-wide contention [inferred].
- **Duplicate cost:** a timed-out request may still have been processed and billed. ADK excludes 408 from failover for exactly this reason [src]. That is acceptable for this bot, but adding timeouts to the failover set is a deliberate choice that should be written down.
- **IAM and network:** the `agent-genai@` SA has `roles/aiplatform.user`, which is project-wide and should cover `us` [inferred]. The sidecar NetworkPolicy must allow egress to `aiplatform.us.rep.googleapis.com:443`. Check whether the egress rules use FQDN or IP ranges.
- **The model can differ between endpoints:** answers could vary slightly between global and `us` [doc, Gemini Enterprise caveat]. The failover is announced only through telemetry, not to the user. That matches the existing "degradation is announced" rule only if it is treated as the same model. I'd argue it is the same model and needs no user notice.
- `FallbackModel` is experimental and its private API may shift. Pin the ADK minor version or keep the test.
- Priority PayGo cost is not quantified here, because the pricing page has no multiplier [doc].
