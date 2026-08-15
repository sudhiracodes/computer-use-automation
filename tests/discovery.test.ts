import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateArtifact } from "../src/artifact/io.js";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "../src/artifact/schema.js";
import { runDiscovery } from "../src/discovery/index.js";
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "../src/llm/provider.js";
import { replayArtifact } from "../src/replay/index.js";
import { PlaywrightWebAdapter } from "../src/surface/web/playwright-adapter.js";
import { loadArtifact } from "../src/artifact/io.js";
import { app } from "../target-app/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("LLM-driven discovery", () => {
  it("records inventory-id actions into an artifact the Phase 3 replay executor consumes unchanged", async () => {
    const template = rebaseArtifact(
      await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json"),
      base,
    );
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-discovery-"));
    const provider = new ScriptedDiscoveryProvider();
    const discoveryAdapter = await PlaywrightWebAdapter.launch();

    const inputs = {
      operatorId: "teller01",
      operatorPassword: "change-me-locally",
      memberId: "100234",
      accountType: "Holiday Club",
      initialDeposit: "25.00",
    };

    try {
      const discovery = await runDiscovery({
        goal: "Open a Holiday Club savings sub-account for member 100234 with a 25.00 initial deposit.",
        template,
        provider,
        adapter: discoveryAdapter,
        inputs,
        evidence: { dir: evidenceDir, runId: "scripted-discovery" },
      });

      expect(discovery.status).toBe("success");
      if (discovery.status !== "success") return;
      expect(validateArtifact(discovery.artifact).ok).toBe(true);
      expect(discovery.artifact.provenance.discoveredBy).toBe("llm");
      expect(discovery.artifact.steps.map((step) => step.id)).toEqual([
        "open-signon",
        "enter-operator-id",
        "enter-operator-password",
        "submit-signon",
        "enter-member-id",
        "run-search",
        "open-member-detail",
        "open-subaccount-form",
        "choose-account-type",
        "enter-initial-deposit",
        "acknowledge-disclosure",
        "continue-to-review",
        "confirm-open-account",
      ]);

      const evidence = await readFile(discovery.evidence.logPath!, "utf8");
      expect(evidence).toContain('"type":"model_tool"');
      expect(evidence).toContain('"type":"artifact_generated"');
      expect(evidence).not.toContain("change-me-locally");

      const replayAdapter = await PlaywrightWebAdapter.launch();
      try {
        const replay = await replayArtifact(discovery.artifact, {
          adapter: replayAdapter,
          pollIntervalMs: 25,
          inputs,
        });
        expect(replay.status).toBe("success");
        if (replay.status !== "success") return;
        expect(replay.outputs.savingsBalance).toBe(1284.36);
        expect(replay.outputs.newSubAccountNumber).toMatch(/^SV-100234-\d+$/);
      } finally {
        await replayAdapter.dispose();
      }
    } finally {
      await discoveryAdapter.dispose();
    }
  }, 45_000);

  it("redacts secret values in prompts, evidence, and failed undeclared-input results", async () => {
    const template = await phase4Template();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-secret-redaction-"));
    const provider = new OneShotProvider({
      kind: "type_param",
      elementId: 1,
      inputName: "change-me-locally",
      intent: "Try to leak a secret as an input name.",
    });
    const adapter = await PlaywrightWebAdapter.launch();

    try {
      const result = await runDiscovery({
        goal: "Use password change-me-locally to sign in.",
        template,
        provider,
        adapter,
        inputs: defaultInputs(),
        evidence: { dir: evidenceDir, runId: "secret-redaction" },
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.reason).not.toContain("change-me-locally");
      expect(provider.requests.join("\n")).not.toContain("change-me-locally");
      await expect(readFile(result.evidence.logPath!, "utf8")).resolves.not.toContain("change-me-locally");
    } finally {
      await adapter.dispose();
    }
  }, 30_000);

  it("returns failed results for nonexistent inventory IDs rather than throwing", async () => {
    const template = await phase4Template();
    const adapter = await PlaywrightWebAdapter.launch();

    try {
      const result = await runDiscovery({
        goal: "Click something invalid.",
        template,
        provider: new OneShotProvider({ kind: "click", elementId: 999_999, intent: "Bad id." }),
        adapter,
        inputs: defaultInputs(),
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          reason: "model selected an inventory element that is not present in the current observation",
        }),
      );
    } finally {
      await adapter.dispose();
    }
  }, 30_000);

  it("rejects finish before the success condition is true", async () => {
    const template = await phase4Template();
    const adapter = await PlaywrightWebAdapter.launch();

    try {
      const result = await runDiscovery({
        goal: "Finish immediately.",
        template,
        provider: new OneShotProvider({ kind: "finish", intent: "Done too early." }),
        adapter,
        inputs: defaultInputs(),
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          reason: "model finished before the success condition was true",
        }),
      );
    } finally {
      await adapter.dispose();
    }
  }, 30_000);
});

