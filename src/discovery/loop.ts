import { z } from "zod";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { validateArtifact } from "../artifact/io.js";
import {
  createDiscoveryEvidenceRecorder,
  type DiscoveryEvidenceOptions,
  type DiscoveryEvidenceRef,
} from "../evidence/discovery-recorder.js";
import type { LLMMessage, LLMProvider } from "../llm/provider.js";
import type { InventoryElement, Observation, SurfaceAdapter } from "../surface/adapter.js";
import { buildDiscoveredArtifact, type RecordedDiscoveryAction } from "./recorder.js";
import { actionKindOf, discoveryToolDefs, DiscoveryToolCall } from "./tools.js";

export interface DiscoveryOptions {
  goal: string;
  template: CapabilityArtifact;
  provider: LLMProvider;
  adapter: SurfaceAdapter;
  inputs: Readonly<Record<string, string>>;
  maxSteps?: number;
  evidence?: DiscoveryEvidenceOptions;
}

export type DiscoveryResult =
  | { status: "success"; artifact: CapabilityArtifact; evidence: DiscoveryEvidenceRef }
  | { status: "failed"; reason: string; evidence: DiscoveryEvidenceRef };

const DEFAULT_MAX_STEPS = 30;

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const evidence = createDiscoveryEvidenceRecorder(options.evidence);
  const recorded: RecordedDiscoveryAction[] = [];
  const messages: LLMMessage[] = [];
  const redactor = redactorFor(options.template, options.inputs);

  await evidence.record({
    type: "run_started",
    goal: redactor(options.goal),
    targetUrl: options.template.target.entryUrl,
    provider: options.provider.id,
    model: options.provider.model,
  });

  await options.adapter.navigate(options.template.target.entryUrl);
  const initialObservation = await options.adapter.observe();
  let observation = initialObservation;

  for (let step = 0; step < maxSteps; step += 1) {
    await evidence.record({
      type: "observation",
      step,
      url: observation.url,
      title: observation.title,
      inventoryCount: observation.inventory.length,
    });

    messages.push({
      role: "user",
      content: [{ type: "text", text: renderPrompt(redactor(options.goal), options.template, observation, redactor) }],
    });

    const response = await options.provider
      .complete({
        system: SYSTEM_PROMPT,
        messages,
        tools: discoveryToolDefs(),
        maxOutputTokens: 800,
        sampling: { temperature: 0 },
      })
      .catch((error: unknown) =>
        error instanceof Error ? { error } : { error: new Error(String(error)) },
      );

    if ("error" in response) {
      return failDiscovery(evidence, redactor(`provider request failed: ${response.error.message}`));
    }

    const toolCall = response.toolCalls[0];
    if (!toolCall) {
      return failDiscovery(evidence, "model returned no tool call");
    }

    if (toolCall.name !== "act") {
      return failDiscovery(evidence, "model returned an unsupported tool call");
    }

    const parsed = DiscoveryToolCall.safeParse(toolCall.args);
    if (!parsed.success) {
      return failDiscovery(evidence, `model returned malformed tool args: ${z.prettifyError(parsed.error)}`);
    }

    const call = parsed.data;
    const validationError = validateToolCall(call, options.template, observation);
    if (validationError) {
      return failDiscovery(evidence, validationError);
    }

    await evidence.record({ type: "model_tool", step, name: toolCall.name, args: redactToolArgs(call) });

    if (call.kind === "finish") {
      if (!(await options.adapter.check(options.template.successCondition, options.inputs))) {
        return failDiscovery(evidence, "model finished before the success condition was true");
      }

      const artifact = buildDiscoveredArtifact(
        options.template,
        recorded,
        {
          discoveredBy: "llm",
          provider: options.provider.id,
          model: options.provider.model,
          runId: evidence.ref.runId,
          discoveredAt: new Date().toISOString(),
          transcriptHash: "0".repeat(64),
          toolVersions: { discovery: "1", schema: String(options.template.schemaVersion) },
        },
        initialObservation,
      );
      const validation = validateArtifact(artifact);
      if (!validation.ok) {
        return failDiscovery(evidence, "generated artifact failed validation");
      }
      await evidence.record({ type: "artifact_generated", artifactId: artifact.id, stepCount: artifact.steps.length });
      await evidence.record({ type: "run_finished", status: "success" });
      return { status: "success", artifact, evidence: evidence.ref };
    }

    const before = observation;
    const action = actionFromTool(call, before);
    const actionError = await options.adapter.act(action, options.inputs).then(
      () => null,
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    if (actionError) {
      return failDiscovery(evidence, redactor(`adapter action failed: ${actionError.message}`));
    }
    await evidence.record({ type: "action_applied", step, action: actionKindOf(call) });
    const observed = await observeAfterAction(options.adapter, before, call.kind).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    );
    if ("error" in observed) {
      return failDiscovery(evidence, redactor(`observation failed: ${observed.error.message}`));
    }
    observation = observed.result;
    recorded.push({ call, before, after: observation });
  }

  await evidence.record({ type: "run_finished", status: "failed" });
  return { status: "failed", reason: `max steps (${maxSteps}) reached`, evidence: evidence.ref };
}

