/**
 * Deterministic replay of a capability artifact.
 *
 * No LLM appears in this module, by design. Replay is the production path: a
 * calling agent supplies typed inputs, and the executor walks the already-reviewed
 * artifact in fixed order through a SurfaceAdapter.
 */

import type { Action, Condition } from "../artifact/locator.js";
import type { CapabilityArtifact, KnownOutcome, OutputField, Recovery, Step } from "../artifact/schema.js";
import {
  createReplayEvidenceRecorder,
  type ReplayEvidenceOptions,
  type ReplayEvidenceRecorder,
  type ReplayEvidenceRef,
} from "../evidence/replay-recorder.js";
import type { SurfaceAdapter } from "../surface/adapter.js";

export type ReplayStatus = "success" | "business_outcome" | "failed";

export type ReplayErrorClass =
  | "LOCATOR_UNRESOLVED"
  | "LOCATOR_AMBIGUOUS"
  | "CHECKPOINT_FAILED"
  | "RECOVERY_EXHAUSTED"
  | "TIMEOUT"
  | "APP_ERROR"
  | "SESSION_EXPIRED"
  | "ADAPTER_ERROR";

export type ReplayOutput = string | number | boolean;
export type ReplayOutputs = Record<string, ReplayOutput>;

export interface ReplayStepLog {
  stepId: string;
  intent: string;
  action: string;
  status: "completed" | "failed";
}

export type ReplayResult =
  | {
      status: "success";
      outputs: ReplayOutputs;
      steps: ReplayStepLog[];
      evidence: ReplayEvidenceRef;
    }
  | {
      status: "business_outcome";
      code: string;
      detail: string;
      outputs: ReplayOutputs;
      steps: ReplayStepLog[];
      evidence: ReplayEvidenceRef;
    }
  | {
      status: "failed";
      outputs: ReplayOutputs;
      steps: ReplayStepLog[];
      error: {
        class: ReplayErrorClass;
        stepId: string;
        expected: string;
        observed: string;
      };
      evidence: ReplayEvidenceRef;
    };

export interface ReplayOptions {
  adapter: SurfaceAdapter;
  inputs: Readonly<Record<string, string>>;
  pollIntervalMs?: number;
  evidence?: ReplayEvidenceOptions;
}

const DEFAULT_POLL_INTERVAL_MS = 100;

