import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifact/io.js";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "../src/artifact/schema.js";
import { replayArtifact } from "../src/replay/index.js";
import type { ReplayOptions, ReplayResult } from "../src/replay/index.js";
import { PlaywrightWebAdapter } from "../src/surface/web/playwright-adapter.js";
import { armFault, disarmAll } from "../target-app/faults.js";
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

describe.sequential("deterministic replay", () => {
  it("replays the hand-written artifact to success twice without an LLM", async () => {
    const artifact = rebaseArtifact(
      await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json"),
      base,
    );

    const first = await runReplay(artifact);
    const second = await runReplay(artifact);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    if (first.status !== "success" || second.status !== "success") return;

    expect(first.steps.map((step) => [step.stepId, step.action, step.status])).toEqual(
      second.steps.map((step) => [step.stepId, step.action, step.status]),
    );
    expect(first.outputs.savingsBalance).toBe(1284.36);
    expect(second.outputs.savingsBalance).toBe(1284.36);
    expect(typeof first.outputs.newSubAccountNumber).toBe("string");
    expect(typeof second.outputs.newSubAccountNumber).toBe("string");
    expect(first.outputs.newSubAccountNumber).toMatch(/^SV-100234-\d+$/);
    expect(second.outputs.newSubAccountNumber).toMatch(/^SV-100234-\d+$/);
  }, 30_000);

  it("reports MEMBER_NOT_FOUND as a business outcome, not a failure", async () => {
    const artifact = await phase2Artifact();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-business-outcome-"));

    const result = await runReplay(artifact, {
      inputs: { memberId: "999999" },
      evidence: { dir: evidenceDir, runId: "member-not-found" },
    });

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("MEMBER_NOT_FOUND");
    expect(result.steps.at(-1)).toEqual(
      expect.objectContaining({ stepId: "run-search", status: "completed" }),
    );

    const events = await readEvidenceEvents(result);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "business_outcome", code: "MEMBER_NOT_FOUND" }),
        expect.objectContaining({ type: "run_finished", status: "business_outcome" }),
      ]),
    );
  }, 30_000);

  it("runs the declared unexpected-dialog recovery exactly once and still succeeds", async () => {
    const artifact = await phase2Artifact();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-recovery-"));
    armFault("unexpected_dialog", "once");

    const result = await runReplay(artifact, {
      evidence: { dir: evidenceDir, runId: "unexpected-dialog" },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1284.36);

    const events = await readEvidenceEvents(result);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "recovery_started",
          recoveryId: "dismiss-system-notice",
          attempt: 1,
          maxTimes: 1,
        }),
        expect.objectContaining({ type: "recovery_completed", recoveryId: "dismiss-system-notice" }),
        expect.objectContaining({ type: "run_finished", status: "success" }),
      ]),
    );
  }, 30_000);

  it("reports app errors as hard failures with screenshot and DOM evidence", async () => {
    const artifact = await phase2Artifact();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-hard-failure-"));
    armFault("app_error", "once");

    const result = await runReplay(artifact, {
      evidence: { dir: evidenceDir, runId: "app-error" },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.class).toBe("APP_ERROR");
    expect(result.error.stepId).toBe("open-member-detail");
    expect(result.evidence.screenshotPath).toBeDefined();
    expect(result.evidence.domSnapshotPath).toBeDefined();
    await expect(stat(result.evidence.screenshotPath!)).resolves.toEqual(
      expect.objectContaining({ size: expect.any(Number) }),
    );
    await expect(readFile(result.evidence.domSnapshotPath!, "utf8")).resolves.toContain("Application Error");

    const events = await readEvidenceEvents(result);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "failure", class: "APP_ERROR", stepId: "open-member-detail" }),
        expect.objectContaining({ type: "run_finished", status: "failed" }),
      ]),
    );
  }, 30_000);
});

interface RunReplayOverrides {
  inputs?: Partial<Record<"operatorId" | "operatorPassword" | "memberId" | "accountType" | "initialDeposit", string>>;
  evidence?: { dir: string; runId: string };
}

async function runReplay(
  artifact: Artifact,
  overrides: RunReplayOverrides = {},
): ReturnType<typeof replayArtifact> {
  const adapter = await PlaywrightWebAdapter.launch();
  try {
    const options: ReplayOptions = {
      adapter,
      pollIntervalMs: 25,
      inputs: {
        operatorId: "teller01",
        operatorPassword: "change-me-locally",
        memberId: "100234",
        accountType: "Holiday Club",
        initialDeposit: "25.00",
        ...overrides.inputs,
      },
    };
    if (overrides.evidence) options.evidence = overrides.evidence;
    return await replayArtifact(artifact, options);
  } finally {
    disarmAll();
    await adapter.dispose();
  }
}

async function phase2Artifact(): Promise<Artifact> {
  return rebaseArtifact(
    await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json"),
    base,
  );
}

function rebaseArtifact(artifact: Artifact, targetBase: string): Artifact {
  return CapabilityArtifact.parse(
    JSON.parse(JSON.stringify(artifact).replaceAll("http://localhost:3000", targetBase)),
  );
}

async function readEvidenceEvents(result: ReplayResult): Promise<unknown[]> {
  expect(result.evidence.logPath).toBeDefined();
  const raw = await readFile(result.evidence.logPath!, "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line) as unknown);
}
