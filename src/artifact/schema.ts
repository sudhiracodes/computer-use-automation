/**
 * The capability artifact: a typed, versioned, reviewable description of one UI
 * flow, decoupled from the model transcript that discovered it.
 *
 * Two audiences read this document and both must be served by the same text:
 *
 *   - a human reviewer, who needs to see what the capability does, what it
 *     touches, and which steps are risky, in a git diff;
 *   - a calling agent, which needs a typed input/output contract and stable
 *     machine-readable outcome codes.
 *
 * Everything below is shaped by that constraint. Where the two audiences pull in
 * different directions, the tie-breaker is the reviewer: an artifact nobody can
 * audit is not deployable in a bank regardless of how machine-friendly it is.
 */

import { z } from "zod";
import {
  Action,
  Condition,
  LocatorDescriptor,
  SCREEN_CHANGING_ACTIONS,
  locatorsOf,
  locatorsOfCondition,
  valueRefsOf,
  valueRefsOfCondition,
  valueRefsOfLocator,
  type ValueRef,
} from "./locator.js";

const SEMVER = /^\d+\.\d+\.\d+$/;
const IDENTIFIER = /^[a-z][A-Za-z0-9]*$/;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OUTCOME_CODE = /^[A-Z][A-Z0-9_]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Data classification, declared in the contract rather than inferred later.
 *
 * This drives redaction mechanically: the log writer never has to guess whether
 * a value is sensitive, and a new field cannot be forgotten by a downstream
 * scrubber. It also constrains where a value may flow — a `secret` may not reach
 * a URL, a condition, or an outbound LLM request. Declaring sensitivity next to
 * the field is what makes those checks decidable.
 */