export async function replayArtifact(
  artifact: CapabilityArtifact,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const steps: ReplayStepLog[] = [];
  const outputs: ReplayOutputs = {};
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const evidence = createReplayEvidenceRecorder(options.evidence);
  const recoveryAttempts = new Map<string, number>();

  await evidence.record({
    type: "run_started",
    artifactId: artifact.id,
    artifactVersion: artifact.version,
  });

  await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs, evidence);

  for (const step of artifact.steps) {
    try {
      await evidence.record({
        type: "step_started",
        stepId: step.id,
        action: step.action.kind,
        intent: step.intent,
      });
      await options.adapter.act(step.action, options.inputs);
      await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs, evidence);

      if (step.postcondition) {
        const state = await waitForStepState(
          artifact,
          options.adapter,
          options.inputs,
          step,
          step.timeoutMs,
          pollIntervalMs,
        );

        if (state.kind === "outcome") {
          steps.push(stepLog(step, "completed"));
          return businessOutcomeResult(state.outcome, step, outputs, steps, evidence);
        }

        if (state.kind === "recovery") {
          const recoveryFailure = await runApplicableRecoveries(
            artifact.recoveries,
            options.adapter,
            options.inputs,
            step,
            recoveryAttempts,
            evidence,
            pollIntervalMs,
            outputs,
            artifact,
          );
          if (recoveryFailure) {
            steps.push(stepLog(step, "failed"));
            return failWithEvidence(options.adapter, outputs, steps, evidence, recoveryFailure);
          }

          const reachedAfterRecovery = await waitForCondition(
            options.adapter,
            step.postcondition,
            options.inputs,
            step.timeoutMs,
            pollIntervalMs,
          );
          if (!reachedAfterRecovery) {
            steps.push(stepLog(step, "failed"));
            const failureClass = await classifyObservedFailure(options.adapter, "CHECKPOINT_FAILED", options.inputs);
            return failWithEvidence(options.adapter, outputs, steps, evidence, {
              class: failureClass,
              stepId: step.id,
              expected: describeCondition(step.postcondition),
              observed: "condition was still false after recovery",
            });
          }
        }

        if (state.kind === "timeout") {
          steps.push(stepLog(step, "failed"));
          const failureClass = await classifyObservedFailure(options.adapter, "CHECKPOINT_FAILED", options.inputs);
          return failWithEvidence(options.adapter, outputs, steps, evidence, {
            class: failureClass,
            stepId: step.id,
            expected: describeCondition(step.postcondition),
            observed: "condition was still false at the step deadline",
          });
        }
        await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs, evidence);
      } else {
        const outcome = await detectKnownOutcome(artifact, options.adapter, options.inputs, step);
        if (outcome) {
          steps.push(stepLog(step, "completed"));
          return businessOutcomeResult(outcome, step, outputs, steps, evidence);
        }

        const recoveryFailure = await runApplicableRecoveries(
          artifact.recoveries,
          options.adapter,
          options.inputs,
          step,
          recoveryAttempts,
          evidence,
          pollIntervalMs,
          outputs,
          artifact,
        );
        if (recoveryFailure) {
          steps.push(stepLog(step, "failed"));
          return failWithEvidence(options.adapter, outputs, steps, evidence, recoveryFailure);
        }
      }

      steps.push(stepLog(step, "completed"));
      await evidence.record({ type: "step_completed", stepId: step.id });
    } catch (error) {
      steps.push(stepLog(step, "failed"));
      return failWithEvidence(options.adapter, outputs, steps, evidence, {
        class: classifyError(error),
        stepId: step.id,
        expected: describeAction(step.action),
        observed: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const success = await waitForCondition(
    options.adapter,
    artifact.successCondition,
    options.inputs,
    10_000,
    pollIntervalMs,
  );
  await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs, evidence);

  if (!success) {
    const failureClass = await classifyObservedFailure(options.adapter, "CHECKPOINT_FAILED", options.inputs);
    return failWithEvidence(options.adapter, outputs, steps, evidence, {
      class: failureClass,
      stepId: "(successCondition)",
      expected: describeCondition(artifact.successCondition),
      observed: "success condition was still false after all steps completed",
    });
  }

  const missingOutput = Object.keys(artifact.outputs).find((name) => outputs[name] === undefined);
  if (missingOutput) {
    return failWithEvidence(options.adapter, outputs, steps, evidence, {
      class: "ADAPTER_ERROR",
      stepId: "(outputs)",
      expected: `extract output "${missingOutput}"`,
      observed: "declared output was not visible on any replayed screen",
    });
  }

  await evidence.record({ type: "run_finished", status: "success" });
  return { status: "success", outputs, steps, evidence: evidence.ref };
}

async function collectVisibleOutputs(
  artifact: CapabilityArtifact,
  adapter: SurfaceAdapter,
  inputs: Readonly<Record<string, string>>,
  outputs: ReplayOutputs,
  evidence: ReplayEvidenceRecorder,
): Promise<void> {
  for (const [name, field] of Object.entries(artifact.outputs)) {
    if (outputs[name] !== undefined) continue;
    const raw = await adapter
      .extract(field.extraction.target, { from: field.extraction.from }, inputs)
      .catch((error: unknown) => {
        if (isOutputNotCurrentlyVisible(error)) return null;
        throw error;
      });
    if (raw === null) continue;
    outputs[name] = parseOutput(name, field, raw);
    await evidence.record({ type: "output_extracted", name });
  }
}

async function detectKnownOutcome(
  artifact: CapabilityArtifact,
  adapter: SurfaceAdapter,
  inputs: Readonly<Record<string, string>>,
  step: Step,
): Promise<KnownOutcome | null> {
  for (const outcome of artifact.knownOutcomes) {
    if (outcome.checkAfterSteps && !outcome.checkAfterSteps.includes(step.id)) continue;
    if (await adapter.check(outcome.detector, inputs)) return outcome;
  }
  return null;
}

type StepState =
  | { kind: "checkpoint" }
  | { kind: "outcome"; outcome: KnownOutcome }
  | { kind: "recovery" }
  | { kind: "timeout" };

async function waitForStepState(
  artifact: CapabilityArtifact,
  adapter: SurfaceAdapter,
  inputs: Readonly<Record<string, string>>,
  step: Step,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<StepState> {
  const deadline = Date.now() + timeoutMs;
  do {
    const outcome = await detectKnownOutcome(artifact, adapter, inputs, step);
    if (outcome) return { kind: "outcome", outcome };
    for (const recovery of artifact.recoveries) {
      if (await adapter.check(recovery.when, inputs)) return { kind: "recovery" };
    }
    if (step.postcondition && (await adapter.check(step.postcondition, inputs))) {
      return { kind: "checkpoint" };
    }
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return { kind: "timeout" };
}

async function businessOutcomeResult(
  outcome: KnownOutcome,
  step: Step,
  outputs: ReplayOutputs,
  steps: ReplayStepLog[],
  evidence: ReplayEvidenceRecorder,
): Promise<ReplayResult> {
  await evidence.record({
    type: "business_outcome",
    stepId: step.id,
    code: outcome.code,
    message: outcome.message,
  });
  await evidence.record({ type: "run_finished", status: "business_outcome" });
  return {
    status: "business_outcome",
    code: outcome.code,
    detail: outcome.message,
    outputs,
    steps,
    evidence: evidence.ref,
  };
}

interface FailureInput {
  class: ReplayErrorClass;
  stepId: string;
  expected: string;
  observed: string;
}

async function runApplicableRecoveries(
  recoveries: readonly Recovery[],
  adapter: SurfaceAdapter,
  inputs: Readonly<Record<string, string>>,
  step: Step,
  attempts: Map<string, number>,
  evidence: ReplayEvidenceRecorder,
  pollIntervalMs: number,
  outputs: ReplayOutputs,
  artifact: CapabilityArtifact,
): Promise<FailureInput | null> {
  for (const recovery of recoveries) {
    if (!(await adapter.check(recovery.when, inputs))) continue;
    const used = attempts.get(recovery.id) ?? 0;
    if (used >= recovery.maxTimes) {
      return {
        class: "RECOVERY_EXHAUSTED",
        stepId: step.id,
        expected: `recovery "${recovery.id}" to clear ${describeCondition(recovery.when)}`,
        observed: `recovery trigger still present after ${used} attempt(s)`,
      };
    }

    const attempt = used + 1;
    attempts.set(recovery.id, attempt);
    await evidence.record({
      type: "recovery_started",
      stepId: step.id,
      recoveryId: recovery.id,
      attempt,
      maxTimes: recovery.maxTimes,
    });

    for (const action of recovery.do) {
      await adapter.act(action, inputs);
    }

    await waitUntilFalse(adapter, recovery.when, inputs, 2_000, pollIntervalMs);
    await collectVisibleOutputs(artifact, adapter, inputs, outputs, evidence);
    await evidence.record({ type: "recovery_completed", stepId: step.id, recoveryId: recovery.id });
  }
  return null;
}

async function waitForCondition(
  adapter: SurfaceAdapter,
  condition: Condition,
  inputs: Readonly<Record<string, string>>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await adapter.check(condition, inputs)) return true;
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return adapter.check(condition, inputs);
}

async function waitUntilFalse(
  adapter: SurfaceAdapter,
  condition: Condition,
  inputs: Readonly<Record<string, string>>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await adapter.check(condition, inputs))) return true;
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return !(await adapter.check(condition, inputs));
}

