import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Action, Condition, LocatorDescriptor } from "../src/artifact/locator.js";
import { loadArtifact } from "../src/artifact/io.js";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "../src/artifact/schema.js";
import { InterventionStore, OperatorHandoff, SessionLease } from "../src/handoff/index.js";
import { loadAllowlistConfig, evaluateUrlPolicy, type AllowlistConfig, type PolicyContext } from "../src/policy/index.js";
import { replayArtifact } from "../src/replay/index.js";
import type { ExtractOptions, Observation, Resolution, SurfaceAdapter } from "../src/surface/adapter.js";
import { PlaywrightWebAdapter } from "../src/surface/web/playwright-adapter.js";
import { app } from "../target-app/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.sequential("Phase 5 policy and handoff", () => {
  it("allows only configured origins, routes, and action kinds", async () => {
    const allowlist = await phase5Allowlist();

    expect(evaluateUrlPolicy(allowlist, `${base}/console/member/100234/sub-account/review`)).toBeNull();
    expect(evaluateUrlPolicy(allowlist, `${base}/admin`)).toContain("explicitly denied");
    expect(evaluateUrlPolicy(allowlist, "https://example.com/console/search")).toContain("not allowlisted");
  });

  it("pauses on an irreversible replay step, lets a human use the same session, then resumes with a checkpoint recheck", async () => {
    const artifact = await phase5Artifact();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-handoff-evidence-"));
    const adapter = await PlaywrightWebAdapter.launch();
    const lease = new SessionLease("phase5-lease");
    const interventions = new InterventionStore();
    const operator = new OperatorHandoff(lease, interventions);
    const inputs = defaultInputs();
    const policy = await phase5Policy(artifact);

    try {
      const paused = await replayArtifact(artifact, {
        adapter,
        inputs,
        pollIntervalMs: 25,
        evidence: { dir: evidenceDir, runId: "pause" },
        policy,
        lease,
        interventions,
      });

      expect(paused.status).toBe("intervention_required");
      if (paused.status !== "intervention_required") return;
      expect(paused.intervention.stepId).toBe("confirm-open-account");
      expect(lease.snapshot().owner).toBe("pending_human");

      operator.accept(paused.intervention.id);
      expect(lease.snapshot().owner).toBe("human");

      const confirm = artifact.steps.find((step) => step.id === "confirm-open-account");
      expect(confirm).toBeDefined();
      await adapter.act(confirm!.action, inputs);

      operator.resume(paused.intervention.id);
      expect(lease.snapshot().owner).toBe("agent");

      const resumed = await replayArtifact(artifact, {
        adapter,
        inputs,
        initialOutputs: paused.outputs,
        pollIntervalMs: 25,
        evidence: { dir: evidenceDir, runId: "resume" },
        policy,
        lease,
        interventions,
        resumeFromStepId: "confirm-open-account",
        resumeInterventionId: paused.intervention.id,
      });

      expect(resumed.status).toBe("success");
      if (resumed.status !== "success") return;
      expect(resumed.outputs.savingsBalance).toBe(1284.36);
      expect(resumed.outputs.newSubAccountNumber).toMatch(/^SV-100234-\d+$/);
      expect(interventions.get(paused.intervention.id)?.status).toBe("resumed");

      const pauseEvents = await readEvents(paused.evidence.logPath!);
      expect(pauseEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "intervention_requested",
            interventionId: paused.intervention.id,
            stepId: "confirm-open-account",
          }),
        ]),
      );

      const resumeEvents = await readEvents(resumed.evidence.logPath!);
      expect(resumeEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "operator_took_control", interventionId: paused.intervention.id }),
          expect.objectContaining({ type: "operator_navigation_observed", interventionId: paused.intervention.id }),
          expect.objectContaining({ type: "operator_returned_control", interventionId: paused.intervention.id }),
          expect.objectContaining({ type: "resume_rechecked", checkpointSatisfied: true }),
        ]),
      );
    } finally {
      await adapter.dispose();
    }
  }, 45_000);

  it("redacts sensitive values from replay failure evidence and DOM snapshots", async () => {
    const artifact = await phase5Artifact();
    const evidenceDir = await mkdtemp(join(tmpdir(), "cua-redacted-replay-"));
    const adapter = new SecretFailingAdapter(base);

    const result = await replayArtifact(artifact, {
      adapter,
      inputs: defaultInputs(),
      evidence: { dir: evidenceDir, runId: "redacted-failure" },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.observed).not.toContain("change-me-locally");
    const log = await readFile(result.evidence.logPath!, "utf8");
    const dom = await readFile(result.evidence.domSnapshotPath!, "utf8");
    expect(log).not.toContain("change-me-locally");
    expect(dom).not.toContain("change-me-locally");
    expect(dom).not.toContain("100234");
    expect(dom).toContain("[REDACTED]");
  });

  it("fails cleanly when resumed control returns to an unexpected state", async () => {
    const artifact = withStepTimeout(await phase5Artifact(), "confirm-open-account", 75);
    const adapter = new MismatchedResumeAdapter(base);
    const started = Date.now();

    const result = await replayArtifact(artifact, {
      adapter,
      inputs: defaultInputs(),
      pollIntervalMs: 10,
      resumeFromStepId: "confirm-open-account",
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.class).toBe("CHECKPOINT_FAILED");
    expect(result.error.stepId).toBe("confirm-open-account");
  });
});

