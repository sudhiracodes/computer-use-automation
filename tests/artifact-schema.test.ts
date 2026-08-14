/**
 * Schema tests.
 *
 * These are deliberately not "does Zod work" tests. Each case below pins one way an
 * artifact could be internally inconsistent *while still being structurally valid
 * JSON of roughly the right shape* — which is exactly the class of bug that would
 * otherwise surface halfway through driving a live banking screen. The structural
 * checks (a missing field, a bad enum) are Zod's job and are not worth restating.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateArtifact } from "../src/artifact/io.js";
import { capabilityContract } from "../src/artifact/contract.js";
import type { CapabilityArtifact } from "../src/artifact/schema.js";

const FIXTURE_PATH = "artifacts/open-savings-sub-account@1.0.0.json";

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
}

/** Deep clone so each test mutates an independent copy. */
function fixture(): Record<string, unknown> {
  return structuredClone(loadFixture());
}

function expectRejected(doc: unknown, matching: RegExp): void {
  const result = validateArtifact(doc);
  expect(result.ok, "expected the artifact to be rejected, but it validated").toBe(false);
  if (result.ok) return;
  const combined = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
  expect(combined).toMatch(matching);
}

describe("the shipped fixture", () => {
  it("validates", () => {
    const result = validateArtifact(loadFixture());
    if (!result.ok) {
      throw new Error(
        `fixture does not validate:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("declares itself hand-authored rather than claiming a model discovered it", () => {
    const result = validateArtifact(loadFixture());
    if (!result.ok) throw new Error("fixture invalid");
    expect(result.artifact.provenance.discoveredBy).toBe("human");
    expect(result.artifact.provenance.provider).toBeNull();
    expect(result.artifact.provenance.model).toBeNull();
  });

  it("never records a CSS selector or coordinate as a primary locator strategy", () => {
    // Structurally guaranteed by the schema — this test documents the guarantee and
    // fails loudly if someone widens the union later.
    const raw = readFileSync(FIXTURE_PATH, "utf8");
    const strategies = [...raw.matchAll(/"strategy":\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(strategies.length).toBeGreaterThan(0);
    expect(new Set(strategies)).toEqual(new Set(["semantic"]));
    expect(raw).not.toMatch(/"(x|y|coordinates?)":/);
  });

  it("marks the commit step irreversible and everything before it not", () => {
    const result = validateArtifact(loadFixture());
    if (!result.ok) throw new Error("fixture invalid");
    const irreversible = result.artifact.steps.filter((s) => s.risk === "irreversible");
    expect(irreversible.map((s) => s.id)).toEqual(["confirm-open-account"]);
    // The irreversible step must be last: anything after a point of no return would
    // mean a failure could leave the system in a committed-but-incomplete state.
    expect(result.artifact.steps.at(-1)?.id).toBe("confirm-open-account");
  });
});

describe("cross-field invariants", () => {
  it("rejects a parameter reference that names no declared input", () => {
    const doc = fixture();
    const steps = doc.steps as Array<Record<string, unknown>>;
    (steps[4]!.action as Record<string, unknown>).value = { kind: "param", param: "membrId" };
    expectRejected(doc, /references undeclared input "membrId"/);
  });

  it("rejects a parameter reference hidden inside a locator scope", () => {
    // The shallow-walk bug this guards against: a ValueRef nested in a scope would
    // pass validation and fail at replay time instead.
    const doc = fixture();
    const steps = doc.steps as Array<Record<string, unknown>>;
    const target = (steps[6]!.action as Record<string, unknown>).target as Record<string, unknown>;
    target.scope = { kind: "table_row", name: { kind: "param", param: "nope" } };
    expectRejected(doc, /references undeclared input "nope"/);
  });

  it("rejects a parameter reference hidden inside a known-outcome detector", () => {
    const doc = fixture();
    const outcomes = doc.knownOutcomes as Array<Record<string, unknown>>;
    outcomes[0]!.detector = { kind: "text_present", text: { kind: "param", param: "ghost" } };
    expectRejected(doc, /references undeclared input "ghost"/);
  });

  it("rejects an input that is declared but never used", () => {
    const doc = fixture();
    (doc.inputs as Record<string, unknown>).unusedThing = {
      type: "string",
      description: "Never referenced by any step.",
    };
    expectRejected(doc, /declared but never used/);
  });

  it("rejects a click that asserts nothing afterwards", () => {
    const doc = fixture();
    const steps = doc.steps as Array<Record<string, unknown>>;
    delete steps[3]!.postcondition;
    expectRejected(doc, /performs a click but asserts nothing afterwards/);
  });

  it("allows type and select to omit a postcondition", () => {
    // The rule is screen-changing actions only. Requiring one per form field would
    // be ceremony that catches nothing.
    const result = validateArtifact(loadFixture());
    if (!result.ok) throw new Error("fixture invalid");
    const typeStep = result.artifact.steps.find((s) => s.id === "enter-operator-id");
    expect(typeStep?.action.kind).toBe("type");
    expect(typeStep?.postcondition).toBeUndefined();
  });

  it("rejects an example on a secret input", () => {
    const doc = fixture();
    const inputs = doc.inputs as Record<string, Record<string, unknown>>;
    inputs.operatorPassword!.example = "hunter2";
    expectRejected(doc, /must not carry an example/);
  });

  it("rejects an example on a pii input", () => {
    const doc = fixture();
    const inputs = doc.inputs as Record<string, Record<string, unknown>>;
    inputs.memberId!.example = "100234";
    expectRejected(doc, /must not carry an example/);
  });

  it("rejects routing a secret into a URL", () => {
    // URLs reach access logs, referrers, and browser history — a secret in one is a
    // leak that redaction downstream cannot undo.
    const doc = fixture();
    const steps = doc.steps as Array<Record<string, unknown>>;
    steps[0]!.action = {
      kind: "navigate",
      url: { kind: "param", param: "operatorPassword" },
    };
    expectRejected(doc, /would place secret input "operatorPassword" in a URL/);
  });

  it("rejects duplicate step ids", () => {
    const doc = fixture();
    const steps = doc.steps as Array<Record<string, unknown>>;
    steps[1]!.id = steps[0]!.id;
    expectRejected(doc, /duplicate step id/);
  });

  it("rejects duplicate outcome codes", () => {
    const doc = fixture();
    const outcomes = doc.knownOutcomes as Array<Record<string, unknown>>;
    outcomes[1]!.code = outcomes[0]!.code;
    expectRejected(doc, /duplicate outcome code/);
  });

  it("rejects an outcome scoped to a step that does not exist", () => {
    const doc = fixture();
    const outcomes = doc.knownOutcomes as Array<Record<string, unknown>>;
    outcomes[0]!.checkAfterSteps = ["no-such-step"];
    expectRejected(doc, /scoped to unknown step "no-such-step"/);
  });

  it("rejects a hand-authored artifact that claims a model", () => {
    const doc = fixture();
    (doc.provenance as Record<string, unknown>).model = "some-model";
    expectRejected(doc, /must not claim a provider or model/);
  });

  it("rejects an llm-discovered artifact with no provider or model recorded", () => {
    const doc = fixture();
    (doc.provenance as Record<string, unknown>).discoveredBy = "llm";
    expectRejected(doc, /must record which provider and model discovered it/);
  });

  it("rejects unknown top-level keys rather than silently ignoring them", () => {
    // A typo'd field must fail loudly. Silently dropping it is how an artifact ends
    // up meaning something other than what its author read.
    const doc = fixture();
    doc.knownOutcome = [];
    expectRejected(doc, /knownOutcome/);
  });

  it("rejects an unbounded recovery", () => {
    const doc = fixture();
    const recoveries = doc.recoveries as Array<Record<string, unknown>>;
    recoveries[0]!.maxTimes = 0;
    expectRejected(doc, /maxTimes/);
  });
});

describe("agent-facing contract", () => {
  function contract() {
    const result = validateArtifact(loadFixture());
    if (!result.ok) throw new Error("fixture invalid");
    return capabilityContract(result.artifact as CapabilityArtifact);
  }

  it("publishes business outcomes so a caller can branch on them", () => {
    expect(contract().outcomes.map((o) => o.code)).toEqual([
      "MEMBER_NOT_FOUND",
      "INVALID_DEPOSIT_AMOUNT",
    ]);
  });

  it("carries sensitivity through to the caller, so a harness can avoid logging it", () => {
    const properties = contract().inputSchema.properties;
    expect(properties.operatorPassword?.["x-sensitivity"]).toBe("secret");
    expect(properties.memberId?.["x-sensitivity"]).toBe("pii");
    expect(properties.operatorId?.["x-sensitivity"]).toBe("none");
  });

  it("never emits an example for a sensitive field", () => {
    for (const [name, property] of Object.entries(contract().inputSchema.properties)) {
      if (property["x-sensitivity"] !== "none") {
        expect(property.examples, `${name} leaked an example`).toBeUndefined();
      }
    }
  });

  it("refuses unknown arguments", () => {
    expect(contract().inputSchema.additionalProperties).toBe(false);
  });

  it("is byte-stable across calls, so a published catalogue does not churn", () => {
    expect(JSON.stringify(contract())).toBe(JSON.stringify(contract()));
  });

  it("surfaces draft status so a harness can refuse unattended use", () => {
    expect(contract().status).toBe("draft");
  });
});
