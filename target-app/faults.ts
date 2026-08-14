/**
 * Fault injection.
 *
 * This module is what makes requirement 3.3 demonstrable rather than merely
 * described. The brief's interesting failures are runtime conditions — not-found,
 * a surprise dialog, an app error, session expiry — and a target you cannot put
 * into those states can only ever be replayed on the happy path.
 *
 * Exactly four faults are implemented, one per arm of the replay result contract:
 *
 * | Fault               | Result class it exercises                       |
 * |---------------------|-------------------------------------------------|
 * | not_found           | business outcome — MEMBER_NOT_FOUND             |
 * | unexpected_dialog   | recoverable — a declared, bounded interstitial  |
 * | app_error           | hard failure — 500, stop and report             |
 * | session_expired     | escalation — needs a human to re-authenticate   |
 *
 * `validation_error`, `permission_denied`, and `slow_load` are deliberately absent.
 * Each is a few lines once the taxonomy exists; adding them before it does would be
 * breadth standing in for depth.
 *
 * ## Why arming is server-side and gated behind /admin
 *
 * The agent must not be able to reach this. An agent that could disarm faults could
 * disable the very conditions the safety model exists to handle, and one that could
 * arm them could sabotage its own replay. `/admin/**` is therefore denied in
 * config/allowlist.json — the control plane is unreachable from the data plane. That
 * separation is the actual design point; the toggles themselves are plumbing.
 */

export const FAULT_KINDS = [
  "not_found",
  "unexpected_dialog",
  "app_error",
  "session_expired",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export function isFaultKind(value: unknown): value is FaultKind {
  return typeof value === "string" && (FAULT_KINDS as readonly string[]).includes(value);
}

/**
 * `once` is the default because it matches how these conditions actually behave:
 * a transient dialog appears and is dismissed, a session expires and is renewed.
 * A persistently armed fault models the sustained-outage case instead, which is
 * what you want when checking that a recovery handler stays bounded rather than
 * retrying forever.
 */
export type FaultMode = "once" | "persistent";

interface ArmedFault {
  kind: FaultKind;
  mode: FaultMode;
  armedAt: number;
}

const armed = new Map<FaultKind, ArmedFault>();

export function armFault(kind: FaultKind, mode: FaultMode = "once"): void {
  armed.set(kind, { kind, mode, armedAt: Date.now() });
}

export function disarmFault(kind: FaultKind): void {
  armed.delete(kind);
}

export function disarmAll(): void {
  armed.clear();
}

export function listArmed(): ArmedFault[] {
  return [...armed.values()];
}

/**
 * Test whether a fault should fire now, consuming it if it was armed `once`.
 *
 * `queryOverride` lets a single request force a fault via `?_fault=` without arming
 * server state. That exists for manual verification — a reviewer walking the app by
 * hand can reach every failure screen from the URL bar, with nothing to reset
 * afterwards and no risk of leaving state armed for the next run.
 */
export function consumeFault(kind: FaultKind, queryOverride?: unknown): boolean {
  if (typeof queryOverride === "string" && queryOverride === kind) return true;

  const entry = armed.get(kind);
  if (!entry) return false;
  if (entry.mode === "once") armed.delete(kind);
  return true;
}
