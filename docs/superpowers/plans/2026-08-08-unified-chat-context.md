# Unified Chat Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward the bot's resolved personality + ranked recall + recent history to BOTH the text agent (`ChatRequest`) and the voice Live (`SessionStart`) sidecars via one shared context-builder, so the channel-voice brain always speaks in-voice with memory; the sandbox stays a pure execution tool used only when warranted.

**Architecture:** A new `ChatService.buildTurnContext(...)` returns `{ systemPrompt, memoryBlock, historyTurns }` from the existing assembly helpers. Three consumers use it: the direct-OpenAI path (fallback), the text agent path (via extended `ChatRequest`), and the voice path (via extended `SessionStart`). Each sidecar runs the bot-supplied prompt instead of a generic one; the sandbox executor stays memoryless.

**Tech Stack:** Node/discord.js + `@grpc/grpc-js`; Python `google-adk` (text agent) + `google-genai` Live (voice); protobuf; Jest + pytest.

## Global Constraints

- **Both proto copies stay byte-identical and are hand-synced:** edit `proto/<x>.proto` (root, loaded by Node), copy verbatim to `<sidecar>/proto/<x>.proto`, then run that sidecar's `make protoc`. There is no sync tooling — do all three steps.
- **The sandbox executor never receives memory/history** — it stays a pure code/command runner. Context goes to the *model turn*, not the sandbox.
- **Dual-use preserved:** the text agent keeps GEAP-Gemini `BLOCK_NONE` + `TOOL_AVAILABILITY_PREAMBLE`; do not route dual-use asks to OpenAI. The unified brain runs in the sidecars, not Node.
- **No new secrets, no `:latest` tags** (pin images to git short-SHA at deploy). **Never truncate log messages.**
- **Backward compatible:** an empty `system_prompt` on `ChatRequest` must fall back to the sidecar's `_load_base_prompt()` so an old bot client still works.
- Personality resolution must use the dynamic voice profile (`{VOICE_INSTRUCTIONS}` → `voiceContext.voiceInstructions`), not the static fallback — the whole point is to stop using the static prompt.
- TDD: failing test → minimal impl → green → commit. Node = Jest; sidecars = pytest (`asyncio_mode=auto`).

---

## File Structure

**Bot (Node) — modify:**
- `services/ChatService.js` — add public `buildTurnContext(...)`; route the agent path + direct path through it.
- `services/AgentClient.js` — forward `systemPrompt`/`memoryContext`/`history` in `chat(req)`.
- `services/VoiceService.js` — `_startSession` uses the injected context builder; `sendStart` forwards `history`.
- `services/VoiceClient.js` — `sendStart(s)` maps `history` into the `SessionStart` proto.
- `bot.js` — inject a `contextBuilder` into `VoiceService`; drop the static `config.voice.systemPrompt` pre-fill reliance.

**Protos — modify (root + sidecar copies):**
- `proto/agent.proto` + `agent-sidecar/proto/agent.proto` — `ChatRequest` gains `system_prompt`, `memory_context`, `repeated Turn history`; add `Turn`.
- `proto/voice.proto` + `voice-sidecar/proto/voice.proto` — `SessionStart` gains `repeated Turn history`; add `Turn`.

**Text sidecar — modify:**
- `agent-sidecar/src/agent.py` — `process_chat` + `ChannelVoiceAgent` accept/use `system_prompt`/`memory_context`/`history`.
- `agent-sidecar/src/server.py` — `Chat` passes the new fields through.

**Voice sidecar — modify:**
- `voice-sidecar/src/live_bridge.py` — seed `history` turns via `send_client_content`.

**Eval — modify:**
- `agent-sidecar/eval/sandbox_eval_set.py` — add document/authoring + context-dependent cases (+ optional `context`).
- `agent-sidecar/eval/eval_sandbox_invocation.py` — thread `context` through `_invoked_once` → `process_chat`.

**Docs — modify:** `CLAUDE.md` (Agentic Sandbox section), `features.md`.

---

## Task 1: Shared context-builder `ChatService.buildTurnContext`

**Files:**
- Modify: `services/ChatService.js` (add public method near `_composeRecallContexts`, ~line 262)
- Test: `__tests__/services/ChatService.buildTurnContext.test.js`

