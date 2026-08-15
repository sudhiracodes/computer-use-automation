/**
 * Operator CLI.
 *
 * Argument parsing is hand-rolled rather than pulled from a framework: there are
 * a handful of subcommands, and a reviewer reading this file should be able to see
 * exactly what each one does without learning a builder API first.
 *
 * Phase 1 exposes only the artifact commands. `discover` and `replay` land in
 * Phases 4 and 2 respectively.
 */

import { artifactJsonSchema, capabilityContract, loadArtifact, saveArtifact } from "../artifact/index.js";
import { runDiscovery } from "../discovery/index.js";
import { createLLMProvider } from "../llm/factory.js";
import { loadAllowlistConfig, inputSensitivityFromArtifact } from "../policy/index.js";
import { replayArtifact } from "../replay/index.js";
import { PlaywrightWebAdapter } from "../surface/web/playwright-adapter.js";

const USAGE = `
Usage: npm run cli -- <command> [args]

Commands:
  artifact validate <path>   Validate a capability artifact and report problems
  artifact contract <path>   Print the agent-facing calling contract for an artifact
  artifact schema            Print JSON Schema for the artifact format itself
  discover <template> [options]
                              Run LLM discovery from a goal and save the artifact
  replay <path> [options]     Replay an artifact deterministically

Discovery options:
  --goal text                 Natural-language goal for the discovery agent.
  --output path               Where to write the discovered artifact JSON.
  --input name=value          Bind an artifact input. Repeatable.
  --evidence-dir path         Persist replay JSONL and failure artifacts under path.
  --run-id id                 Stable evidence run id. Requires --evidence-dir.
  --approval-token token      Permit irreversible steps after explicit approval.
  --headful                   Show the browser instead of running headless.

Replay options:
  --input name=value          Bind an artifact input. Repeatable.
  --evidence-dir path         Persist replay JSONL and failure artifacts under path.
  --run-id id                 Stable evidence run id. Requires --evidence-dir.
  --approval-token token      Permit irreversible steps after explicit approval.
  --resume-from-step id       Resume after handoff by re-checking this step.
  --headful                   Show the browser instead of running headless.
`.trim();

