import type { SessionLeaseSnapshot } from "./session-lease.js";

export type InterventionStatus = "pending" | "accepted" | "resumed" | "aborted";

export interface Intervention {
  id: string;
  capabilityId: string;
  runId: string;
  stepId: string;
  reason: string;
  url?: string;
  status: InterventionStatus;
  lease: SessionLeaseSnapshot;
  createdAt: string;
  updatedAt: string;
}

export class InterventionStore {
  private readonly interventions = new Map<string, Intervention>();

  create(input: {
    capabilityId: string;
    runId: string;
    stepId: string;
    reason: string;
    url?: string;
    lease: SessionLeaseSnapshot;
  }): Intervention {
    const now = new Date().toISOString();
    const intervention: Intervention = {
      id: `intervention-${this.interventions.size + 1}`,
      capabilityId: input.capabilityId,
      runId: input.runId,
      stepId: input.stepId,
      reason: input.reason,
      ...(input.url ? { url: input.url } : {}),
      status: "pending",
      lease: input.lease,
      createdAt: now,
      updatedAt: now,
    };
    this.interventions.set(intervention.id, intervention);
    return intervention;
  }

  update(id: string, status: InterventionStatus, lease: SessionLeaseSnapshot): Intervention {
    const existing = this.interventions.get(id);
    if (!existing) throw new Error(`unknown intervention "${id}"`);
    const next = { ...existing, status, lease, updatedAt: new Date().toISOString() };
    this.interventions.set(id, next);
    return next;
  }

  get(id: string): Intervention | null {
    return this.interventions.get(id) ?? null;
  }

  list(): Intervention[] {
    return [...this.interventions.values()];
  }
}