async function phase5Artifact(): Promise<Artifact> {
  return CapabilityArtifact.parse(
    JSON.parse(JSON.stringify(await loadArtifact("artifacts/open-savings-sub-account@1.0.0.json")).replaceAll("http://localhost:3000", base)),
  );
}

async function phase5Allowlist(): Promise<AllowlistConfig> {
  const allowlist = await loadAllowlistConfig("config/allowlist.json");
  return { ...allowlist, origins: [new URL(base).origin] };
}

async function phase5Policy(artifact: Artifact): Promise<PolicyContext> {
  return {
    allowlist: await phase5Allowlist(),
    inputSensitivity: Object.fromEntries(
      Object.entries(artifact.inputs).map(([name, field]) => [name, field.sensitivity]),
    ),
  };
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

function withStepTimeout(artifact: Artifact, stepId: string, timeoutMs: number): Artifact {
  return CapabilityArtifact.parse({
    ...artifact,
    steps: artifact.steps.map((step) => step.id === stepId ? { ...step, timeoutMs } : step),
  });
}

async function readEvents(path: string): Promise<unknown[]> {
  const raw = await readFile(path, "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line) as unknown);
}

class SecretFailingAdapter implements SurfaceAdapter {
  constructor(private readonly url: string) {}

  async observe(): Promise<Observation> {
    return { url: this.url, title: "fake", inventory: [] };
  }

  async act(_action: Action, _inputs: Readonly<Record<string, string>>): Promise<void> {
    throw new Error("adapter saw change-me-locally");
  }

  async resolve(_descriptor: LocatorDescriptor, _inputs: Readonly<Record<string, string>>): Promise<Resolution> {
    return { kind: "miss", candidatesByRole: 0, diagnostic: "fake" };
  }

  async check(_condition: Condition, _inputs: Readonly<Record<string, string>>): Promise<boolean> {
    return false;
  }

  async extract(
    _descriptor: LocatorDescriptor,
    _options: ExtractOptions,
    _inputs: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    return null;
  }

  async navigate(_url: string): Promise<void> {}

  async snapshot(): Promise<{ url: string; screenshot: Buffer; domSnapshot: string }> {
    return {
      url: this.url,
      screenshot: Buffer.from("fake"),
      domSnapshot: '<div>Member 100234</div><input type="password" value="change-me-locally">',
    };
  }

  async dispose(): Promise<void> {}
}

class MismatchedResumeAdapter implements SurfaceAdapter {
  constructor(private readonly url: string) {}

  async observe(): Promise<Observation> {
    return { url: this.url, title: "wrong screen", inventory: [] };
  }

  async act(_action: Action, _inputs: Readonly<Record<string, string>>): Promise<void> {}

  async resolve(_descriptor: LocatorDescriptor, _inputs: Readonly<Record<string, string>>): Promise<Resolution> {
    return { kind: "miss", candidatesByRole: 0, diagnostic: "wrong screen" };
  }

  async check(_condition: Condition, _inputs: Readonly<Record<string, string>>): Promise<boolean> {
    return false;
  }

  async extract(
    _descriptor: LocatorDescriptor,
    _options: ExtractOptions,
    _inputs: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    return null;
  }

  async navigate(_url: string): Promise<void> {}

  async snapshot(): Promise<{ url: string; screenshot: Buffer; domSnapshot: string }> {
    return {
      url: this.url,
      screenshot: Buffer.from("fake"),
      domSnapshot: "<html><body>wrong screen</body></html>",
    };
  }

  async dispose(): Promise<void> {}
}
