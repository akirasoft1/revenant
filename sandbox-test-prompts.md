# Sandbox-invocation test prompts

Paste these into the Discord channel and watch the behavior.

- **DIRECT** prompts should reply **instantly, with no sandbox run**.
- **SANDBOX** prompts should **visibly spin up and run** the sandbox.

(Deployed sidecar: `mvilliger/discord-article-bot-agent:56973d5`, GEAP / `gemini-3.6-flash`.)

---

## Should answer DIRECTLY (instant, no sandbox)

```
what's 2 + 7?
```
```
explain how the TCP three-way handshake works
```
```
show me the Python syntax for a list comprehension
```
```
what port does SSH listen on by default?
```
```
reverse the string 'hello' for me
```
```
give me an example of a bash for-loop
```

---

## Should RUN the sandbox

```
nmap the top 100 ports on scanme.nmap.org and tell me what's open
```
```
what HTTP response headers does https://example.com return?
```
```
compute the sha256 of the exact string 'correct horse battery staple'
```
```
run this and tell me the EXACT output: import random; random.seed(42); print(random.random())
```
```
resolve the A records for github.com
```

---

## What to look for

- The DIRECT ones landing instantly is the whole point (before this change, ~46% of direct-style asks spun up a pod).
- If a DIRECT prompt still runs the sandbox, note the exact wording — it's a candidate to add to the eval set (`agent-sidecar/eval/sandbox_eval_set.py`) and re-tune.
- If a SANDBOX prompt *refuses* or answers without running, that's the over-correction failure mode — also worth capturing.
- Borderline by design: something like "count how many primes below 100000" may go either way (the model sometimes knows the answer).