**Interfaces:**
- Produces: `async buildTurnContext({ userId, userTag = '', channelId, guildId = null, userMessage, personalityId = 'channel-voice' }) -> { systemPrompt, memoryBlock, historyTurns }` where `systemPrompt` is the personality prompt (with `{VOICE_INSTRUCTIONS}` dynamically substituted) + group-chat instruction + channel/fewshot blocks **but NOT the memory block**; `memoryBlock` is the recall `## Memory Context` string (may be `''`); `historyTurns` is `Array<{ role: 'user'|'assistant', content: string }>` (most-recent-last), from the recent buffer.

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/ChatService.buildTurnContext.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../utils/tokenCounter', () => ({ countTokens: () => 10, wouldExceedLimit: () => false }));
jest.mock('../../personalities', () => ({
  get: () => ({ id: 'channel-voice', name: 'Channel Voice', emoji: '🗣️',
    useVoiceProfile: true, systemPrompt: 'BASE {VOICE_INSTRUCTIONS} END' }),
  getSystemPrompt: () => 'BASE {VOICE_INSTRUCTIONS} END',
}));
const ChatService = require('../../services/ChatService');

function makeChat() {
  const svc = Object.create(ChatService.prototype);
  svc.config = { recall: { enabled: true, promptMaxTokens: 4000 } };
  svc.channelContextService = {
    isChannelTracked: () => true,
    getRecentMessagesRaw: () => ([
      { authorName: 'alice', content: 'hey', isBot: false },
      { authorName: 'bot', content: 'hi', isBot: true },
    ]),
    buildRecentContext: async () => '\n\nRecent channel conversation:\n[alice]: hey',
  };
  svc.voiceProfileService = { getProfile: () => ({ voiceInstructions: 'TALK LIKE THE CREW' }) };
  svc.qdrantService = { search: async () => [] };
  svc.recallService = { recall: async () => ({ block: '\n\n## Memory Context\nalice likes nmap', candidates: [{}], query: 'q' }) };
  svc.mem0Service = { isEnabled: () => false };
  return svc;
}

test('buildTurnContext resolves voice profile, returns separate memory + history', async () => {
  const svc = makeChat();
  const ctx = await svc.buildTurnContext({
    userId: 'u1', channelId: 'c1', userMessage: 'what did alice say?', personalityId: 'channel-voice',
  });
  expect(ctx.systemPrompt).toContain('TALK LIKE THE CREW');   // dynamic voice profile substituted
  expect(ctx.systemPrompt).not.toContain('{VOICE_INSTRUCTIONS}'); // no leftover placeholder
  expect(ctx.systemPrompt).not.toContain('## Memory Context');    // memory kept separate
  expect(ctx.memoryBlock).toContain('alice likes nmap');
  expect(ctx.historyTurns).toEqual([
    { role: 'user', content: 'hey' },
    { role: 'assistant', content: 'hi' },
  ]);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- --testPathPatterns="buildTurnContext"`
Expected: FAIL — `svc.buildTurnContext is not a function`.

- [ ] **Step 3: Implement `buildTurnContext`**

Add to `services/ChatService.js`. Reuse the existing helpers (`_getVoiceContext` ~line 114, `_getRecallContext` ~line 170, `_buildGroupSystemPrompt` ~line 40, `channelContextService.getRecentMessagesRaw`). Map raw buffer messages to turns (`isBot` → `assistant`, else `user`). Assemble `systemPrompt` WITHOUT the memory block by passing `memoryContext=''` to `_buildGroupSystemPrompt` and returning the recall block separately.

```js
async buildTurnContext({ userId, userTag = '', channelId, guildId = null, userMessage, personalityId = 'channel-voice' }) {
  const personality = personalityManager.get(personalityId);
  const user = { id: userId, tag: userTag };
  const voiceContext = await this._getVoiceContext(personalityId, userMessage).catch(() => null);
  const { memoryContext = '', channelContext = '', sharedContext = '' } =
    await this._composeRecallContexts(user, userMessage, channelId, personalityId).catch(() => ({}));
  // systemPrompt WITHOUT the memory block (memory travels as its own field/turn)
  const systemPrompt = this._buildGroupSystemPrompt(personality, '', channelContext, sharedContext, voiceContext);
  const raw = (this.channelContextService && this.channelContextService.isChannelTracked?.(channelId))
    ? (this.channelContextService.getRecentMessagesRaw(channelId, this.config?.channelContext?.promptRecentCount || 10) || [])
    : [];
  const historyTurns = raw
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.isBot ? 'assistant' : 'user', content: m.content }));
  return { systemPrompt, memoryBlock: memoryContext || '', historyTurns };
}
```
Note: `_composeRecallContexts` returns `{ memoryContext, sharedContext, channelContext, voiceContext }` (line ~223); we ignore its `voiceContext` and use our own resolved one for the prompt. If `_composeRecallContexts` isn't suitable for direct reuse, call `_getRecallContext(...)` (line ~170) for `{ memoryContext: recall.block, channelContext }` instead — match whichever the direct path uses at line ~650.

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- --testPathPatterns="buildTurnContext"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/ChatService.js __tests__/services/ChatService.buildTurnContext.test.js
git commit -m "feat(chat): shared buildTurnContext (personality + recall + history)"
```