async function failDiscovery(
  evidence: ReturnType<typeof createDiscoveryEvidenceRecorder>,
  reason: string,
): Promise<DiscoveryResult> {
  await evidence.record({ type: "run_finished", status: "failed" });
  return { status: "failed", reason, evidence: evidence.ref };
}

async function observeAfterAction(
  adapter: SurfaceAdapter,
  before: Observation,
  actionKind: Exclude<DiscoveryToolCall["kind"], "finish">,
): Promise<Observation> {
  if (actionKind !== "click") return adapter.observe();

  const beforeSignature = observationSignature(before);
  const deadline = Date.now() + 10_000;
  let latest = await adapter.observe();
  while (Date.now() < deadline) {
    if (observationSignature(latest) !== beforeSignature && observationUsable(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await adapter.observe();
  }
  return latest;
}

function observationUsable(observation: Observation): boolean {
  if (!observation.url.includes("/console")) return observation.inventory.length > 0;
  return observation.inventory.some((element) => element.framePath.includes("content"));
}

function observationSignature(observation: Observation): string {
  return JSON.stringify(
    observation.inventory.map((element) => [
      element.role,
      element.name,
      element.value === undefined ? "" : element.value,
      element.checked === undefined ? "" : element.checked,
      element.framePath.join(">"),
    ]),
  );
}

const SYSTEM_PROMPT = [
  "You are discovering a UI flow for deterministic replay.",
  "Choose actions only by inventory element id.",
  "Never invent selectors, coordinates, or locator descriptors.",
  "For typing or selecting values, use input names. Never provide raw secret values.",
].join("\n");

function renderPrompt(
  goal: string,
  template: CapabilityArtifact,
  observation: Observation,
  redactor: (value: string) => string,
): string {
  return [
    `Goal: ${goal}`,
    "",
    "Available inputs by name:",
    ...Object.entries(template.inputs).map(([name, field]) =>
      `- ${name}: ${field.description} sensitivity=${field.sensitivity}`,
    ),
    "",
    `Current URL: ${observation.url}`,
    `Title: ${observation.title}`,
    "",
    "Inventory:",
    ...observation.inventory.map((element) => formatElementForModel(element, redactor)),
  ].join("\n");
}

function formatElementForModel(element: InventoryElement, redactor: (value: string) => string): string {
  const value =
    element.value === undefined
      ? ""
      : ` value=${isSecretLike(element) ? "<redacted>" : JSON.stringify(redactor(element.value))}`;
  const checked = element.checked === undefined ? "" : ` checked=${element.checked}`;
  const frame = element.framePath.length ? ` frame=${element.framePath.join(">")}` : " frame=(main)";
  return `[${element.id}] role=${element.role} name=${JSON.stringify(element.name)}${value}${checked}${frame}`;
}

function isSecretLike(element: InventoryElement): boolean {
  return /password/i.test(element.name);
}

function actionFromTool(call: Exclude<DiscoveryToolCall, { kind: "finish" }>, observation: Observation) {
  const element = observation.inventory.find((candidate) => candidate.id === call.elementId);
  if (!element) throw new Error(`model selected unknown inventory element ${call.elementId}`);
  const target = {
    strategy: "semantic" as const,
    role: element.role,
    name: element.name,
    nameMatch: "normalized" as const,
    framePath: element.framePath,
    fallbacks: [],
  };

  switch (call.kind) {
    case "click":
      return { kind: "click" as const, target };
    case "type_param":
      return { kind: "type" as const, target, value: { kind: "param" as const, param: call.inputName }, mode: "replace" as const };
    case "select_param":
      return { kind: "select" as const, target, value: { kind: "param" as const, param: call.inputName } };
    case "check":
      return { kind: "check" as const, target, checked: call.checked };
  }
}

function redactToolArgs(call: DiscoveryToolCall): unknown {
  if (call.kind === "type_param" || call.kind === "select_param") {
    return { ...call, value: `{${call.inputName}}` };
  }
  return call;
}

function validateToolCall(
  call: DiscoveryToolCall,
  template: CapabilityArtifact,
  observation: Observation,
): string | null {
  if (call.kind !== "finish" && !observation.inventory.some((element) => element.id === call.elementId)) {
    return "model selected an inventory element that is not present in the current observation";
  }

  if ((call.kind === "type_param" || call.kind === "select_param") && !template.inputs[call.inputName]) {
    return "model referenced an undeclared input";
  }

  return null;
}

function redactorFor(
  template: CapabilityArtifact,
  inputs: Readonly<Record<string, string>>,
): (value: string) => string {
  const secrets = Object.entries(template.inputs)
    .filter(([, field]) => field.sensitivity === "secret")
    .map(([name]) => inputs[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return (value: string): string => {
    let redacted = value;
    for (const secret of secrets) {
      redacted = redacted.split(secret).join("<redacted>");
    }
    return redacted;
  };
}
