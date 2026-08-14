/**
 * Surface vocabulary: how a control is identified, what can be asserted about
 * the current state, and what can be done to it.
 *
 * This module is deliberately free of any web/Playwright/DOM concept. It is the
 * shared language between the artifact (what was recorded) and a SurfaceAdapter
 * (how a particular surface is perceived and driven). A desktop adapter built on
 * Windows UIA or macOS AX consumes exactly these types — role, accessible name,
 * and containing scope are what those APIs expose too.
 */

import { z } from "zod";

/**
 * How a recorded name is compared against a name observed at replay time.
 *
 * `normalized` is the default because enterprise UIs are casually inconsistent
 * about whitespace, casing, and trailing colons ("Member ID", "Member ID:",
 * "MEMBER ID "). Normalizing those away is not drift tolerance — it is refusing
 * to treat cosmetic noise as identity.
 */
export const NameMatch = z.enum(["exact", "normalized", "contains"]);
export type NameMatch = z.infer<typeof NameMatch>;

/**
 * A value supplied to an action or comparison: either baked into the artifact, or
 * drawn from a caller-supplied input at invocation time.
 *
 * Kept as distinct variants rather than as interpolated strings so that validation
 * can prove every parameter reference names a declared input, and so the safety
 * layer can reason about where a `secret` may legally flow. Template strings would
 * make both undecidable.
 */