function parseOutput(name: string, field: OutputField, raw: string): ReplayOutput {
  const normalized = parseRaw(field.extraction.parse, raw);
  switch (field.type) {
    case "string":
      return String(normalized);
    case "number": {
      const n = typeof normalized === "number" ? normalized : Number(normalized);
      if (!Number.isFinite(n)) {
        throw new Error(`output "${name}" could not be parsed as a number from ${JSON.stringify(raw)}`);
      }
      return n;
    }
    case "boolean":
      if (typeof normalized === "boolean") return normalized;
      if (/^(true|yes|1)$/i.test(String(normalized))) return true;
      if (/^(false|no|0)$/i.test(String(normalized))) return false;
      throw new Error(`output "${name}" could not be parsed as a boolean from ${JSON.stringify(raw)}`);
  }
}

function parseRaw(parse: OutputField["extraction"]["parse"], raw: string): string | number {
  switch (parse) {
    case "trim":
      return raw.trim();
    case "digits":
      return raw.replace(/\D+/g, "");
    case "currency_to_number": {
      const cleaned = raw.trim().replace(/[$,]/g, "");
      const n = Number(cleaned);
      if (!Number.isFinite(n)) {
        throw new Error(`could not parse currency value ${JSON.stringify(raw)}`);
      }
      return n;
    }
  }
}

