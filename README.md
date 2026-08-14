# Computer-Use Automation System

An LLM discovers how to complete a task in a legacy UI **once**. What it learned is
recorded as a typed, versioned **capability artifact**. That artifact then replays
**deterministically, with no model in the decision loop** — which is how a production
AI agent invokes it: reliably, cheaply, and reviewably.

> **Status: Phase 1 of 6 complete.** The capability contract and the target
> application exist and are exercisable today. The surface adapter, replay engine,
> discovery agent, safety layer, and handoff are the phases that follow — see
> [Roadmap](#roadmap). `REPORT.md` lands in Phase 6.

## Why this order

The artifact schema was built first, and the next thing built against it is a
**deterministic replay of a hand-authored artifact** — not the LLM recorder.

That is deliberate. Build the recorder first and the contract silently becomes
"whatever the recorder happened to emit." Building a consumer first forces the
contract to be right on its own terms, and it means Phases 1–3 need no API key and no
provider account, so the schema and locator strategy get debugged without model
nondeterminism in the loop.

It has already paid for itself: writing the example artifact against the real screens
exposed four genuine gaps in the schema — see [What Phase 1
found](#what-phase-1-found).

## Setup

Requires Node 20+. No API key, provider account, or network access is needed for
anything currently implemented.

```bash
npm install
```

## Try it

### The target application

A stand-in for a credit-union back-office system, built to be **hostile in the ways
that matter** — see [`target-app/render.ts`](target-app/render.ts) for the full list
and the reasoning.

```bash
npm run target-app       # http://localhost:3000
```

Sign on with the credentials printed at startup, then walk:
`Member Search → 100234 → View → Open Sub-Account → Continue → Confirm`.

**All data is synthetic.** No real credentials, no real PII.

### Induce the runtime failures

The interesting failures in this domain are not layout drift — they are runtime
conditions. Each of the four maps to one arm of the replay result contract:

```
http://localhost:3000/admin          arm/disarm faults, or use ?_fault=<kind>
```

| Fault | Result class it exercises | Reach it directly |
|---|---|---|
| `not_found` | business outcome — `MEMBER_NOT_FOUND` | search member `999999` (**no fault needed**) |
| `unexpected_dialog` | recoverable — bounded interstitial | `/console/member/100234?_fault=unexpected_dialog` |
| `app_error` | hard failure — stop and report | `/console/member/100234?_fault=app_error` |
| `session_expired` | escalation — needs a human | `/console/member/100234?_fault=session_expired` |

`/admin` is **denied to the agent** in [`config/allowlist.json`](config/allowlist.json).
An agent that could reach it could disarm the very conditions the safety model exists
to handle.

### The capability artifact

```bash
# Validate — enforces cross-field invariants, not just shape
npm run cli -- artifact validate "artifacts/open-savings-sub-account@1.0.0.json"

# The agent-facing calling contract: typed args, typed results, business outcomes
npm run cli -- artifact contract "artifacts/open-savings-sub-account@1.0.0.json"

# JSON Schema for the artifact format itself (editor/CI aid)
npm run cli -- artifact schema
```

### Checks

```bash
npm run check     # typecheck + lint + tests
```

## What Phase 1 found

Writing a real artifact against real screens changed the schema four times. Each fix
is the kind that is cheap now and near-impossible to retrofit:

1. **`LocatorScope.name` had to become parameterizable.** Every search-result row has
   a link named "View". The row you want is selected by *data* — the member number, an
   input. A literal would have pinned the artifact to one member and destroyed the
   parameterization that makes it a capability. This produced a general rule: anything
   matching **content** is parameterizable; anything describing **screen structure**
   is not.
2. **`click` on a checkbox is not idempotent**, so it is not deterministic under
   retry — replay it twice and the box ends up wrong. Added a `check` action that
   declares the desired end state and converges.
3. **`nameSource`**, recording which rung of the accessible-name ladder produced a
   name. The target names controls inconsistently on purpose (`aria-label`,
   `<label for>`, `title`, and *nothing at all*). A control whose name used to come
   from `adjacent-cell` and now comes from `label-for` means the app was edited — a
   drift signal, and unrecoverable if not captured at record time.
4. **Postconditions are required on screen-changing actions only.** Requiring one per
   form field was ceremony that caught nothing; requiring one after every click and
   navigation forbids the actual failure — assuming a click worked.

## Design commitments already enforced in code

Not aspirations — each is a test or a type that fails if the claim stops being true.

- **No CSS selector or coordinate can be a primary locator.** The primary strategy is
  structurally fixed to `semantic` (role + accessible name + scope + frame path).
  An artifact targeting by selector *cannot be represented*. That vocabulary is also
  what Windows UIA and macOS AX expose, which is what makes a desktop adapter a
  future addition rather than a rewrite.
- **A secret cannot reach a URL.** Validation rejects it; URLs reach access logs,
  referrers, and history, where downstream redaction cannot help.
- **Sensitive fields cannot carry examples.** Examples get committed to the repo.
- **Business outcomes are first-class.** `MEMBER_NOT_FOUND` is a declared, detectable
  result with a stable code that callers branch on — a different arm of the result
  union from failure. Conflating those two is the mistake this domain punishes most.
- **The LLM sits behind a port, and three ESLint boundaries enforce it** — including
  that replay and the artifact schema have *no import path to a model at all*. The
  tests in [`tests/import-boundary.test.ts`](tests/import-boundary.test.ts) run the
  real config against violating code, because a config that contains a rule proves
  nothing about whether it fires.
- **Provenance cannot lie.** A hand-authored artifact must say so and must not name a
  model; an LLM-discovered one must record which provider and model produced it.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Capability contract + hostile target app | **done** |
| 2 | Surface adapter (a11y-tree inventory, scored resolver) + deterministic replay | next |
| 3 | Error taxonomy, four-way result contract, evidence | |
| 4 | `LLMProvider` port + discovery agent — the mandatory real LLM run | |
| 5 | Allowlist, risk gating, redaction, `SessionLease` handoff | |
| 6 | `README` completion + `REPORT.md` | |

The LLM provider is swappable by config (`LLM_PROVIDER`, `LLM_MODEL`,
`LLM_BASE_URL`) with no change outside `src/llm/`. Two adapters cover nearly
everything: Gemini native, and one OpenAI-compatible adapter that serves Groq,
OpenRouter, Together, DeepSeek, OpenAI, and local Ollama/vLLM. See
[`.env.example`](.env.example).

## Layout

```
config/allowlist.json   permitted origins, routes, action types; /admin denied
src/artifact/           the capability contract — schema, invariants, agent-facing view
src/cli/                operator CLI
target-app/             the hostile mock: 5 screens, 4 faults, synthetic data
artifacts/              capability store
tests/                  invariant tests + boundary enforcement
```