export const ValueRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: z.string() }),
  z.strictObject({ kind: z.literal("param"), param: z.string().min(1) }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

/**
 * Resolve a ValueRef against bound inputs.
 *
 * Throws on an unbound parameter rather than substituting an empty string. A
 * missing member id must not quietly become a search for "" — that is how a replay
 * ends up reporting a confident wrong answer instead of a clean failure.
 */
export function resolveValueRef(ref: ValueRef, inputs: Readonly<Record<string, string>>): string {
  if (ref.kind === "literal") return ref.value;
  const bound = inputs[ref.param];
  if (bound === undefined) {
    throw new Error(`input "${ref.param}" was not supplied`);
  }
  return bound;
}

/**
 * Narrows the search space before a name is matched.
 *
 * This is the answer to the dominant failure mode on table-based legacy screens:
 * twelve rows each containing a link named "View". A bare role+name locator is
 * ambiguous across all twelve; the same locator scoped to the row containing
 * "100234" is exact. Scope is what makes semantic targeting viable on markup
 * that has no useful identifiers.
 */
export const LocatorScope = z.strictObject({
  kind: z.enum([
    /** A fieldset, labelled region, or heading-titled block. */
    "labelled_group",
    /** A table row identified by text it contains. */
    "table_row",
  ]),
  /**
   * Text identifying the containing group or row — a ValueRef, not a literal.
   *
   * This is the data/structure split that runs through the whole vocabulary:
   * anything used to match *content* is parameterizable, anything describing
   * *screen structure* is not. A row is chosen by data ("the row for member
   * 100234"), so hard-coding it would pin the artifact to a single member and
   * destroy the parameterization that makes it a reusable capability. A control's
   * role and label, by contrast, are properties of the screen's design and stay
   * literal.
   */
  name: ValueRef,
  nameMatch: NameMatch.default("normalized"),
});
export type LocatorScope = z.infer<typeof LocatorScope>;

/**
 * Lower-tier locators. These exist ONLY as fallbacks, never as a primary
 * strategy — see `LocatorDescriptor`.
 *
 * Replay records which tier actually resolved each step. That signal is the
 * drift detector: a step that starts resolving via `dom` when it used to resolve
 * semantically has not failed, but it has told you the surface moved.
 */
export const FallbackLocator = z.discriminatedUnion("strategy", [
  z.strictObject({
    strategy: z.literal("text"),
    text: z.string().min(1),
    nameMatch: NameMatch.default("normalized"),
  }),
  z.strictObject({
    strategy: z.literal("dom"),
    /** Last resort. Brittle by nature on markup with generated ids. */
    css: z.string().min(1),
  }),
]);
export type FallbackLocator = z.infer<typeof FallbackLocator>;

/**
 * How a single control is found.
 *
 * The primary strategy is structurally fixed to `semantic`: the schema makes it
 * impossible to record a CSS selector or a pixel coordinate as the way a control
 * is identified. That is not a lint rule or a convention — an artifact whose
 * primary strategy is a selector cannot be represented in this type at all.
 *
 * Coordinates appear nowhere in this file. A recorded coordinate is worthless
 * the moment a viewport, font, or zoom level changes, and replay determinism is
 * the whole point of the artifact.
 */
export const LocatorDescriptor = z.strictObject({
  strategy: z.literal("semantic"),

  /** ARIA/UIA role: "textbox", "button", "link", "cell", "combobox", … */
  role: z.string().min(1),

  /** Accessible name. Empty string is legal — unnamed controls exist. */
  name: z.string(),

  nameMatch: NameMatch.default("normalized"),

  /**
   * How the accessible name was obtained when this locator was recorded.
   *
   * Diagnostic only — never an input to matching. It exists because this target's
   * controls are named inconsistently (see target-app/render.ts: some via
   * `aria-label`, some via `<label for>`, some via `title`, and some with no
   * accessible name at all, reachable only by deriving one from adjacent table-cell
   * text). Recording which rung of that ladder produced the name turns a silent
   * change into a visible one: a control whose name used to come from
   * `adjacent-cell` and now comes from `label-for` means the app was edited. That
   * is a drift signal, not a failure, and it is unrecoverable if not captured at
   * record time.
   */
  nameSource: z
    .enum(["native", "aria-label", "label-for", "title", "adjacent-cell", "derived-other"])
    .optional(),

  scope: LocatorScope.optional(),

  /**
   * Disambiguator of last resort, within the scope. Present only when the
   * recorder genuinely could not distinguish candidates any other way, because
   * an ordinal encodes position rather than meaning and is the first thing to
   * break when a screen gains a row.
   */
  ordinal: z.number().int().nonnegative().optional(),

  /**
   * Frame names from outermost inward. Empty means the top-level document.
   * Framesets re-navigate their content frame constantly, so the path is part of
   * a control's identity, not incidental context.
   */
  framePath: z.array(z.string()).default([]),

  fallbacks: z.array(FallbackLocator).default([]),
});
export type LocatorDescriptor = z.infer<typeof LocatorDescriptor>;

/**
 * A predicate over observed surface state.
 *
 * One type serves three jobs — step postcondition, business-outcome detector,
 * and recovery trigger — because all three ask the same question: is this true
 * of the screen right now? Modelling them separately would triple the surface
 * area of the adapter for no gain.
 */
export const Condition = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("element_present"),
    target: LocatorDescriptor,
  }),
  z.strictObject({
    kind: z.literal("element_absent"),
    target: LocatorDescriptor,
  }),
  z.strictObject({
    kind: z.literal("text_present"),
    /** Content, therefore a ValueRef — "the member's id appears on this screen". */
    text: ValueRef,
    nameMatch: NameMatch.default("normalized"),
  }),
  z.strictObject({
    kind: z.literal("url_matches"),
    /**
     * Glob over path + query, e.g. "/console/member/*". Structure, so literal —
     * and a glob rather than a regex on purpose: a regex in a document that gets
     * reviewed is a liability, and route shapes do not need that much power.
     */
    pattern: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("field_value"),
    target: LocatorDescriptor,
    /** Content — lets a step assert that a field really holds what was typed. */
    equals: ValueRef,
  }),
]);
export type Condition = z.infer<typeof Condition>;

/**
 * A checkpoint is a Condition asserted at a particular moment. The alias exists
 * for readability at call sites; there is deliberately no separate type.
 */
export const Checkpoint = Condition;
export type Checkpoint = Condition;