async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (group === "replay") {
    return replay(command, rest);
  }

  if (group === "discover") {
    return discover(command, rest);
  }

  if (group !== "artifact") {
    console.error(`Unknown command group "${group}".\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case "validate":
      return artifactValidate(rest[0]);
    case "contract":
      return artifactContract(rest[0]);
    case "schema":
      console.log(JSON.stringify(artifactJsonSchema(), null, 2));
      return 0;
    default:
      console.error(`Unknown artifact command "${command ?? ""}".\n\n${USAGE}`);
      return 2;
  }
}

async function discover(path: string | undefined, args: string[]): Promise<number> {
  if (!path) {
    console.error("discover requires a template artifact path");
    return 2;
  }

  const parsed = parseDiscoverArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  const template = await loadArtifact(path);
  const inputs = bindInputs(template, parsed.inputs);
  const adapter = await PlaywrightWebAdapter.launch({ headless: parsed.headless });
  const provider = await createLLMProvider();

  try {
    const result = await runDiscovery({
      goal: parsed.goal,
      template,
      provider,
      adapter,
      inputs,
      policy: {
        allowlist: await loadAllowlistConfig(template.target.allowlistRef),
        inputSensitivity: inputSensitivityFromArtifact(template.inputs),
        ...(parsed.approvalToken ? { approvalToken: parsed.approvalToken } : {}),
      },
      ...(parsed.evidenceDir
        ? {
            evidence: {
              dir: parsed.evidenceDir,
              ...(parsed.runId ? { runId: parsed.runId } : {}),
            },
          }
        : {}),
    });

    if (result.status !== "success") {
      console.log(JSON.stringify(result, null, 2));
      return 1;
    }

    await saveArtifact(parsed.output, result.artifact);
    console.log(JSON.stringify({ status: "success", artifactPath: parsed.output, evidence: result.evidence }, null, 2));
    return 0;
  } finally {
    await adapter.dispose();
  }
}

async function artifactValidate(path: string | undefined): Promise<number> {
  if (!path) {
    console.error("artifact validate requires a path");
    return 2;
  }
  // loadArtifact throws ArtifactValidationError with a formatted report; letting
  // it propagate to main's handler keeps the success path free of error plumbing.
  const artifact = await loadArtifact(path);
  console.log(`OK  ${path}`);
  console.log(`    ${artifact.id}@${artifact.version} (${artifact.status})`);
  const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
    `${n} ${n === 1 ? singular : pluralForm}`;

  console.log(
    `    ${[
      plural(artifact.steps.length, "step"),
      plural(Object.keys(artifact.inputs).length, "input"),
      plural(Object.keys(artifact.outputs).length, "output"),
      plural(artifact.knownOutcomes.length, "known outcome"),
      plural(artifact.recoveries.length, "recovery", "recoveries"),
    ].join(", ")}`,
  );
  console.log(
    `    discovered by ${artifact.provenance.discoveredBy}` +
      (artifact.provenance.model ? ` (${artifact.provenance.provider}/${artifact.provenance.model})` : ""),
  );
  return 0;
}

async function artifactContract(path: string | undefined): Promise<number> {
  if (!path) {
    console.error("artifact contract requires a path");
    return 2;
  }
  const artifact = await loadArtifact(path);
  console.log(JSON.stringify(capabilityContract(artifact), null, 2));
  return 0;
}

async function replay(path: string | undefined, args: string[]): Promise<number> {
  if (!path) {
    console.error("replay requires an artifact path");
    return 2;
  }

  const parsed = parseReplayArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  const artifact = await loadArtifact(path);
  const inputs = bindInputs(artifact, parsed.inputs);
  const adapter = await PlaywrightWebAdapter.launch({ headless: parsed.headless });

  try {
    const result = await replayArtifact(artifact, {
      adapter,
      inputs,
      policy: {
        allowlist: await loadAllowlistConfig(artifact.target.allowlistRef),
        inputSensitivity: inputSensitivityFromArtifact(artifact.inputs),
        ...(parsed.approvalToken ? { approvalToken: parsed.approvalToken } : {}),
      },
      ...(parsed.resumeFromStepId ? { resumeFromStepId: parsed.resumeFromStepId } : {}),
      ...(parsed.evidenceDir
        ? {
            evidence: {
              dir: parsed.evidenceDir,
              ...(parsed.runId ? { runId: parsed.runId } : {}),
            },
          }
        : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "success" ? 0 : 1;
  } finally {
    await adapter.dispose();
  }
}

type ReplayArgs =
  | {
      ok: true;
      inputs: Record<string, string>;
      headless: boolean;
      evidenceDir?: string;
      runId?: string;
      approvalToken?: string;
      resumeFromStepId?: string;
    }
  | { ok: false; message: string };

function parseReplayArgs(args: string[]): ReplayArgs {
  const inputs: Record<string, string> = {};
  let headless = true;
  let evidenceDir: string | undefined;
  let runId: string | undefined;
  let approvalToken: string | undefined;
  let resumeFromStepId: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--headful") {
      headless = false;
      continue;
    }
    if (arg === "--evidence-dir") {
      evidenceDir = args[i + 1];
      if (!evidenceDir) return { ok: false, message: "--evidence-dir requires a path" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--evidence-dir=")) {
      evidenceDir = arg.slice("--evidence-dir=".length);
      if (!evidenceDir) return { ok: false, message: "--evidence-dir requires a path" };
      continue;
    }
    if (arg === "--run-id") {
      runId = args[i + 1];
      if (!runId) return { ok: false, message: "--run-id requires an id" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--run-id=")) {
      runId = arg.slice("--run-id=".length);
      if (!runId) return { ok: false, message: "--run-id requires an id" };
      continue;
    }
    if (arg === "--approval-token") {
      approvalToken = args[i + 1];
      if (!approvalToken) return { ok: false, message: "--approval-token requires a token" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--approval-token=")) {
      approvalToken = arg.slice("--approval-token=".length);
      if (!approvalToken) return { ok: false, message: "--approval-token requires a token" };
      continue;
    }
    if (arg === "--resume-from-step") {
      resumeFromStepId = args[i + 1];
      if (!resumeFromStepId) return { ok: false, message: "--resume-from-step requires a step id" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--resume-from-step=")) {
      resumeFromStepId = arg.slice("--resume-from-step=".length);
      if (!resumeFromStepId) return { ok: false, message: "--resume-from-step requires a step id" };
      continue;
    }
    if (arg === "--input") {
      const binding = args[i + 1];
      if (!binding) return { ok: false, message: "--input requires name=value" };
      i += 1;
      const parsed = parseInputBinding(binding);
      if (!parsed.ok) return parsed;
      inputs[parsed.name] = parsed.value;
      continue;
    }
    if (arg?.startsWith("--input=")) {
      const parsed = parseInputBinding(arg.slice("--input=".length));
      if (!parsed.ok) return parsed;
      inputs[parsed.name] = parsed.value;
      continue;
    }
    return { ok: false, message: `unknown replay option "${arg ?? ""}"` };
  }

  if (runId && !evidenceDir) {
    return { ok: false, message: "--run-id requires --evidence-dir" };
  }

  return {
    ok: true,
    inputs,
    headless,
    ...(evidenceDir ? { evidenceDir } : {}),
    ...(runId ? { runId } : {}),
    ...(approvalToken ? { approvalToken } : {}),
    ...(resumeFromStepId ? { resumeFromStepId } : {}),
  };
}

type DiscoverArgs =
  | {
      ok: true;
      goal: string;
      output: string;
      inputs: Record<string, string>;
      headless: boolean;
      evidenceDir?: string;
      runId?: string;
      approvalToken?: string;
    }
  | { ok: false; message: string };

function parseDiscoverArgs(args: string[]): DiscoverArgs {
  let goal: string | undefined;
  let output: string | undefined;
  const sharedArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--goal") {
      goal = args[i + 1];
      if (!goal) return { ok: false, message: "--goal requires text" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--goal=")) {
      goal = arg.slice("--goal=".length);
      if (!goal) return { ok: false, message: "--goal requires text" };
      continue;
    }
    if (arg === "--output") {
      output = args[i + 1];
      if (!output) return { ok: false, message: "--output requires a path" };
      i += 1;
      continue;
    }
    if (arg?.startsWith("--output=")) {
      output = arg.slice("--output=".length);
      if (!output) return { ok: false, message: "--output requires a path" };
      continue;
    }
    sharedArgs.push(arg);
  }

  if (!goal) return { ok: false, message: "discover requires --goal" };
  if (!output) return { ok: false, message: "discover requires --output" };

  const replayArgs = parseReplayArgs(sharedArgs);
  if (!replayArgs.ok) return replayArgs;

  return {
    ok: true,
    goal,
    output,
    inputs: replayArgs.inputs,
    headless: replayArgs.headless,
    ...(replayArgs.evidenceDir ? { evidenceDir: replayArgs.evidenceDir } : {}),
    ...(replayArgs.runId ? { runId: replayArgs.runId } : {}),
    ...(replayArgs.approvalToken ? { approvalToken: replayArgs.approvalToken } : {}),
  };
}

type ParsedBinding =
  | { ok: true; name: string; value: string }
  | { ok: false; message: string };

function parseInputBinding(binding: string): ParsedBinding {
  const equals = binding.indexOf("=");
  if (equals <= 0) return { ok: false, message: `invalid input binding "${binding}", expected name=value` };
  return {
    ok: true,
    name: binding.slice(0, equals),
    value: binding.slice(equals + 1),
  };
}

function bindInputs(
  artifact: Awaited<ReturnType<typeof loadArtifact>>,
  supplied: Record<string, string>,
): Record<string, string> {
  const envDefaults: Record<string, string | undefined> = {
    operatorId: process.env.TARGET_APP_USER ?? "teller01",
    operatorPassword: process.env.TARGET_APP_PASSWORD ?? "change-me-locally",
  };

  const inputs: Record<string, string> = {};
  for (const [name, field] of Object.entries(artifact.inputs)) {
    const value = supplied[name] ?? envDefaults[name] ?? field.example;
    if (field.required && value === undefined) {
      throw new Error(`missing required input "${name}". Pass --input ${name}=...`);
    }
    if (value !== undefined) inputs[name] = value;
  }
  return inputs;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
