import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifact/io.js";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "../src/artifact/schema.js";
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

describe("PlaywrightWebAdapter", () => {
  it("derives names for hostile legacy controls from the same ladder the artifact records", async () => {
    const artifact = rebaseArtifact(
      await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json"),
      base,
    );
    const adapter = await PlaywrightWebAdapter.launch();
    const inputs = {
      operatorId: "teller01",
      operatorPassword: "change-me-locally",
      memberId: "100234",
      accountType: "Holiday Club",
      initialDeposit: "25.00",
    };

    try {
      for (const step of artifact.steps.slice(0, 8)) {
        await adapter.act(step.action, inputs);
        if (step.postcondition) {
          await adapter.act({ kind: "wait_for", condition: step.postcondition, timeoutMs: step.timeoutMs }, inputs);
        }
      }

      const observation = await adapter.observe();
      const contentControls = observation.inventory.filter((element) =>
        element.framePath.includes("content"),
      );

      expect(contentControls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "combobox", name: "Account Type", nameSource: "title" }),
          expect.objectContaining({ role: "textbox", name: "Initial Deposit", nameSource: "label-for" }),
          expect.objectContaining({ role: "combobox", name: "Purpose", nameSource: "adjacent-cell" }),
          expect.objectContaining({ role: "checkbox", name: "Disclosure", nameSource: "adjacent-cell" }),
        ]),
      );
    } finally {
      await adapter.dispose();
    }
  }, 20_000);
});

function rebaseArtifact(artifact: Artifact, targetBase: string): Artifact {
  return CapabilityArtifact.parse(
    JSON.parse(JSON.stringify(artifact).replaceAll("http://localhost:3000", targetBase)),
  );
}
