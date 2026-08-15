/**
 * Deterministic replay of a capability artifact.
 *
 * No LLM appears in this module, by design. Replay is the production path: a
 * calling agent supplies typed inputs, and the executor walks the already-reviewed
 * artifact in fixed order through a SurfaceAdapter.
 */

import type { Action, Condition } from "../artifact/locator.js";
import type { CapabilityArtifact, OutputField, Step } from "../artifact/schema.js";
import type { SurfaceAdapter } from "../surface/adapter.js";

export type ReplayStatus = "success" | "failed";

export type ReplayErrorClass =
  | "LOCATOR_UNRESOLVED"
  | "LOCATOR_AMBIGUOUS"
  | "CHECKPOINT_FAILED"
  | "TIMEOUT"
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
    };

export interface ReplayOptions {
  adapter: SurfaceAdapter;
  inputs: Readonly<Record<string, string>>;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;

export async function replayArtifact(
  artifact: CapabilityArtifact,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const steps: ReplayStepLog[] = [];
  const outputs: ReplayOutputs = {};
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs);

  for (const step of artifact.steps) {
    try {
      await options.adapter.act(step.action, options.inputs);
      await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs);

      if (step.postcondition) {
        const reached = await waitForCondition(
          options.adapter,
          step.postcondition,
          options.inputs,
          step.timeoutMs,
          pollIntervalMs,
        );
        if (!reached) {
          steps.push(stepLog(step, "failed"));
          return failure(
            outputs,
            steps,
            "CHECKPOINT_FAILED",
            step.id,
            describeCondition(step.postcondition),
            "condition was still false at the step deadline",
          );
        }
        await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs);
      }

      steps.push(stepLog(step, "completed"));
    } catch (error) {
      steps.push(stepLog(step, "failed"));
      return failure(
        outputs,
        steps,
        classifyError(error),
        step.id,
        describeAction(step.action),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const success = await waitForCondition(
    options.adapter,
    artifact.successCondition,
    options.inputs,
    10_000,
    pollIntervalMs,
  );
  await collectVisibleOutputs(artifact, options.adapter, options.inputs, outputs);

  if (!success) {
    return failure(
      outputs,
      steps,
      "CHECKPOINT_FAILED",
      "(successCondition)",
      describeCondition(artifact.successCondition),
      "success condition was still false after all steps completed",
    );
  }

  const missingOutput = Object.keys(artifact.outputs).find((name) => outputs[name] === undefined);
  if (missingOutput) {
    return failure(
      outputs,
      steps,
      "ADAPTER_ERROR",
      "(outputs)",
      `extract output "${missingOutput}"`,
      "declared output was not visible on any replayed screen",
    );
  }

  return { status: "success", outputs, steps };
}

async function collectVisibleOutputs(
  artifact: CapabilityArtifact,
  adapter: SurfaceAdapter,
  inputs: Readonly<Record<string, string>>,
  outputs: ReplayOutputs,
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
  }
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

function isOutputNotCurrentlyVisible(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "FrameNotFoundError" ||
    error.name === "LocatorUnresolvedError" ||
    /Execution context was destroyed|Cannot find context with specified id/.test(error.message)
  );
}

function failure(
  outputs: ReplayOutputs,
  steps: ReplayStepLog[],
  errorClass: ReplayErrorClass,
  stepId: string,
  expected: string,
  observed: string,
): ReplayResult {
  return {
    status: "failed",
    outputs,
    steps,
    error: {
      class: errorClass,
      stepId,
      expected,
      observed,
    },
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