export const Sensitivity = z.enum(["none", "pii", "secret"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ScalarType = z.enum(["string", "number", "boolean"]);
export type ScalarType = z.infer<typeof ScalarType>;

/** One input the calling agent supplies per invocation. */
export const InputField = z.strictObject({
  type: ScalarType,
  /** Written for the calling agent as much as for the reviewer. */
  description: z.string().min(1),
  required: z.boolean().default(true),
  sensitivity: Sensitivity.default("none"),
  /**
   * Illustrative value, for reviewers and for an agent choosing arguments.
   * Rejected on `pii`/`secret` fields — an example is committed to the repo, and
   * "example" is how regulated values leak into version control.
   */
  example: z.string().optional(),
});
export type InputField = z.infer<typeof InputField>;

/** One value the capability returns to its caller. */
export const OutputField = z.strictObject({
  type: ScalarType,
  description: z.string().min(1),
  sensitivity: Sensitivity.default("none"),
  extraction: z.strictObject({
    from: z.enum(["text_content", "field_value"]),
    target: LocatorDescriptor,
    /**
     * Normalization applied to the raw string. Deliberately a small closed set
     * rather than an expression language: an artifact is a document to be
     * reviewed, and embedding arbitrary code in it would make review meaningless
     * and replay unsafe.
     */
    parse: z.enum(["trim", "digits", "currency_to_number"]).default("trim"),
  }),
});
export type OutputField = z.infer<typeof OutputField>;

/** One recorded step. */
export const Step = z.strictObject({
  id: z.string().regex(KEBAB_ID, "step id must be kebab-case"),

  /**
   * Why this step exists, in one human sentence.
   *
   * This is the "and why" half of requirement 3.5. During discovery it is the
   * model's stated reason; in a hand-authored artifact it is the author's. It is
   * also what makes a diff on this file reviewable by someone who has never seen
   * the target application.
   */
  intent: z.string().min(1),

  action: Action,

  /**
   * What must be true once the action has been performed.
   *
   * Required on state-changing actions (see the refinement below). The brief's
   * warning is explicit — assert that you reached the state you expected rather
   * than assuming the click worked — so the schema refuses to represent a click
   * that asserts nothing.
   */
  postcondition: Condition.optional(),

  timeoutMs: z.number().int().positive().max(60_000).default(10_000),

  /**
   * Blast radius, not likelihood of failure.
   *
   *   safe         — reads and navigation; auto-runs.
   *   sensitive    — writes that stop short of committing; runs, flagged in evidence.
   *   irreversible — commits, moves money, deletes; blocked pending explicit approval.
   */
  risk: z.enum(["safe", "sensitive", "irreversible"]).default("safe"),
});
export type Step = z.infer<typeof Step>;

/**
 * A legitimate business result that is not a failure.
 *
 * "No such member" is the canonical case, and conflating it with a crash is the
 * mistake the brief calls out by name. Modelling it here — with a stable code
 * the caller can branch on — is the structural fix.
 *
 * Known outcomes are always terminal. There is deliberately no `terminal: false`
 * variant: a condition the run should absorb and continue past is a `Recovery`.
 * Splitting the two on that axis keeps both meanings crisp, where a boolean flag
 * would create a third category whose semantics nobody could state.
 */
export const KnownOutcome = z.strictObject({
  code: z
    .string()
    .regex(OUTCOME_CODE, "outcome code must be SCREAMING_SNAKE_CASE"),
  description: z.string().min(1),
  detector: Condition,
  /** Returned to the caller verbatim. Must not contain PII. */
  message: z.string().min(1),
  /**
   * Steps after which this detector runs. Omit to check after every step.
   *
   * Scoping matters: a "no records found" banner on the search screen must not
   * be detected as MEMBER_NOT_FOUND while the run is three screens further on.
   */
  checkAfterSteps: z.array(z.string()).optional(),
});
export type KnownOutcome = z.infer<typeof KnownOutcome>;

/**
 * A declared, bounded handler for a condition the run should absorb.
 *
 * Bounded by construction: `maxTimes` has no unlimited value. An unbounded
 * recovery is an infinite loop waiting for a surface that keeps re-showing the
 * same dialog, and "retry until it works" is not a policy anyone can audit.
 */
export const Recovery = z.strictObject({
  id: z.string().regex(KEBAB_ID),
  description: z.string().min(1),
  when: Condition,
  do: z.array(Action).min(1),
  maxTimes: z.number().int().min(1).max(5).default(1),
});
export type Recovery = z.infer<typeof Recovery>;

/**
 * Where this capability came from.
 *
 * `discoveredBy` is load-bearing rather than decorative: a hand-authored
 * artifact must say so. Being able to tell, for any capability in the catalogue,
 * whether a model discovered it or a human wrote it is an integrity property —
 * and it is the difference between disclosing that a fixture was hand-built and
 * quietly implying a model produced it.
 *
 * The transcript is referenced by hash, never embedded: requirement 3.2 asks for
 * an artifact decoupled from the raw model transcript, and a transcript of a run
 * against a banking screen is exactly the kind of content that must not be
 * committed to a repository.
 */
export const Provenance = z.strictObject({
  discoveredBy: z.enum(["llm", "human"]),
  /** Null when hand-authored. Recorded because the provider is swappable. */
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  runId: z.string().min(1),
  discoveredAt: z.iso.datetime(),
  transcriptHash: z.string().regex(SHA256_HEX).nullable(),
  toolVersions: z.record(z.string(), z.string()).default({}),
});
export type Provenance = z.infer<typeof Provenance>;

/** What this capability runs against. */
export const Target = z.strictObject({
  /**
   * Which adapter is required. Only "web" is implemented; the field exists
   * because an artifact must declare its surface for a catalogue to route it,
   * and adding "desktop" later must not be a breaking change.
   */
  surface: z.enum(["web"]),
  app: z.string().min(1),
  /**
   * Version of the target application this was recorded against. The input to
   * drift detection — a rising fallback-tier resolution rate against a given
   * appVersion is the signal that a re-recording is due.
   */
  appVersion: z.string().min(1),
  entryUrl: z.url(),
  /**
   * Which allowlist governs this capability. Referenced rather than inlined so
   * that policy is owned by the operator, not by whoever recorded the flow —
   * an artifact that carried its own permissions could widen them.
   */
  allowlistRef: z.string().min(1),
});
export type Target = z.infer<typeof Target>;

/**
 * The structural half of the schema, without the cross-field invariants below.
 *
 * Exported only so JSON Schema can be emitted from it: JSON Schema cannot express
 * "this parameter names a declared input", so the emitted document is a useful
 * editor/CI aid but is *not* the authority. `CapabilityArtifact` is.
 */
export const CapabilityArtifactShape = z.strictObject({
  /**
   * Format version. Evolution is additive-only under this integer: new optional
   * fields may appear, existing meanings may not change. That is the entire
   * compatibility story, and stating it is more useful than reserving empty
   * fields for features that do not exist yet.
   */
  schemaVersion: z.literal(1),

  /** Stable identity across versions. The name an agent invokes. */
  id: z.string().regex(KEBAB_ID),
  /** Human-facing title. */
  name: z.string().min(1),
  /** Semver of this capability's behaviour, independent of schemaVersion. */
  version: z.string().regex(SEMVER, "version must be semver, e.g. 1.0.0"),

  /**
   * Approval gate. `draft` artifacts exist and can be replayed deliberately;
   * gating unattended invocation on `approved` is Phase 5's job. The state lives
   * in the document because approval is a property of the capability, not of
   * some external table that can drift out of sync with it.
   */
  status: z.enum(["draft", "approved"]),

  /** What the capability does, for both audiences. */
  description: z.string().min(1),

  target: Target,

  inputs: z.record(z.string().regex(IDENTIFIER), InputField),
  outputs: z.record(z.string().regex(IDENTIFIER), OutputField),

  steps: z.array(Step).min(1),

  /**
   * The overall success condition — did the capability achieve its goal?
   *
   * Distinct from the last step's postcondition, which only asserts that the
   * last action landed. Keeping them separate means "the final click worked" and
   * "the member's sub-account now exists" cannot be silently conflated.
   */
  successCondition: Condition,

  knownOutcomes: z.array(KnownOutcome).default([]),
  recoveries: z.array(Recovery).default([]),

  provenance: Provenance,
});

/**
 * Cross-field invariants.
 *
 * These are the difference between a shape and a contract. Each one closes a way
 * an artifact could be internally inconsistent while still parsing — a parameter
 * that names nothing, a detector scoped to a step that does not exist, a secret
 * routed somewhere it would be logged. A malformed capability must fail here, at
 * authoring and in CI, rather than midway through driving a banking screen.
 */
export const CapabilityArtifact = CapabilityArtifactShape.superRefine((doc, ctx) => {
  const stepIds = new Set<string>();
  for (const [i, step] of doc.steps.entries()) {
    if (stepIds.has(step.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", i, "id"],
        message: `duplicate step id "${step.id}"`,
      });
    }
    stepIds.add(step.id);
  }

  // A screen-changing action must assert what it produced.
  for (const [i, step] of doc.steps.entries()) {
    const changesScreen = (SCREEN_CHANGING_ACTIONS as readonly string[]).includes(
      step.action.kind,
    );
    if (changesScreen && !step.postcondition) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", i, "postcondition"],
        message:
          `step "${step.id}" performs a ${step.action.kind} but asserts nothing afterwards. ` +
          `Screen-changing steps require a postcondition — otherwise replay assumes the action worked.`,
      });
    }
  }

  /*
   * Every parameter reference must name a declared input, and every declared input
   * must be referenced.
   *
   * The walk covers every place a ValueRef can hide — including inside a locator's
   * scope and inside detector and recovery conditions — because a reference that
   * only surfaces at replay time defeats the point of validating at authoring time.
   */
  const declaredInputs = new Set(Object.keys(doc.inputs));
  const referencedInputs = new Set<string>();

  const checkRefs = (refs: ValueRef[], path: (string | number)[], where: string): void => {
    for (const ref of refs) {
      if (ref.kind !== "param") continue;
      referencedInputs.add(ref.param);
      if (!declaredInputs.has(ref.param)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `${where} references undeclared input "${ref.param}"`,
        });
      }
    }
  };

  for (const [i, step] of doc.steps.entries()) {
    checkRefs(valueRefsOf(step.action), ["steps", i, "action"], `step "${step.id}"`);
    if (step.postcondition) {
      checkRefs(
        valueRefsOfCondition(step.postcondition),
        ["steps", i, "postcondition"],
        `postcondition of step "${step.id}"`,
      );
    }
  }

  checkRefs(
    valueRefsOfCondition(doc.successCondition),
    ["successCondition"],
    "successCondition",
  );

  for (const [i, outcome] of doc.knownOutcomes.entries()) {
    checkRefs(
      valueRefsOfCondition(outcome.detector),
      ["knownOutcomes", i, "detector"],
      `detector for outcome "${outcome.code}"`,
    );
  }

  for (const [i, recovery] of doc.recoveries.entries()) {
    checkRefs(
      valueRefsOfCondition(recovery.when),
      ["recoveries", i, "when"],
      `trigger for recovery "${recovery.id}"`,
    );
    for (const [j, action] of recovery.do.entries()) {
      checkRefs(
        valueRefsOf(action),
        ["recoveries", i, "do", j],
        `recovery "${recovery.id}"`,
      );
    }
  }

  for (const [name, field] of Object.entries(doc.outputs)) {
    checkRefs(
      valueRefsOfLocator(field.extraction.target),
      ["outputs", name, "extraction", "target"],
      `extraction for output "${name}"`,
    );
  }

  // An input nobody uses is a false promise in the contract.
  for (const name of declaredInputs) {
    if (!referencedInputs.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["inputs", name],
        message:
          `input "${name}" is declared but never used by any step. An unused input misleads ` +
          `every caller that reads this contract.`,
      });
    }
  }

  // A secret must not reach a URL or a condition, both of which get logged.
  for (const [name, field] of Object.entries(doc.inputs)) {
    if (field.sensitivity === "none") continue;
    if (field.example !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["inputs", name, "example"],
        message:
          `input "${name}" is ${field.sensitivity} and must not carry an example — ` +
          `examples are committed to the repository.`,
      });
    }
  }
  const secretParams = new Set(
    Object.entries(doc.inputs)
      .filter(([, f]) => f.sensitivity === "secret")
      .map(([name]) => name),
  );
  for (const [i, step] of doc.steps.entries()) {
    if (step.action.kind !== "navigate") continue;
    const url = step.action.url;
    if (url.kind === "param" && secretParams.has(url.param)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", i, "action", "url"],
        message:
          `step "${step.id}" would place secret input "${url.param}" in a URL. URLs reach ` +
          `access logs, referrers, and browser history.`,
      });
    }
  }

  // Outcome codes are the caller's branch keys — they must be unique.
  const codes = new Set<string>();
  for (const [i, outcome] of doc.knownOutcomes.entries()) {
    if (codes.has(outcome.code)) {
      ctx.addIssue({
        code: "custom",
        path: ["knownOutcomes", i, "code"],
        message: `duplicate outcome code "${outcome.code}"`,
      });
    }
    codes.add(outcome.code);

    for (const [j, stepId] of (outcome.checkAfterSteps ?? []).entries()) {
      if (!stepIds.has(stepId)) {
        ctx.addIssue({
          code: "custom",
          path: ["knownOutcomes", i, "checkAfterSteps", j],
          message: `outcome "${outcome.code}" is scoped to unknown step "${stepId}"`,
        });
      }
    }
  }

  const recoveryIds = new Set<string>();
  for (const [i, recovery] of doc.recoveries.entries()) {
    if (recoveryIds.has(recovery.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["recoveries", i, "id"],
        message: `duplicate recovery id "${recovery.id}"`,
      });
    }
    recoveryIds.add(recovery.id);
  }

  // A recovery action may not itself depend on a parameter that does not exist.
  for (const [i, recovery] of doc.recoveries.entries()) {
    for (const action of recovery.do) {
      for (const ref of valueRefsOf(action)) {
        if (ref.kind === "param" && !declaredInputs.has(ref.param)) {
          ctx.addIssue({
            code: "custom",
            path: ["recoveries", i, "do"],
            message: `recovery "${recovery.id}" references undeclared input "${ref.param}"`,
          });
        }
      }
    }
  }

  // An llm-discovered artifact must name the provider and model that produced it.
  if (doc.provenance.discoveredBy === "llm") {
    if (!doc.provenance.provider || !doc.provenance.model) {
      ctx.addIssue({
        code: "custom",
        path: ["provenance"],
        message:
          "an llm-discovered artifact must record which provider and model discovered it",
      });
    }
  } else if (doc.provenance.provider || doc.provenance.model) {
    ctx.addIssue({
      code: "custom",
      path: ["provenance"],
      message:
        'a hand-authored artifact (discoveredBy: "human") must not claim a provider or model',
    });
  }
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactShape>;