---

## Task 2: Proto — `ChatRequest` + `SessionStart` gain context fields

**Files:**
- Modify: `proto/agent.proto`, `agent-sidecar/proto/agent.proto`, `proto/voice.proto`, `voice-sidecar/proto/voice.proto`
- Regenerate: `agent-sidecar/src/agent_pb2*.py`, `voice-sidecar/src/voice_pb2*.py`
- Test: `agent-sidecar/tests/test_proto_context_fields.py`, `voice-sidecar/tests/test_proto_context_fields.py`

**Interfaces:**
- Produces: `ChatRequest.system_prompt` (8), `.memory_context` (9), `repeated Turn history` (10); `SessionStart.history` (8); `message Turn { string role = 1; string content = 2; }` in both packages.

- [ ] **Step 1: Edit `proto/agent.proto`** — add inside `ChatRequest` after `image_url` and add `Turn`:

```proto
message Turn {
  string role = 1;     // "user" | "assistant"
  string content = 2;
}
message ChatRequest {
  string user_id = 1;
  string user_tag = 2;
  string channel_id = 3;
  string guild_id = 4;
  string interaction_id = 5;
  string user_message = 6;
  string image_url = 7;
  string system_prompt = 8;
  string memory_context = 9;
  repeated Turn history = 10;
}
```

- [ ] **Step 2: Edit `proto/voice.proto`** — add `Turn` (if not present) and `repeated Turn history = 8;` to `SessionStart`.

- [ ] **Step 3: Copy both root protos to the sidecars**

```bash
cp proto/agent.proto agent-sidecar/proto/agent.proto
cp proto/voice.proto voice-sidecar/proto/voice.proto
```

- [ ] **Step 4: Regenerate stubs**

```bash
cd agent-sidecar && make protoc && cd ..
cd voice-sidecar && make protoc && cd ..
```

- [ ] **Step 5: Write + run stub tests**

```python
# agent-sidecar/tests/test_proto_context_fields.py
from src import agent_pb2
def test_chatrequest_has_context_fields():
    r = agent_pb2.ChatRequest(system_prompt="sp", memory_context="mem",
        history=[agent_pb2.Turn(role="user", content="hi")])
    assert r.system_prompt == "sp" and r.memory_context == "mem"
    assert r.history[0].role == "user" and r.history[0].content == "hi"
```
```python
# voice-sidecar/tests/test_proto_context_fields.py
from src import voice_pb2
def test_sessionstart_has_history():
    s = voice_pb2.SessionStart(system_prompt="sp", recall_context="r",
        history=[voice_pb2.Turn(role="assistant", content="yo")])
    assert s.history[0].content == "yo"
```
Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_proto_context_fields.py -v` → PASS; same for `voice-sidecar`.

- [ ] **Step 6: Node proto-load sanity** — confirm Node still loads both root protos (existing `voiceProto` test + AgentClient test still pass):

Run: `npm test -- --testPathPatterns="voiceProto|AgentClient"` → PASS

- [ ] **Step 7: Commit**

```bash
git add proto/agent.proto proto/voice.proto agent-sidecar/proto/agent.proto voice-sidecar/proto/voice.proto \
  agent-sidecar/src/agent_pb2.py agent-sidecar/src/agent_pb2_grpc.py \
  voice-sidecar/src/voice_pb2.py voice-sidecar/src/voice_pb2_grpc.py \
  agent-sidecar/tests/test_proto_context_fields.py voice-sidecar/tests/test_proto_context_fields.py
git commit -m "feat(proto): ChatRequest + SessionStart carry system_prompt/memory/history"
```

---

## Task 3: Text sidecar consumes context (`agent.py`, `server.py`)

**Files:**
- Modify: `agent-sidecar/src/agent.py` (`ChannelVoiceAgent.process_chat` ~line 236, instruction ~line 275)
- Modify: `agent-sidecar/src/server.py` (`Chat` ~lines 40-43)
- Test: `agent-sidecar/tests/test_agent_context.py`, update `agent-sidecar/tests/test_server_chat_span.py`

**Interfaces:**
- Consumes: `ChatRequest.system_prompt/memory_context/history` (Task 2).
- Produces: `process_chat(self, *, user_id, user_message, system_prompt='', memory_context='', history=None) -> AgentChatResult`. When `system_prompt` non-empty, the agent instruction is `system_prompt + "\n\n" + TOOL_AVAILABILITY_PREAMBLE`; else `self._base_system_prompt + ...` (unchanged fallback). `memory_context` + formatted `history` are prepended to the turn's content as a context block.

- [ ] **Step 1: Write failing tests**

```python
# agent-sidecar/tests/test_agent_context.py
import asyncio
from src.agent import ChannelVoiceAgent, AgentChatResult