function classifyError(error: unknown): ReplayErrorClass {
  if (!(error instanceof Error)) return "ADAPTER_ERROR";
  if (error.name === "LocatorUnresolvedError" || error.name === "FrameNotFoundError") {
    return "LOCATOR_UNRESOLVED";
  }
  if (error.name === "LocatorAmbiguousError") return "LOCATOR_AMBIGUOUS";
  if (error.name === "TimeoutError") return "TIMEOUT";
  return "ADAPTER_ERROR";
}

async function classifyObservedFailure(
  adapter: SurfaceAdapter,
  fallback: ReplayErrorClass,
  inputs: Readonly<Record<string, string>>,
): Promise<ReplayErrorClass> {
  if (
    await adapter.check(
      { kind: "text_present", text: { kind: "literal", value: "Application Error" }, nameMatch: "contains" },
      inputs,
    )
  ) {
    return "APP_ERROR";
  }
  if (
    await adapter.check(
      { kind: "text_present", text: { kind: "literal", value: "Your session has timed out" }, nameMatch: "contains" },
      inputs,
    )
  ) {
    return "SESSION_EXPIRED";
  }
  return fallback;
}

function isOutputNotCurrentlyVisible(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "FrameNotFoundError" ||
    error.name === "LocatorUnresolvedError" ||
    /Execution context was destroyed|Cannot find context with specified id/.test(error.message)
  );
}

async function failWithEvidence(
  adapter: SurfaceAdapter,
  outputs: ReplayOutputs,
  steps: ReplayStepLog[],
  evidence: ReplayEvidenceRecorder,
  error: FailureInput,
): Promise<ReplayResult> {
  const snapshot = await adapter.snapshot().catch(() => null);
  const snapshotPaths = snapshot ? await evidence.captureFailureSnapshot(snapshot) : {};
  await evidence.record({
    type: "failure",
    stepId: error.stepId,
    class: error.class,
    expected: error.expected,
    observed: error.observed,
    ...snapshotPaths,
  });
  await evidence.record({ type: "run_finished", status: "failed" });
  return {
    status: "failed",
    outputs,
    steps,
    error: {
      class: error.class,
      stepId: error.stepId,
      expected: error.expected,
      observed: error.observed,
    },
    evidence: evidence.ref,
  };
}

function stepLog(step: Step, status: ReplayStepLog["status"]): ReplayStepLog {
  return {
    stepId: step.id,
    intent: step.intent,
    action: step.action.kind,
    status,
  };
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case "navigate":
      return "navigate to the recorded URL";
    case "click":
      return `click ${describeTarget(action.target.role, action.target.name)}`;
    case "type":
      return `type into ${describeTarget(action.target.role, action.target.name)}`;
    case "select":
      return `select an option in ${describeTarget(action.target.role, action.target.name)}`;
    case "check":
      return `set ${describeTarget(action.target.role, action.target.name)} to ${action.checked}`;
    case "key":
      return action.target
        ? `press ${action.key} in ${describeTarget(action.target.role, action.target.name)}`
        : `press ${action.key}`;
    case "wait_for":
      return describeCondition(action.condition);
  }
}

function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "element_present":
      return `${describeTarget(condition.target.role, condition.target.name)} is present`;
    case "element_absent":
      return `${describeTarget(condition.target.role, condition.target.name)} is absent`;
    case "url_matches":
      return `URL matches ${condition.pattern}`;
    case "text_present":
      return "recorded text is present";
    case "field_value":
      return `${describeTarget(condition.target.role, condition.target.name)} has the expected value`;
  }
}

function describeTarget(role: string, name: string): string {
  return `${role}${name ? ` named ${JSON.stringify(name)}` : " with empty name"}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
