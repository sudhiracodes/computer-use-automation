export type LeaseOwner = "agent" | "pending_human" | "human" | "none";

export interface SessionLeaseSnapshot {
  id: string;
  owner: LeaseOwner;
  reason?: string;
  updatedAt: string;
}

export class SessionLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLeaseError";
  }
}

export class SessionLease {
  private owner: LeaseOwner = "agent";
  private reason: string | undefined;
  private updatedAt = new Date().toISOString();

  constructor(readonly id: string = `lease-${Date.now().toString(36)}`) {}

  snapshot(): SessionLeaseSnapshot {
    return {
      id: this.id,
      owner: this.owner,
      ...(this.reason ? { reason: this.reason } : {}),
      updatedAt: this.updatedAt,
    };
  }

  assertAgentControl(): void {
    if (this.owner !== "agent") {
      throw new SessionLeaseError(`automation cannot act while lease owner is ${this.owner}`);
    }
  }

  requestHuman(reason: string): SessionLeaseSnapshot {
    if (this.owner !== "agent") {
      throw new SessionLeaseError(`cannot request human control from ${this.owner}`);
    }
    this.owner = "pending_human";
    this.reason = reason;
    this.touch();
    return this.snapshot();
  }

  acceptHuman(): SessionLeaseSnapshot {
    if (this.owner !== "pending_human") {
      throw new SessionLeaseError(`human cannot accept lease from ${this.owner}`);
    }
    this.owner = "human";
    this.touch();
    return this.snapshot();
  }

  resumeAgent(): SessionLeaseSnapshot {
    if (this.owner !== "human") {
      throw new SessionLeaseError(`agent cannot resume from ${this.owner}`);
    }
    this.owner = "agent";
    this.reason = undefined;
    this.touch();
    return this.snapshot();
  }

  abort(): SessionLeaseSnapshot {
    this.owner = "none";
    this.touch();
    return this.snapshot();
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}