class _FakeOrch:
    async def run(self, *a, **k):
        class R: exit_code=0; stdout=""; stderr=""; execution_id="e1"; duration_ms=1
        return R()

def _agent():
    from src.config import load
    import os
    for k,v in {"MONGO_URI":"mongodb://x","SANDBOX_BASE_IMAGE":"img","AGENT_MODEL":"gemini-3.6-flash"}.items():
        os.environ.setdefault(k,v)
    return ChannelVoiceAgent(config=load(), orchestrator=_FakeOrch(), base_system_prompt="FALLBACK")

def test_uses_supplied_system_prompt_over_fallback(monkeypatch):
    captured = {}
    import src.agent as A
    def fake_agent(**kw): captured.update(kw); 
    # capture the instruction the Agent is built with (monkeypatch ADK Agent + runner)
    monkeypatch.setattr(A, "_run_turn", lambda *a, **k: AgentChatResult("ok", [], False), raising=False)
    ag = _agent()
    instr = ag._compose_instruction(system_prompt="VOICEPROMPT")
    assert instr.startswith("VOICEPROMPT")
    assert "FALLBACK" not in instr
    assert "run_in_sandbox" in instr or "sandbox" in instr.lower()  # preamble retained

def test_empty_system_prompt_falls_back():
    ag = _agent()
    instr = ag._compose_instruction(system_prompt="")
    assert instr.startswith("FALLBACK")

def test_context_block_includes_memory_and_history():
    ag = _agent()
    block = ag._compose_context_block(memory_context="## Memory Context\nX", history=[{"role":"user","content":"hey"},{"role":"assistant","content":"hi"}])
    assert "## Memory Context" in block and "hey" in block and "hi" in block
```

- [ ] **Step 2: Run, verify fail**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_agent_context.py -v`
Expected: FAIL — `_compose_instruction`/`_compose_context_block` not defined.

- [ ] **Step 3: Implement in `agent.py`**

Add two small pure helpers on `ChannelVoiceAgent` and thread the new params through `process_chat`:

```python
def _compose_instruction(self, *, system_prompt: str) -> str:
    base = system_prompt.strip() if system_prompt and system_prompt.strip() else self._base_system_prompt
    return f"{base}\n\n{TOOL_AVAILABILITY_PREAMBLE}"

def _compose_context_block(self, *, memory_context: str, history) -> str:
    parts = []
    if memory_context and memory_context.strip():
        parts.append(memory_context.strip())
    if history:
        lines = [f"{('User' if t.get('role')!='assistant' else 'You')}: {t.get('content','')}" for t in history]
        parts.append("## Recent conversation\n" + "\n".join(lines))
    return "\n\n".join(parts)
```
Then in `process_chat` change the signature to accept `system_prompt='', memory_context='', history=None`, build the agent with `instruction=self._compose_instruction(system_prompt=system_prompt)` (replacing line ~275), and build the user content as the context block + the message:
```python
ctx = self._compose_context_block(memory_context=memory_context, history=history)
text = f"{ctx}\n\n{user_message}" if ctx else user_message
new_message = types.Content(role="user", parts=[types.Part(text=text)])
```
(Keep everything else — runner, session_id, sandbox tool, finally-close — identical.)

- [ ] **Step 4: Update `server.py` `Chat`** to pass the new fields:

```python
result = await self._agent.process_chat(
    user_id=request.user_id,
    user_message=request.user_message,
    system_prompt=request.system_prompt,
    memory_context=request.memory_context,
    history=[{"role": t.role, "content": t.content} for t in request.history],
)
```

- [ ] **Step 5: Update `test_server_chat_span.py`** — the `_FakeAgent.process_chat` must accept the new kwargs (add `system_prompt='', memory_context='', history=None` to its signature) so the servicer call still matches.

- [ ] **Step 6: Run tests**

