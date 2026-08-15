/**
 * The surface seam.
 *
 * Everything above this interface — the replay engine, and later the discovery agent
 * — is written against these five members and knows nothing about browsers, the DOM,
 * or Playwright. That is what makes "extend to a desktop app" an addition rather than
 * a rewrite: a UIA or AX adapter implements the same five members, because role,
 * accessible name, and containing scope are exactly what those platform APIs expose.
 *
 * The vocabulary itself lives in `src/artifact/locator.ts` and is shared with the
 * artifact, so a recorded flow and a live surface speak the same language by
 * construction rather than by translation.
 */

import type { Action, Condition, LocatorDescriptor } from "../artifact/locator.js";

/**
 * One control as perceived on the current screen.
 *
 * This is the unit the discovery agent will choose from in Phase 4 — it picks an
 * element by `id`, never by coordinate or selector, so model unreliability cannot
 * degrade the quality of what gets recorded.
 */
export interface InventoryElement {
  /** Stable only within a single observation. Not persisted anywhere. */
  id: number;
  role: string;
  /** Accessible name, derived where the platform provides none. May be "". */
  name: string;
  /** Which rung of the ladder produced `name` — diagnostic, never matched on. */
  nameSource: NameSource | null;
  /** Current value, for controls that have one. */
  value?: string;
  /** Frame names outermost-first. Empty is the top-level document. */
  framePath: string[];
  enabled: boolean;
  checked?: boolean;
  /** Present only to render annotated screenshots; never recorded in an artifact. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export type NameSource =
  | "native"
  | "aria-label"
  | "aria-labelledby"
  | "label-for"
  | "label-wrapping"
  | "title"
  | "adjacent-cell"
  | "derived-other";

/** What the adapter can see right now. */
export interface Observation {
  url: string;
  title: string;
  inventory: InventoryElement[];
  /**
   * Present only when the caller asked for one and the surface can produce one.
   * The inventory above is a complete textual rendering of the screen, so a
   * screenshot is an aid to a human or a vision model — never a requirement.
   */
  screenshot?: Buffer;
}

/**
 * The outcome of trying to find one control.
 *
 * `ambiguous` is a first-class result rather than an error subtype because it is the
 * dominant failure mode on legacy grids, and because the correct response to it is
 * different: a miss may mean the screen has not loaded, whereas ambiguity means the
 * locator is under-specified and retrying will never help.
 */
export type Resolution =
  | { kind: "hit"; element: ResolvedElement; via: ResolutionTier }
  | { kind: "miss"; candidatesByRole: number; diagnostic: string }
  | { kind: "ambiguous"; matches: number; diagnostic: string };

/**
 * Which tier answered.
 *
 * Recorded per step by replay. A step that starts resolving via a fallback tier when
 * it used to resolve semantically has not failed — but the surface moved, and that is
 * the drift signal that flags an artifact for re-recording.
 */
export type ResolutionTier = "semantic" | "fallback-text" | "fallback-dom";

/** An opaque handle to something on the surface. Never cached across steps. */
export interface ResolvedElement {
  readonly _brand: unique symbol;
}

export interface ExtractOptions {
  from: "text_content" | "field_value";
}

export interface SurfaceAdapter {
  /** Everything visible right now. */
  observe(options?: { screenshot?: boolean }): Promise<Observation>;

  /** Perform one action. Resolves its own targets immediately before acting. */
  act(action: Action, inputs: Readonly<Record<string, string>>): Promise<void>;

  /** Find one control. Never guesses: ties resolve to `ambiguous`. */
  resolve(
    descriptor: LocatorDescriptor,
    inputs: Readonly<Record<string, string>>,
  ): Promise<Resolution>;

  /** Evaluate a predicate against the current screen. */
  check(condition: Condition, inputs: Readonly<Record<string, string>>): Promise<boolean>;

  /** Read a value out of the screen. */
  extract(
    descriptor: LocatorDescriptor,
    options: ExtractOptions,
    inputs: Readonly<Record<string, string>>,
  ): Promise<string | null>;

  /** Navigate to an absolute URL. */
  navigate(url: string): Promise<void>;

  /** Richer evidence, captured on failure. */
  snapshot(): Promise<{ url: string; screenshot: Buffer; domSnapshot: string }>;

  dispose(): Promise<void>;
}

/**
 * Text comparison shared by the adapter and its tests.
 *
 * Normalisation collapses whitespace, strips a trailing colon or asterisk, and
 * lowercases. Enterprise UIs are casually inconsistent about all three ("Member ID",
 * "Member ID:", "MEMBER ID "), and treating that cosmetic noise as identity would
 * make every locator brittle for no gain in precision.
 */
export function normalizeName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:*：]+$/, "")
    .trim()
    .toLowerCase();
}

export function nameMatches(
  observed: string,
  expected: string,
  mode: "exact" | "normalized" | "contains",
): boolean {
  if (mode === "exact") return observed === expected;
  const a = normalizeName(observed);
  const b = normalizeName(expected);
  return mode === "contains" ? a.includes(b) : a === b;
}
