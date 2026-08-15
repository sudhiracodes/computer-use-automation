import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifact/io.js";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "../src/artifact/schema.js";
import { replayArtifact } from "../src/replay/index.js";
import { PlaywrightWebAdapter } from "../src/surface/web/playwright-adapter.js";
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

describe("deterministic replay", () => {
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
});

async function runReplay(artifact: Artifact): ReturnType<typeof replayArtifact> {
  const adapter = await PlaywrightWebAdapter.launch();
  try {
    return await replayArtifact(artifact, {
      adapter,
      pollIntervalMs: 25,
      inputs: {
        operatorId: "teller01",
        operatorPassword: "change-me-locally",
        memberId: "100234",
        accountType: "Holiday Club",
        initialDeposit: "25.00",
      },
    });
  } finally {
    await adapter.dispose();
  }
}

function rebaseArtifact(artifact: Artifact, targetBase: string): Artifact {
  return CapabilityArtifact.parse(
    JSON.parse(JSON.stringify(artifact).replaceAll("http://localhost:3000", targetBase)),
  );
}