Run: `cd agent-sidecar && .venv/bin/python -m pytest -v` → all PASS (new context tests + existing span/health tests).

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/src/agent.py agent-sidecar/src/server.py agent-sidecar/tests/test_agent_context.py agent-sidecar/tests/test_server_chat_span.py
git commit -m "feat(agent): use bot-supplied system_prompt + memory + history"
```

---

## Task 4: AgentClient forwards context

**Files:**
- Modify: `services/AgentClient.js` (`chat(req)` ~lines 80-88)
- Test: `__tests__/services/AgentClient.test.js` (extend)

**Interfaces:**
- Consumes: `buildTurnContext` output shape.
- Produces: `agentClient.chat({ ..., systemPrompt, memoryContext, history })` maps to proto `system_prompt`, `memory_context`, `history: [{role, content}]`.

- [ ] **Step 1: Write failing test** — assert the request written to the stub includes the new snake_case fields:

```js
test('chat forwards system_prompt, memory_context, history to the proto', async () => {
  const c = makeClient(); c._lastHealthyAt = Date.now();
  let sent;
  c._stub.Chat = (req, opts, cb) => { sent = req; cb(null, { message_text: 'ok', summary: {}, fallback_occurred: false }); };
  await c.chat({ userId: 'u', userMessage: 'hi', systemPrompt: 'SP', memoryContext: 'MEM',
    history: [{ role: 'user', content: 'a' }] });
  expect(sent.system_prompt).toBe('SP');
  expect(sent.memory_context).toBe('MEM');
  expect(sent.history).toEqual([{ role: 'user', content: 'a' }]);
});
```
(Mirror the existing AgentClient test setup — `jest.mock('../../logger')`, proto path, `client._stub.X = (req,opts,cb)=>...`.)

- [ ] **Step 2: Run, verify fail** (`system_prompt` undefined). Run: `npm test -- --testPathPatterns="AgentClient"`.

- [ ] **Step 3: Implement** — extend the request map in `chat(req)`:

```js
{
  user_id: req.userId, user_tag: req.userTag, channel_id: req.channelId,
  guild_id: req.guildId, interaction_id: req.interactionId,
  user_message: req.userMessage, image_url: req.imageUrl || '',
  system_prompt: req.systemPrompt || '',
  memory_context: req.memoryContext || '',
  history: Array.isArray(req.history) ? req.history.map((t) => ({ role: t.role, content: t.content })) : [],
}
```

- [ ] **Step 4: Run test** → PASS. **Step 5: Commit**

```bash
git add services/AgentClient.js __tests__/services/AgentClient.test.js
git commit -m "feat(agent-client): forward system_prompt/memory/history"
```

---

## Task 5: Wire ChatService agent + direct paths through `buildTurnContext`

**Files:**
- Modify: `services/ChatService.js` (`chat(...)` agent branch ~lines 541-549; direct-path prompt build ~line 654)
- Test: `__tests__/services/ChatService.test.js` (agent-routing suite ~lines 1274-1355)

**Interfaces:**
- Consumes: `buildTurnContext` (Task 1), `agentClient.chat` (Task 4).

- [ ] **Step 1: Write failing test** — the agent route must now build + forward context:

```js
test('channel-voice agent route forwards built context', async () => {
  // mockAgentClient.chat resolves { messageText, summary, fallbackOccurred }
  const svc = /* construct with mocks per existing suite */;
  svc.buildTurnContext = jest.fn().mockResolvedValue({
    systemPrompt: 'SP', memoryBlock: 'MEM', historyTurns: [{ role: 'user', content: 'a' }] });
  await svc.chat('channel-voice', 'hello', { id: 'u', tag: 'u#1' }, 'c1', 'g1', null);
  expect(mockAgentClient.chat).toHaveBeenCalledWith(expect.objectContaining({
    systemPrompt: 'SP', memoryContext: 'MEM', history: [{ role: 'user', content: 'a' }] }));
});
```

- [ ] **Step 2: Run, verify fail.** Run: `npm test -- --testPathPatterns="ChatService.test"`.

- [ ] **Step 3: Implement** — in the agent branch, before calling `agentClient.chat`, build context and include it:

```js
const turnCtx = await this.buildTurnContext({
  userId: user.id, userTag: user.tag || user.username || '',
  channelId: channelId || '', guildId: guildId || '', userMessage, personalityId,
}).catch(() => ({ systemPrompt: '', memoryBlock: '', historyTurns: [] }));
const agentResp = await this.agentClient.chat({
  userId: user.id, userTag: user.tag || user.username || '',
  channelId: channelId || '', guildId: guildId || '', interactionId: user.interactionId || '',
  userMessage, imageUrl: imageUrl || '',
  systemPrompt: turnCtx.systemPrompt, memoryContext: turnCtx.memoryBlock, history: turnCtx.historyTurns,
});
```

- [ ] **Step 4: Refactor the direct path to reuse the pieces (DRY, no behavior change).** Where the direct path builds `systemPrompt` (~line 654), obtain it from `buildTurnContext` and concatenate memory for the OpenAI `instructions`:

```js
// direct path (fallback) — reuse the same assembly
const turnCtx = await this.buildTurnContext({ userId: user.id, userTag: user.tag || '', channelId, guildId, userMessage, personalityId });
let systemPrompt = turnCtx.systemPrompt + (turnCtx.memoryBlock || '');
// existing token-guard trim + history formatting continue to operate on systemPrompt/apiInput
```
The existing `ChatService.test.js` + `ChatService.recall.test.js` are the equivalence gate — they must stay green. If exact equivalence is impractical, keep the direct path as-is and note it (the sidecar paths are the priority); flag in the report.

- [ ] **Step 5: Run tests** — `npm test -- --testPathPatterns="ChatService"` → PASS (agent suite + recall suite). Then full `npm test`.

- [ ] **Step 6: Commit**

```bash
git add services/ChatService.js __tests__/services/ChatService.test.js
git commit -m "feat(chat): route agent + direct paths through buildTurnContext"
```

---

## Task 6: VoiceClient forwards history

**Files:**
- Modify: `services/VoiceClient.js` (`sendStart(s)` ~lines 101-112)
- Test: `__tests__/services/VoiceClient.test.js` (extend)

**Interfaces:**
- Produces: `session.sendStart({ ..., history })` writes `session_start.history = [{role, content}]`.

- [ ] **Step 1: Write failing test** — assert `sendStart` payload includes `history`:

```js
test('sendStart forwards history turns', () => {
  // reuse the in-place stubConverse pattern from the existing suite
  session.sendStart({ userId: 'u', systemPrompt: 'SP', recallContext: 'MEM',
    history: [{ role: 'user', content: 'a' }], voiceName: 'Puck' });
  expect(fakeCall.write).toHaveBeenCalledWith({ session_start: expect.objectContaining({
    system_prompt: 'SP', recall_context: 'MEM', history: [{ role: 'user', content: 'a' }] }) });
});
```

- [ ] **Step 2: Run, verify fail.** Run: `npm test -- --testPathPatterns="VoiceClient"`.

- [ ] **Step 3: Implement** — add to the `session_start` object in `sendStart`:

```js
history: Array.isArray(s.history) ? s.history.map((t) => ({ role: t.role, content: t.content })) : [],
```

- [ ] **Step 4: Run test** → PASS. **Step 5: Commit**

```bash
git add services/VoiceClient.js __tests__/services/VoiceClient.test.js
git commit -m "feat(voice-client): forward history in SessionStart"
```

---

## Task 7: Voice sidecar seeds history

**Files:**
- Modify: `voice-sidecar/src/live_bridge.py` (`converse` ~lines 50-55)
- Test: `voice-sidecar/tests/test_live_bridge.py` (extend)

**Interfaces:**
- Consumes: `SessionStart.history` (Task 2).
- Produces: for each `history` turn, a `send_client_content(turns=Content(role=<user|model>, parts=[Part(text=content)]), turn_complete=False)` seeded BEFORE the recall block, in order.

- [ ] **Step 1: Write failing test** — extend `FakeSession` assertion:

```python
async def test_seeds_history_turns_then_recall():
    session = FakeSession([_msg(turn_complete=True)])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(
        user_id="u", system_prompt="SP", recall_context="MEM",
        history=[voice_pb2.Turn(role="user", content="hey"), voice_pb2.Turn(role="assistant", content="hi")]))
    await _drive(bridge, [start], session)
    seeded_texts = [t.parts[0].text for (t, _tc) in session.seeded]
    assert "hey" in seeded_texts and "hi" in seeded_texts and "MEM" in seeded_texts
