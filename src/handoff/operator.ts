import { InterventionStore, type Intervention } from "./intervention.js";
import { SessionLease } from "./session-lease.js";

export class OperatorHandoff {
  constructor(
    private readonly lease: SessionLease,
    private readonly interventions: InterventionStore,
  ) {}

  accept(interventionId: string): Intervention {
    const lease = this.lease.acceptHuman();
    return this.interventions.update(interventionId, "accepted", lease);
  }

  resume(interventionId: string): Intervention {
    const lease = this.lease.resumeAgent();
    return this.interventions.update(interventionId, "resumed", lease);
  }

  abort(interventionId: string): Intervention {
    const lease = this.lease.abort();
    return this.interventions.update(interventionId, "aborted", lease);
  }
}