/** Something done to the surface. */
export const Action = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("navigate"),
    url: ValueRef,
  }),
  z.strictObject({
    kind: z.literal("click"),
    target: LocatorDescriptor,
  }),
  z.strictObject({
    kind: z.literal("type"),
    target: LocatorDescriptor,
    value: ValueRef,
    mode: z.enum(["replace", "append"]).default("replace"),
  }),
  z.strictObject({
    kind: z.literal("select"),
    target: LocatorDescriptor,
    value: ValueRef,
  }),
  /**
   * Set a checkbox or radio to an absolute state.
   *
   * Deliberately not expressed as a `click`. Clicking a checkbox *toggles* it, which
   * is not idempotent: replay the same click twice — or retry it after a transient
   * failure — and the box ends up in the opposite state. For a system whose entire
   * claim is deterministic replay, an action whose effect depends on the state it
   * finds is a defect. `check` declares the desired end state, so it converges no
   * matter how many times it runs.
   */
  z.strictObject({
    kind: z.literal("check"),
    target: LocatorDescriptor,
    checked: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.string().min(1),
    target: LocatorDescriptor.optional(),
  }),
  z.strictObject({
    kind: z.literal("wait_for"),
    condition: Condition,
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  }),
]);
export type Action = z.infer<typeof Action>;

/**
 * Actions that move the run to a different screen, and therefore must assert what
 * they produced.
 *
 * `type` and `select` are excluded deliberately. They set field state, which a later
 * assertion covers; requiring a postcondition on each would add ceremony to every
 * form field without catching anything. `click` and `navigate` are where a run
 * silently diverges from the recorded path, which is the failure worth forbidding.
 */
export const SCREEN_CHANGING_ACTIONS = ["click", "navigate"] as const;

/**
 * Actions that mutate something beyond the current field.
 *
 * Distinct from SCREEN_CHANGING_ACTIONS above: this is the input to risk analysis
 * (Phase 5), not to the postcondition rule.
 */
export const STATE_CHANGING_ACTIONS = ["click", "navigate", "select", "type", "key", "check"] as const;

/**
 * Every locator reachable from an action — used by validation and by the safety
 * layer, both of which need to walk targets without knowing action shapes.
 */
export function locatorsOf(action: Action): LocatorDescriptor[] {
  switch (action.kind) {
    case "click":
    case "type":
    case "select":
    case "check":
      return [action.target];
    case "key":
      return action.target ? [action.target] : [];
    case "wait_for":
      return locatorsOfCondition(action.condition);
    case "navigate":
      return [];
  }
}

export function locatorsOfCondition(condition: Condition): LocatorDescriptor[] {
  switch (condition.kind) {
    case "element_present":
    case "element_absent":
    case "field_value":
      return [condition.target];
    case "text_present":
    case "url_matches":
      return [];
  }
}

/**
 * Every ValueRef reachable from an action, transitively.
 *
 * "Transitively" is the point: a ValueRef can hide inside a locator's scope, and a
 * locator can hide inside a `wait_for` condition. A shallow walk would let
 * `{ scope: { name: { kind: "param", param: "typo" } } }` pass validation and fail
 * at replay time instead — which is precisely the class of error these invariants
 * exist to catch at authoring time.
 */
export function valueRefsOf(action: Action): ValueRef[] {
  const refs: ValueRef[] = [];

  switch (action.kind) {
    case "navigate":
      refs.push(action.url);
      break;
    case "type":
    case "select":
      refs.push(action.value);
      break;
    case "wait_for":
      refs.push(...valueRefsOfCondition(action.condition));
      break;
    case "click":
    case "key":
    case "check":
      break;
  }

  for (const locator of locatorsOf(action)) {
    refs.push(...valueRefsOfLocator(locator));
  }
  return refs;
}

/** Every ValueRef reachable from a condition, transitively. */
export function valueRefsOfCondition(condition: Condition): ValueRef[] {
  const refs: ValueRef[] = [];

  switch (condition.kind) {
    case "text_present":
      refs.push(condition.text);
      break;
    case "field_value":
      refs.push(condition.equals);
      break;
    case "element_present":
    case "element_absent":
    case "url_matches":
      break;
  }

  for (const locator of locatorsOfCondition(condition)) {
    refs.push(...valueRefsOfLocator(locator));
  }
  return refs;
}

/** A locator's own ValueRefs — currently only its scope's identifying text. */
export function valueRefsOfLocator(locator: LocatorDescriptor): ValueRef[] {
  return locator.scope ? [locator.scope.name] : [];
}