```

- [ ] **Step 2: Run, verify fail.** Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_live_bridge.py -v`.

- [ ] **Step 3: Implement** — in `converse`, before the existing `recall_context` seeding, seed history (map `assistant`→`model`, else `user`):

```python
for turn in start.history:
    if turn.content:
        await session.send_client_content(
            turns=types.Content(role=("model" if turn.role == "assistant" else "user"),
                                parts=[types.Part(text=turn.content)]),
            turn_complete=False,
        )
```
Keep the existing `recall_context` seeding block after it. (`system_prompt` continues to go in via `_live_config`.)

- [ ] **Step 4: Run tests** → PASS (new + existing). **Step 5: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): seed conversation history into the Live session"
```

---

## Task 8: VoiceService uses the shared builder

**Files:**
- Modify: `services/VoiceService.js` (`_startSession` ~lines 116-155, constructor ~line 18)
- Modify: `bot.js` (VoiceService instantiation — inject the context builder)
- Test: `__tests__/services/VoiceService.test.js` (extend)

**Interfaces:**
- Consumes: an injected `contextBuilder({ userId, userTag, channelId, guildId, userMessage, personalityId }) -> { systemPrompt, memoryBlock, historyTurns }` (bound to `chatService.buildTurnContext`).
- Produces: `sendStart` receives the dynamic `systemPrompt`, `recallContext = memoryBlock`, and `history = historyTurns`.

- [ ] **Step 1: Write failing test** — wake → builder called → sendStart gets dynamic prompt + history:

```js
test('voice start uses the shared context builder', async () => {
  const contextBuilder = jest.fn().mockResolvedValue({
    systemPrompt: 'DYN', memoryBlock: 'MEM', historyTurns: [{ role: 'user', content: 'a' }] });
  const deps = makeDeps({ /* fires wake immediately */ });
  const svc = /* construct VoiceService with { voiceClient, recallService, mongoService, config, deps, contextBuilder } */;
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const session = voiceClient.converse.mock.results[0].value;
  expect(contextBuilder).toHaveBeenCalled();
  expect(session.sendStart).toHaveBeenCalledWith(expect.objectContaining({
    systemPrompt: 'DYN', recallContext: 'MEM', history: [{ role: 'user', content: 'a' }] }));
});
```

- [ ] **Step 2: Run, verify fail.** Run: `npm test -- --testPathPatterns="VoiceService"`.

- [ ] **Step 3: Implement** — accept `contextBuilder` in the constructor; in `_startSession` replace the `recall({recentMessages:[]})` + static prompt with:

```js
let systemPrompt = this._config.voice.systemPrompt || '';
let recallContext = '';
let history = [];
try {
  const ctx = await this._contextBuilder({
    userId, userTag: '', channelId: g.channelId, guildId,
    userMessage: '', personalityId: 'channel-voice',
  });
  systemPrompt = ctx.systemPrompt || systemPrompt;
  recallContext = ctx.memoryBlock || '';
  history = ctx.historyTurns || [];
} catch (e) { logger.warn(`voice: context build failed: ${e.message}`); }
// ...
session.sendStart({ userId, channelId: g.channelId, guildId, systemPrompt, recallContext, history, voiceName: this._config.voice.liveVoice });
```
Note: voice recall uses `userMessage: ''` (no per-utterance query yet — the recall query strategy is `recent-window`, which uses the recent buffer, not the message). If the builder yields an empty recent buffer for a voice channel, `history`/`memoryBlock` are simply empty — acceptable. "Recent history for a voice session" = the shared builder scoped to `g.channelId` (voice transcripts are written to the same store; see deferred note in the spec).

- [ ] **Step 4: Wire `bot.js`** — pass the builder when constructing `VoiceService`:

```js
contextBuilder: (args) => this.chatService.buildTurnContext(args),
```
(Add near the existing `recallService`/`mongoService` wiring; ensure `this.chatService` is assigned before `VoiceService` is constructed — reorder if needed, mirroring the earlier recall-ordering fix.)

- [ ] **Step 5: Run tests** — `npm test -- --testPathPatterns="VoiceService"` then full `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add services/VoiceService.js bot.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): assemble session context via shared builder"
```

---

## Task 9: Expand the offline eval set with the missed classes

**Files:**
- Modify: `agent-sidecar/eval/sandbox_eval_set.py`, `agent-sidecar/eval/eval_sandbox_invocation.py`
- Test: `agent-sidecar/tests/test_sandbox_eval_harness.py` (extend if present)

**Interfaces:**
- Consumes: `process_chat(..., system_prompt, memory_context, history)` (Task 3).
- Produces: eval-set entries may carry optional `context: { system_prompt, memory_context, history }`; `_invoked_once(case)` passes it through.

- [ ] **Step 1: Add labeled cases** to `EVAL_SET` (all `expect="direct"`), including context so behavior is realistic:

```python
{"prompt": "based on our earlier discussion of the Friday no-work rule, draft section 2(a).",
 "expect": "direct", "manual": True,
 "context": {"system_prompt": "You are the channel's voice. Be casual and direct.",
             "memory_context": "## Memory Context\nThe crew discussed a 'no-work on Fridays' rule.",
             "history": [{"role": "user", "content": "we should codify the Friday no-work thing"}]}},
{"prompt": "craft a short doc from scratch summarizing our nmap tips.",
 "expect": "direct", "manual": True, "context": {"system_prompt": "You are the channel's voice.", "memory_context": "", "history": []}},
{"prompt": "write up a quick onboarding note for new members.",
 "expect": "direct", "manual": True, "context": {"system_prompt": "You are the channel's voice.", "memory_context": "", "history": []}},