class ScriptedDiscoveryProvider implements LLMProvider {
  readonly id = "scripted-test";
  readonly model = "inventory-id-script";
  readonly capabilities = { images: false, toolCalling: true };
  private index = 0;

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const prompt = request.messages.at(-1)?.content.find((part) => part.type === "text")?.text ?? "";
    const inventory = parseInventory(prompt);
    const call = this.nextCall(inventory);
    return {
      text: "",
      toolCalls: [call],
      stopReason: "tool_calls",
      usage: {},
    };
  }

  private nextCall(inventory: InventoryLine[]): ToolCall {
    const action = SCRIPT[this.index++];
    if (!action) {
      return tool({ kind: "finish", intent: "The confirmation screen is reached." });
    }
    if (action.kind === "finish") return tool(action);

    const element = inventory.find((candidate) =>
      candidate.role === action.role && candidate.name === action.name,
    );
    if (!element) throw new Error(`script could not find ${action.role} ${action.name}`);

    switch (action.kind) {
      case "click":
        return tool({ kind: "click", elementId: element.id, intent: action.intent });
      case "type_param":
        return tool({ kind: "type_param", elementId: element.id, inputName: action.inputName, intent: action.intent });
      case "select_param":
        return tool({ kind: "select_param", elementId: element.id, inputName: action.inputName, intent: action.intent });
      case "check":
        return tool({ kind: "check", elementId: element.id, checked: true, intent: action.intent });
    }
  }
}

class OneShotProvider implements LLMProvider {
  readonly id = "one-shot-test";
  readonly model = "one-shot";
  readonly capabilities = { images: false, toolCalling: true };
  readonly requests: string[] = [];

  constructor(private readonly args: unknown) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(JSON.stringify(request));
    return {
      text: "",
      toolCalls: [{ id: "one-shot", name: "act", args: this.args }],
      stopReason: "tool_calls",
      usage: {},
    };
  }
}

type ScriptAction =
  | { kind: "click"; role: string; name: string; intent: string }
  | { kind: "type_param"; role: string; name: string; inputName: string; intent: string }
  | { kind: "select_param"; role: string; name: string; inputName: string; intent: string }
  | { kind: "check"; role: string; name: string; intent: string }
  | { kind: "finish"; intent: string };

const SCRIPT: readonly ScriptAction[] = [
  { kind: "type_param", role: "textbox", name: "Operator ID", inputName: "operatorId", intent: "Enter the operator ID." },
  { kind: "type_param", role: "textbox", name: "Password", inputName: "operatorPassword", intent: "Enter the operator password by input name." },
  { kind: "click", role: "button", name: "Sign On", intent: "Submit sign-on." },
  { kind: "type_param", role: "textbox", name: "Member ID", inputName: "memberId", intent: "Enter the member ID." },
  { kind: "click", role: "button", name: "Search", intent: "Search for the member." },
  { kind: "click", role: "link", name: "View", intent: "Open the matching member detail row." },
  { kind: "click", role: "button", name: "Open Sub-Account", intent: "Start the sub-account form." },
  { kind: "select_param", role: "combobox", name: "Account Type", inputName: "accountType", intent: "Choose the account product." },
  { kind: "type_param", role: "textbox", name: "Initial Deposit", inputName: "initialDeposit", intent: "Enter the opening deposit." },
  { kind: "check", role: "checkbox", name: "Disclosure", intent: "Acknowledge disclosure." },
  { kind: "click", role: "button", name: "Continue", intent: "Continue to review." },
  { kind: "click", role: "button", name: "Confirm and Open Account", intent: "Commit the new account." },
  { kind: "finish", intent: "The confirmation screen is reached." },
];

interface InventoryLine {
  id: number;
  role: string;
  name: string;
}

function parseInventory(prompt: string): InventoryLine[] {
  return prompt
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\[(\d+)] role=(\S+) name=(".*?")/);
      if (!match) return [];
      return [{
        id: Number(match[1]),
        role: match[2]!,
        name: JSON.parse(match[3]!) as string,
      }];
    });
}

function tool(args: unknown): ToolCall {
  return { id: "scripted-call", name: "act", args };
}

function rebaseArtifact(artifact: Artifact, targetBase: string): Artifact {
  return CapabilityArtifact.parse(
    JSON.parse(JSON.stringify(artifact).replaceAll("http://localhost:3000", targetBase)),
  );
}

async function phase4Template(): Promise<Artifact> {
  return rebaseArtifact(
    await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json"),
    base,
  );
}

function defaultInputs(): Record<string, string> {
  return {
    operatorId: "teller01",
    operatorPassword: "change-me-locally",
    memberId: "100234",
    accountType: "Holiday Club",
    initialDeposit: "25.00",
  };
}
