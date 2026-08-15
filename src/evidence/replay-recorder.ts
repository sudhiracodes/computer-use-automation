/**
 * Structured replay evidence.
 *
 * This module records what replay did and why without knowing anything about LLMs
 * or providers. It is deliberately append-only JSONL: easy to stream, easy to
 * inspect in a terminal, and hard to accidentally turn into control flow.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ReplayEvidenceEvent =
  | {
      type: "run_started";
      runId: string;
      artifactId: string;
      artifactVersion: string;
      at: string;
    }
  | {
      type: "step_started";
      runId: string;
      stepId: string;
      action: string;
      intent: string;
      at: string;
    }
  | {
      type: "step_completed";
      runId: string;
      stepId: string;
      at: string;
    }
  | {
      type: "output_extracted";
      runId: string;
      name: string;
      at: string;
    }
  | {
      type: "business_outcome";
      runId: string;
      stepId: string;
      code: string;
      message: string;
      at: string;
    }
  | {
      type: "recovery_started";
      runId: string;
      stepId: string;
      recoveryId: string;
      attempt: number;
      maxTimes: number;
      at: string;
    }
  | {
      type: "recovery_completed";
      runId: string;
      stepId: string;
      recoveryId: string;
      at: string;
    }
  | {
      type: "intervention_requested";
      runId: string;
      interventionId: string;
      stepId: string;
      reason: string;
      leaseOwner: string;
      url?: string;
      at: string;
    }
  | {
      type: "operator_took_control";
      runId: string;
      interventionId: string;
      stepId: string;
      leaseOwner: "human";
      url?: string;
      at: string;
    }
  | {
      type: "operator_navigation_observed";
      runId: string;
      interventionId: string;
      fromUrl?: string;
      toUrl: string;
      changed: boolean;
      at: string;
    }
  | {
      type: "operator_returned_control";
      runId: string;
      interventionId: string;
      stepId: string;
      leaseOwner: "agent";
      url: string;
      at: string;
    }
  | {
      type: "resume_rechecked";
      runId: string;
      stepId: string;
      checkpointSatisfied: boolean;
      at: string;
    }
  | {
      type: "failure";
      runId: string;
      stepId: string;
      class: string;
      expected: string;
      observed: string;
      screenshotPath?: string;
      domSnapshotPath?: string;
      at: string;
    }
  | {
      type: "run_finished";
      runId: string;
      status: string;
      at: string;
    };

export type ReplayEvidenceEventInput = ReplayEvidenceEvent extends infer Event
  ? Event extends ReplayEvidenceEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

export interface ReplayEvidenceRef {
  runId: string;
  logPath?: string;
  screenshotPath?: string;
  domSnapshotPath?: string;
}

export interface FailureSnapshot {
  screenshot: Buffer;
  domSnapshot: string;
}

export interface ReplayEvidenceRecorder {
  readonly ref: ReplayEvidenceRef;
  record(event: ReplayEvidenceEventInput): Promise<void>;
  captureFailureSnapshot(snapshot: FailureSnapshot): Promise<Pick<ReplayEvidenceRef, "screenshotPath" | "domSnapshotPath">>;
}

export interface ReplayEvidenceOptions {
  runId?: string;
  dir?: string;
}

export function createReplayEvidenceRecorder(
  options: ReplayEvidenceOptions = {},
): ReplayEvidenceRecorder {
  const runId = options.runId ?? `replay-${Date.now().toString(36)}`;
  if (!options.dir) return new MemoryReplayEvidenceRecorder(runId);
  return new FileReplayEvidenceRecorder(runId, options.dir);
}

class MemoryReplayEvidenceRecorder implements ReplayEvidenceRecorder {
  readonly ref: ReplayEvidenceRef;

  constructor(runId: string) {
    this.ref = { runId };
  }

  async record(_event: ReplayEvidenceEventInput): Promise<void> {
    // No-op by design. Callers that want persisted evidence pass `dir`.
  }

  async captureFailureSnapshot(_snapshot: FailureSnapshot): Promise<Pick<ReplayEvidenceRef, "screenshotPath" | "domSnapshotPath">> {
    return {};
  }
}

class FileReplayEvidenceRecorder implements ReplayEvidenceRecorder {
  readonly ref: ReplayEvidenceRef;
  private readonly runDir: string;

  constructor(runId: string, dir: string) {
    this.runDir = join(dir, runId);
    this.ref = {
      runId,
      logPath: join(this.runDir, "replay.jsonl"),
    };
  }

  async record(event: ReplayEvidenceEventInput): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    const line = `${JSON.stringify({ ...event, runId: this.ref.runId, at: new Date().toISOString() })}\n`;
    await writeFile(this.ref.logPath!, line, { encoding: "utf8", flag: "a" });
  }

  async captureFailureSnapshot(snapshot: FailureSnapshot): Promise<Pick<ReplayEvidenceRef, "screenshotPath" | "domSnapshotPath">> {
    await mkdir(this.runDir, { recursive: true });
    const screenshotPath = join(this.runDir, "failure.png");
    const domSnapshotPath = join(this.runDir, "failure.html");
    await writeFile(screenshotPath, snapshot.screenshot);
    await writeFile(domSnapshotPath, snapshot.domSnapshot, "utf8");
    this.ref.screenshotPath = screenshotPath;
    this.ref.domSnapshotPath = domSnapshotPath;
    return { screenshotPath, domSnapshotPath };
  }
}