```

- [ ] **Step 2: Thread context through the runner** — update `_invoked_once` to accept a case dict and pass its context:

```python
async def _invoked_once(case):
    ctx = case.get("context") or {}
    agent = ChannelVoiceAgent(config=load(), orchestrator=FakeOrchestrator(), base_system_prompt=_BASE_PROMPT)
    res = await agent.process_chat(
        user_id="eval", user_message=case["prompt"],
        system_prompt=ctx.get("system_prompt", ""), memory_context=ctx.get("memory_context", ""),
        history=ctx.get("history", []))
    return len(res.execution_ids) > 0
```
Update its call sites to pass the whole `case` (not just `case["prompt"]`).

- [ ] **Step 3: Run the harness scoring unit test** (deterministic, no live model):

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_sandbox_eval_harness.py -v` → PASS.

- [ ] **Step 4: (manual, on-demand) live eval** — document in the eval README that a full run needs GEAP creds; not gated in CI. Note the new classes must score `direct`.

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/eval/sandbox_eval_set.py agent-sidecar/eval/eval_sandbox_invocation.py agent-sidecar/tests/test_sandbox_eval_harness.py agent-sidecar/eval/README.md
git commit -m "test(eval): document/authoring + context-dependent cases with context"
```

---

## Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (Agentic Sandbox section), `features.md`

- [ ] **Step 1: Update `CLAUDE.md`** — in the Agentic Sandbox section, add a "Chat context" note: the bot forwards `system_prompt` (dynamic channel-voice, `{VOICE_INSTRUCTIONS}` substituted) + `memory_context` (ranked recall) + `history` (recent turns) to BOTH the text agent (`ChatRequest`) and voice (`SessionStart`); the sidecar runs the bot's prompt (generic `base.txt` is fallback-only); the sandbox executor still gets no memory. Note the shared builder `ChatService.buildTurnContext`.

- [ ] **Step 2: Update `features.md`** — note channel-voice now replies in-voice with memory on both text and voice paths, and that the sandbox is used only when execution is genuinely required.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md features.md
git commit -m "docs: unified chat context (shared builder, sidecar prompts)"
```

