import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DiscoveryEvidenceEvent =
  | { type: "run_started"; runId: string; goal: string; targetUrl: string; provider: string; model: string; at: string }
  | { type: "observation"; runId: string; step: number; url: string; title: string; inventoryCount: number; at: string }
  | { type: "model_tool"; runId: string; step: number; name: string; args: unknown; at: string }
  | { type: "action_applied"; runId: string; step: number; action: string; at: string }
  | { type: "artifact_generated"; runId: string; artifactId: string; stepCount: number; at: string }
  | { type: "run_finished"; runId: string; status: "success" | "failed"; at: string };

export type DiscoveryEvidenceEventInput = DiscoveryEvidenceEvent extends infer Event
  ? Event extends DiscoveryEvidenceEvent
    ? Omit<Event, "runId" | "at">
    : never
  : never;

export interface DiscoveryEvidenceRef {
  runId: string;
  logPath?: string;
}

export interface DiscoveryEvidenceRecorder {
  readonly ref: DiscoveryEvidenceRef;
  record(event: DiscoveryEvidenceEventInput): Promise<void>;
}

export interface DiscoveryEvidenceOptions {
  runId?: string;
  dir?: string;
}

export function createDiscoveryEvidenceRecorder(
  options: DiscoveryEvidenceOptions = {},
): DiscoveryEvidenceRecorder {
  const runId = options.runId ?? `discovery-${Date.now().toString(36)}`;
  if (!options.dir) return new MemoryDiscoveryEvidenceRecorder(runId);
  return new FileDiscoveryEvidenceRecorder(runId, options.dir);
}

class MemoryDiscoveryEvidenceRecorder implements DiscoveryEvidenceRecorder {
  readonly ref: DiscoveryEvidenceRef;

  constructor(runId: string) {
    this.ref = { runId };
  }

  async record(_event: DiscoveryEvidenceEventInput): Promise<void> {
    // No-op unless the caller asks for persisted discovery evidence.
  }
}

class FileDiscoveryEvidenceRecorder implements DiscoveryEvidenceRecorder {
  readonly ref: DiscoveryEvidenceRef;
  private readonly runDir: string;

  constructor(runId: string, dir: string) {
    this.runDir = join(dir, runId);
    this.ref = { runId, logPath: join(this.runDir, "discovery.jsonl") };
  }

  async record(event: DiscoveryEvidenceEventInput): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    const line = `${JSON.stringify({ ...event, runId: this.ref.runId, at: new Date().toISOString() })}\n`;
    await writeFile(this.ref.logPath!, line, { encoding: "utf8", flag: "a" });
  }
}
