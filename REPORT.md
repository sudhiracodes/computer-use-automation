# Computer-Use Automation System Report

## Architecture

The system is a single-process TypeScript/Node implementation with clean module
boundaries: artifact schema, surface adapter, deterministic replay, discovery,
policy, evidence, and handoff. The target app is a local synthetic MERIDIAN Core
credit-union back-office system. It is intentionally legacy-shaped: iframe shell,
nested tables, generated ids, inconsistent labels, no test ids, and injectable
runtime faults.

The central design choice is record-once, replay-many. Discovery may use an LLM,
but replay is the production path and has no import path to LLM or provider code.
The `LLMProvider` port is provider-neutral; the first adapter is Gemini over HTTP
inside `src/llm/providers/`. Provider request shapes, tool dialects, and API keys
stay at that boundary.

The `SurfaceAdapter` is the portability seam. Everything above it talks in terms of
observations, actions, semantic locators, checks, extraction, snapshots, and
session ownership. The implemented adapter is Playwright web, but the vocabulary is
compatible with desktop accessibility APIs such as UIA or AX.

## Artifact schema

The capability artifact is a Zod-validated, versioned JSON document. It declares
typed inputs, typed outputs, ordered steps, semantic locator descriptors,
postconditions, known business outcomes, recoveries, success condition, target
metadata, and provenance.

Primary locators cannot be CSS selectors or coordinates. A locator is role,
accessible name, match mode, frame path, optional scope, optional ordinal, and
fallbacks. Scoping is what makes table-heavy legacy screens workable: a link named
`View` is not meaningful until it is scoped to the row containing the member id.

Inputs carry sensitivity (`none`, `pii`, `secret`) in the artifact. That lets
validation and evidence code make mechanical decisions: secrets cannot be routed
to URLs, sensitive examples are rejected, and replay/discovery redaction is driven
by the declared contract instead of guessing later.

## Determinism & error handling

Replay executes artifact steps in fixed order through `SurfaceAdapter`. It resolves
targets immediately before each action, never caches handles across iframe
navigation, verifies step postconditions, checks the final success condition, and
extracts declared outputs from intermediate or final screens.

The result contract separates success, business outcome, failure, and intervention.
`MEMBER_NOT_FOUND` is a known business outcome with a stable code, not an exception.
Recoveries are bounded by `maxTimes`; the unexpected-dialog recovery dismisses the
declared interstitial once and then resumes checkpoint verification. Hard failures
include locator misses, ambiguous locators, checkpoint failures, exhausted
recoveries, app errors, session expiry, policy denial, and adapter errors.

Evidence is JSONL. Replay records run start, step start/completion, outputs,
recoveries, failures, and run finish. On failure it also captures a screenshot and
redacted DOM snapshot. DOM redaction masks sensitive attributes and exact
invocation values for inputs marked `secret` or `pii`, including visible text.

## Heterogeneity & multi-tenant

The artifact is surface-neutral above the adapter vocabulary: role, name, scope,
frame path, checks, and actions. A desktop adapter would implement the same
interface using OS accessibility primitives; the artifact does not need browser
selectors to remain meaningful.

For multi-tenant reuse, the durable unit should remain a base artifact per vendor
product/app version plus tenant-specific overrides. The current schema already
separates target metadata, allowlist reference, typed parameters, and semantic
locators. Drift detection would use resolution diagnostics, fallback-tier usage,
app version, and replay failure evidence to decide when a tenant needs an override
or a re-recording.

I did not build a second tenant or desktop adapter. The implemented work keeps the
interfaces narrow enough that those are additions, not rewrites.

## Escalation & handoff

The handoff model is a `SessionLease` with explicit ownership:

`agent -> pending_human -> human -> agent`

Replay requests intervention when an irreversible step lacks an approval token.
The intervention record carries capability id, run id, step id, reason, lease
snapshot, and pause URL. A minimal `OperatorHandoff` accepts control, returns
control, or aborts. The human acts through the same live adapter/session; when the
agent resumes, replay re-checks the interrupted step's checkpoint using the normal
bounded timeout before proceeding.

Replay evidence records `intervention_requested`, `operator_took_control`, coarse
URL/navigation observation while the operator owned the lease, `operator_returned_control`,
and `resume_rechecked`. This is deliberately not full trusted-event capture or
remote co-browsing; it is the smallest real control-transfer mechanism the brief
asks for.

## Safety

Policy is explicit and configurable in `config/allowlist.json`: allowed origins,
allowed routes, denied routes, and allowed action types. Discovery and replay both
evaluate actions through the same policy code. Denied actions fail closed with
`POLICY_DENIED`; there is no silent skip.

Risk is declared on artifact steps. Safe and sensitive actions can run; irreversible
actions require either an approval token or human handoff. The checked-in flow marks
`confirm-open-account` irreversible because it commits the new account.

Secrets are never sent to the model as raw values. Discovery prompts list input
names and sensitivity, and model tools select inventory ids plus input names.
Provider code is isolated under `src/llm/providers/`. Replay evidence redacts
secret and PII invocation values from failure payloads and DOM snapshots. Screenshots
are captured only on failure; pixel-level screenshot redaction is not implemented,
so the mock target avoids rendering raw secrets visibly.

## Cuts

The operator UI is a minimal seam, not a full co-browsing console. It proves lease
ownership, same-session handoff, resume, and evidence ordering; remote viewing,
operator authentication, queues, and trusted low-level event capture are left out.

Only Gemini is implemented as a real provider adapter. The `LLMProvider` port is
small enough to add OpenAI-compatible or Anthropic adapters later.

There is no second tenant, desktop adapter, outcome-probe discovery pass, capability
catalog API, or flakiness scoring. Those would be useful next steps, but the core
submission is the vertical slice: goal-driven discovery, saved capability artifact,
deterministic replay, structured outcomes/failures, safety policy, handoff, and
evidence.
