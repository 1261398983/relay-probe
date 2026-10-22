# relay-probe

**Test any [OI]-compatible or Anthropic-compatible API endpoint in one command.**

Zero dependencies. Node 18+. Works with OpenAI, Claude, Gemini relays, or any gateway that speaks the [OI] chat-completions protocol.

If you pay for an API relay, you want to know three things: *is it up*, *is it really that model*, and *is it billing you for the tokens it claims*. `relay-probe` answers all three.

```bash
npx relay-probe check --url https://api.example.com --key sk-xxx --model gpt-4o-mini
```

```
relay-probe v0.1.0
  endpoint  https://api.example.com
  openai    https://api.example.com/v1
  model     gpt-4o-mini

  [OK] reachability           HTTP 200 in 312ms
  [OK] models endpoint        47 model(s) listed in 288ms
  [OK] model listed           gpt-4o-mini
  [OK] chat completion        891ms, 2 chars back
  [OK] model echo             response reports "gpt-4o-mini"
  [OK] usage block            in=18 out=2 total=20
  [OK] usage math             in + out = total

  ALL PASSED  7 checks in 1843ms
```

---

## Why

API relays are everywhere and most of them are honest. But the failure modes are specific and testable:

| Failure mode | What it looks like | How `relay-probe` catches it |
|---|---|---|
| **Model substitution** | You ask for the flagship, you get a cheaper model | Asks the model to identify itself; compares `model` field in the response to what you requested |
| **Token inflation** | Unit price looks fine, but reported `prompt_tokens` is 30–200% higher than real | Sends a fixed 900-character English text, compares reported tokens against the ~4 chars/token expectation |
| **Broken usage block** | `usage` missing entirely, so you can't audit billing at all | Flags missing `usage` as a hard failure |
| **Math that doesn't add up** | `prompt_tokens + completion_tokens ≠ total_tokens` | Verifies the arithmetic |
| **Silent degradation** | Latency quietly climbing, timeouts on longer prompts | Latency percentiles over N requests, with optional concurrency |

None of this requires trusting the provider. Everything is measured from your side.

---

## Install

```bash
# no install
npx relay-probe --help

# or global
npm i -g relay-probe
```

Requires Node 18 or newer (uses native `fetch`). No dependencies, no build step, ~500 lines of plain JavaScript.

---

## Commands

### `check` — is it alive and is it honest

```bash
relay-probe check --url https://api.example.com --key sk-xxx --model gpt-4o-mini
```

Runs six checks:

1. **reachability** — GET the root, measure round trip
2. **models endpoint** — GET `/v1/models` with your key (401 = key rejected; 404 = not implemented, which is legal but uncommon)
3. **model listed** — is your model in that list? exact match, else closest matches
4. **chat completion** — one minimal request, measure latency and response shape
5. **model echo** — does the response's `model` field match what you asked for?
6. **usage block** — `usage` present? input/output counts present? does `in + out = total`?

Exit code is `0` if everything passed, `1` if anything failed. Safe to use in CI.

### `tokens` — is it inflating your bill

```bash
relay-probe tokens --url https://api.example.com --key sk-xxx --model gpt-4o-mini
```

Sends a fixed, known-length English paragraph (900 characters) and compares the reported `prompt_tokens` against the expected ~225 tokens (English averages ~4 characters per token).

```
[OK] token accounting    reported 231, expected ~225 (+3%)
```

Versus a provider that pads the count:

```
[XX] token accounting    reported 480 vs expected ~225 - 113% inflation
```

A ±30% band is considered normal — different tokenizers vary, and Claude/OpenAI tokenizers disagree on the margins. Anything above +40% is worth asking about.

> **Caveat**: this is a heuristic. It works well on English prose. If you're sending mostly Chinese, emoji, or code, the expected value will be off and the check may mislead you. Use it as a smell test, not a legal instrument.

### `bench` — latency percentiles

```bash
relay-probe bench --url https://api.example.com --key sk-xxx --model gpt-4o-mini --n 20 --concurrency 5
```

```
[OK] bench        20/20 ok in 8432ms (concurrency 5)
[OK] latency      min 412ms · p50 891ms · p95 2104ms · max 2311ms
```

`p95` uses the correct index (`ceil(0.95 × n) − 1`), so with small samples it degrades to the maximum rather than silently returning the median. This matters: a naive `floor(0.95 × n) − 1` gives you the *minimum* when `n = 2`.

### `all` — everything

```bash
relay-probe all --url https://api.example.com --key sk-xxx --model gpt-4o-mini --n 10
```

Runs `check` + `tokens` + streaming + `bench` in one pass.

---

## Options

| Flag | Default | Notes |
|---|---|---|
| `--url` | — | required. With or without trailing `/v1` — both normalize to the same thing |
| `--key` | `RELAY_KEY` | API key |
| `--model` | `` | model to test |
| `--n` | `5` | request count for `bench` |
| `--concurrency` | `1` | parallel requests for `bench` |
| `--timeout` | `30000` | per-request timeout in ms |
| `--json` | off | machine-readable output, one object |
| `--no-color` | off | disable ANSI colors (also auto-off when not a TTY) |

Environment variables: `RELAY_URL`, `RELAY_KEY`, `RELAY_MODEL`.

---

## JSON output

For scripting or dashboards:

```bash
relay-probe check --url ... --key ... --json
```

```json
{
  "endpoint": "https://api.example.com",
  "model": "gpt-4o-mini",
  "command": "check",
  "elapsedMs": 1843,
  "verdict": "ok",
  "results": [
    { "name": "reachability", "level": "ok", "message": "HTTP 200 in 312ms" },
    { "name": "auth", "level": "ok", "message": "key accepted" }
  ]
}
```

`verdict` is `ok` / `warn` / `bad`.

---

## What it does *not* do

Being explicit about the boundaries, because a tool that overclaims is worse than no tool:

- **It does not prove a model is genuine.** It checks the `model` field and asks the model to self-identify. A determined operator can fake both. It catches lazy substitution, not adversarial impersonation.
- **It does not measure real-world latency from your users' location.** It measures from wherever you run it.
- **It does not verify upstream provider legitimacy.** It only sees what the endpoint returns.
- **The token heuristic is English-biased.** See the caveat above.
- **It does not test image, audio, or embedding endpoints.** Text chat only, for now.

If a check says `ok`, that means *this specific test passed*. It does not mean the provider is trustworthy in general.

---

## Related

Written while evaluating API relays for a small project. If you find this useful, the same author maintains a public status page with hourly probes:

- **Status page** — https://1261398983.github.io/ai-api-guide/status/
- **Cost calculator** — https://1261398983.github.io/ai-api-guide/calc/
- **Relay checker (web version)** — https://1261398983.github.io/ai-api-guide/checker/

The web versions do the same checks in-browser (subject to CORS) and can generate copy-paste `curl` commands when CORS blocks them.

---

## License

MIT