/** Every locator in the document, for drift reporting and safety analysis. */
export function allLocators(doc: CapabilityArtifact): LocatorDescriptor[] {
  const out: LocatorDescriptor[] = [];
  for (const step of doc.steps) {
    out.push(...locatorsOf(step.action));
    if (step.postcondition) out.push(...locatorsOfCondition(step.postcondition));
  }
  out.push(...locatorsOfCondition(doc.successCondition));
  for (const outcome of doc.knownOutcomes) {
    out.push(...locatorsOfCondition(outcome.detector));
  }
  for (const recovery of doc.recoveries) {
    out.push(...locatorsOfCondition(recovery.when));
    for (const action of recovery.do) out.push(...locatorsOf(action));
  }
  for (const output of Object.values(doc.outputs)) {
    out.push(output.extraction.target);
  }
  return out;
}

/** Input names the caller must never log, echo, or send to a model provider. */
export function sensitiveInputNames(
  doc: CapabilityArtifact,
  atLeast: Sensitivity = "pii",
): string[] {
  const rank: Record<Sensitivity, number> = { none: 0, pii: 1, secret: 2 };
  return Object.entries(doc.inputs)
    .filter(([, f]) => rank[f.sensitivity] >= rank[atLeast])
    .map(([name]) => name);
}
