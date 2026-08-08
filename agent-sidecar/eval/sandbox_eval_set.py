"""Labeled prompts for the sandbox-invocation decision.

`expect` is "direct" (the model should answer itself, no sandbox) or "sandbox"
(a correct answer genuinely requires execution). `manual=True` marks the
curated subset handed to the user for live Discord verification.
"""

EVAL_SET = [
    # --- should answer DIRECTLY (no sandbox) ---
    {"prompt": "what's 2 + 7?", "expect": "direct", "manual": True},
    {"prompt": "explain how the TCP three-way handshake works", "expect": "direct", "manual": True},
    {"prompt": "show me the Python syntax for a list comprehension", "expect": "direct", "manual": True},
    {"prompt": "what port does SSH listen on by default?", "expect": "direct", "manual": True},
    {"prompt": "tabs or spaces? what's your take", "expect": "direct", "manual": False},
    {"prompt": "reverse the string 'hello' for me", "expect": "direct", "manual": True},
    {"prompt": "what's the difference between TCP and UDP?", "expect": "direct", "manual": False},
    {"prompt": "give me an example of a bash for-loop", "expect": "direct", "manual": True},
    {"prompt": "what does the chmod 755 permission mean?", "expect": "direct", "manual": False},
    {"prompt": "roughly how many seconds are in a week?", "expect": "direct", "manual": False},
    {"prompt": "summarize what a reverse proxy does in two sentences", "expect": "direct", "manual": False},
    {"prompt": "what's the CIDR notation for a /24 subnet mask?", "expect": "direct", "manual": False},
    {"prompt": "write a regex that matches an IPv4 address (just show it)", "expect": "direct", "manual": False},
    {"prompt": "how would I structure a Python package? just describe it", "expect": "direct", "manual": False},
    {"prompt": "what's your opinion on rust vs go for CLI tools?", "expect": "direct", "manual": False},

    # --- document/authoring asks (should answer directly, no execution needed) ---
    {"prompt": "based on our earlier discussion of the Friday no-work rule, draft section 2(a).",
     "expect": "direct", "manual": True,
     "context": {"system_prompt": "You are the channel's voice. Be casual and direct.",
                 "memory_context": "## Memory Context\nThe crew discussed a 'no-work on Fridays' rule.",
                 "history": [{"role": "user", "content": "we should codify the Friday no-work thing"}]}},
    {"prompt": "craft a short doc from scratch summarizing our nmap tips.",
     "expect": "direct", "manual": True, "context": {"system_prompt": "You are the channel's voice.", "memory_context": "", "history": []}},
    {"prompt": "write up a quick onboarding note for new members.",
     "expect": "direct", "manual": True, "context": {"system_prompt": "You are the channel's voice.", "memory_context": "", "history": []}},

    # --- genuinely needs the SANDBOX ---
    {"prompt": "nmap the top 100 ports on scanme.nmap.org and tell me what's open", "expect": "sandbox", "manual": True},
    {"prompt": "what HTTP response headers does https://example.com return?", "expect": "sandbox", "manual": True},
    {"prompt": "compute the sha256 of the exact string 'correct horse battery staple'", "expect": "sandbox", "manual": True},
    {"prompt": "run this and tell me the EXACT output: import random; random.seed(42); print(random.random())", "expect": "sandbox", "manual": True},
    {"prompt": "resolve the A records for github.com", "expect": "sandbox", "manual": True},
    {"prompt": "benchmark how long it takes python to sort a list of 1,000,000 random ints", "expect": "sandbox", "manual": False},
    {"prompt": "curl https://httpbin.org/uuid and show me the uuid it returns", "expect": "sandbox", "manual": False},
    {"prompt": "generate 5 random UUIDs using python and list them", "expect": "sandbox", "manual": False},
    {"prompt": "what's the current time in the sandbox (run `date -u`)?", "expect": "sandbox", "manual": False},
    {"prompt": "count how many primes there are below 100000", "expect": "sandbox", "manual": False},
    {"prompt": "check if TCP port 443 on cloudflare.com is reachable from the sandbox", "expect": "sandbox", "manual": False},
    {"prompt": "what's the max value in this list: [3,1,4,1,5,9,2,6,5,3,5]", "expect": "direct", "manual": False},
    {"prompt": "what version of openssl is installed in the sandbox?", "expect": "sandbox", "manual": False},
    {"prompt": "fuzz this function with 100 random inputs and report any crash: def f(x): return 10//x", "expect": "sandbox", "manual": False},
    {"prompt": "download https://example.com and tell me the exact byte length of the body", "expect": "sandbox", "manual": False},
]