---

## Self-Review

**Spec coverage:**
- Shared context-builder → Task 1 (+ consumed in 5, 8). Proto fields → Task 2. Text sidecar uses context → Task 3. AgentClient forwarding → Task 4. ChatService both paths → Task 5. Voice history transport → Task 6. Voice sidecar seeding → Task 7. VoiceService dynamic build → Task 8. Eval expansion → Task 9. Docs → Task 10. Sandbox-stays-memoryless → preserved (context goes to the model turn only; the `run_in_sandbox` tool signature is untouched in Task 3). Dual-use preserved → text agent keeps `BLOCK_NONE` + preamble (Task 3 leaves them intact). Backward-compat empty prompt → Task 3 `_compose_instruction` fallback.

**Gaps found & resolved inline:**
1. **Direct-path equivalence risk** (Task 5 Step 4): the refactor to route the direct/fallback path through `buildTurnContext` must not change behavior; the existing `ChatService.test.js`/`ChatService.recall.test.js` are the gate, and the task explicitly permits leaving the direct path as-is (with a flagged report) if exact equivalence is impractical — the sidecar paths are the priority.
2. **Voice recall query** (Task 8): voice passes `userMessage: ''`; recall's `recent-window` strategy keys off the recent buffer, so this is fine, but if the voice channel has no tracked buffer, memory/history are empty (acceptable degradation, noted).

**Placeholder scan:** no TBD/TODO; the "resolved in plan" spec deferrals are decided here (text agent folds history into a formatted block; voice seeds structured turns via `send_client_content`; "recent history for voice" = shared builder scoped to the voice `channelId`).

**Type consistency:** `{ systemPrompt, memoryBlock, historyTurns }` is produced by Task 1 and consumed verbatim in Tasks 5 & 8. `history` turns are `{ role, content }` end-to-end (builder → AgentClient/VoiceClient camel → proto snake `Turn{role,content}` → sidecar dict `{"role","content"}`). `memoryBlock` → `memory_context` (agent) / `recall_context` (voice) consistently. `process_chat(..., system_prompt, memory_context, history)` matches between Task 3 (def), Task 3 Step 4 (server call), and Task 9 (eval call).
