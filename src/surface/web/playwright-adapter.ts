/**
 * The web implementation of SurfaceAdapter.
 *
 * This is the only file in the system that knows Playwright exists. Everything above
 * it works in terms of roles, accessible names, scopes, and frame paths.
 *
 * Determinism is established here rather than asserted later: fixed viewport, fixed
 * locale and timezone, animations disabled. A replay that renders differently between
 * runs is not deterministic no matter how careful the executor is.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Frame,
  type JSHandle,
  type Page,
} from "playwright";
import type { Action, Condition, LocatorDescriptor } from "../../artifact/locator.js";
import { resolveValueRef } from "../../artifact/locator.js";
import {
  nameMatches,
  type ExtractOptions,
  type InventoryElement,
  type Observation,
  type Resolution,
  type ResolvedElement,
  type SurfaceAdapter,
} from "../adapter.js";
import { inventoryScript, matchScript } from "./page-script.js";

export interface WebAdapterOptions {
  headless?: boolean;
  /** Fixed so that what the model sees and what replay sees cannot diverge. */
  viewport?: { width: number; height: number };
  /** Per-action ceiling. Checkpoint waiting is the executor's job, not the adapter's. */
  actionTimeoutMs?: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Raw shape returned by the in-page matcher. */
interface MatchDiagnostics {
  ambiguousScope: number;
  scopeCandidates: number;
  count: number;
  roleCount: number;
}

type BrowserElementHandle = ElementHandle<unknown>;
type BrowserValueElement = { value?: unknown; textContent?: string | null };

export class FrameNotFoundError extends Error {
  constructor(readonly framePath: string[]) {
    super(
      `frame path [${framePath.join(" > ")}] does not exist on this screen. ` +
        `The surface may not have finished navigating, or the recorded frame is gone.`,
    );
    this.name = "FrameNotFoundError";
  }
}

export class PlaywrightWebAdapter implements SurfaceAdapter {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly actionTimeoutMs: number,
  ) {}

  static async launch(options: WebAdapterOptions = {}): Promise<PlaywrightWebAdapter> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
      // Pinned so screenshots, date rendering, and number formatting cannot vary
      // between machines or between a discovery run and a later replay.
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    return new PlaywrightWebAdapter(browser, context, page, options.actionTimeoutMs ?? 5_000);
  }

  /* ---------------------------------------------------------------- *
   * Frames
   * ---------------------------------------------------------------- */

  /**
   * Walk a frame path outermost-inward.
   *
   * Resolved fresh on every call and never cached: this target's nav frame can
   * re-navigate the content frame at any time, which invalidates any Frame object
   * held across steps.
   */
  private frameFor(framePath: readonly string[]): Frame {
    let frame: Frame = this.page.mainFrame();
    for (const name of framePath) {
      const child = frame.childFrames().find((candidate) => candidate.name() === name);
      if (!child) throw new FrameNotFoundError([...framePath]);
      frame = child;
    }
    return frame;
  }

  /* ---------------------------------------------------------------- *
   * Resolution
   * ---------------------------------------------------------------- */

  async resolve(
    descriptor: LocatorDescriptor,
    inputs: Readonly<Record<string, string>>,
  ): Promise<Resolution> {
    const frame = this.frameFor(descriptor.framePath);

    // Bind the scope's ValueRef here, in Node. The page is handed a plain string and
    // never sees a parameter name or any input it was not explicitly given.
    const wire = {
      role: descriptor.role,
      name: descriptor.name,
      nameMatch: descriptor.nameMatch,
      ordinal: descriptor.ordinal,
      scope: descriptor.scope
        ? {
            kind: descriptor.scope.kind,
            name: resolveValueRef(descriptor.scope.name, inputs),
            nameMatch: descriptor.scope.nameMatch,
          }
        : undefined,
    };

    const resultHandle: JSHandle = await frame.evaluateHandle(matchScript(wire));
    try {
      const diagnostics = (await resultHandle.evaluate((r: unknown) => {
        const result = r as { ambiguousScope: number; scopeCandidates: number; elements: unknown[]; roleCount: number };
        return {
          ambiguousScope: result.ambiguousScope,
          scopeCandidates: result.scopeCandidates,
          count: result.elements.length,
          roleCount: result.roleCount ?? 0,
        };
      })) as MatchDiagnostics;

      if (diagnostics.ambiguousScope !== 1 && diagnostics.ambiguousScope !== 0) {
        return {
          kind: "ambiguous",
          matches: diagnostics.ambiguousScope,
          diagnostic:
            `the ${describeScope(descriptor)} matched ${diagnostics.ambiguousScope} innermost containers ` +
            `(${diagnostics.scopeCandidates} before narrowing to innermost). The scope does not identify a unique container.`,
        };
      }

      if (diagnostics.count === 0) {
        return {
          kind: "miss",
          candidatesByRole: diagnostics.roleCount,
          diagnostic:
            `no ${descriptor.role} named ${JSON.stringify(descriptor.name)} ` +
            `${describeScope(descriptor)}. ${diagnostics.roleCount} element(s) of that role were present, ` +
            `so the role is right and the name is not.`,
        };
      }

      if (diagnostics.count > 1) {
        return {
          kind: "ambiguous",
          matches: diagnostics.count,
          diagnostic:
            `${diagnostics.count} elements match ${descriptor.role} named ${JSON.stringify(descriptor.name)} ` +
            `${describeScope(descriptor)}. Refusing to guess — add a scope or an ordinal.`,
        };
      }

      const element = await firstElementOf(resultHandle);
      if (!element) {
        return { kind: "miss", candidatesByRole: diagnostics.roleCount, diagnostic: "match vanished between resolution and retrieval" };
      }
      return { kind: "hit", element: element as unknown as ResolvedElement, via: "semantic" };
    } finally {
      await resultHandle.dispose();
    }
  }

  /**
   * Resolve, or throw with the diagnostic. Used by act/extract, where a caller
   * cannot proceed without the element anyway.
   */
  private async resolveOrThrow(
    descriptor: LocatorDescriptor,
    inputs: Readonly<Record<string, string>>,
  ): Promise<BrowserElementHandle> {
    const resolution = await this.resolve(descriptor, inputs);
    if (resolution.kind === "hit") {
      return resolution.element as unknown as BrowserElementHandle;
    }
    const error = new Error(resolution.diagnostic);
    error.name = resolution.kind === "ambiguous" ? "LocatorAmbiguousError" : "LocatorUnresolvedError";
    throw error;
  }

  /* ---------------------------------------------------------------- *
   * Acting
   * ---------------------------------------------------------------- */

  async act(action: Action, inputs: Readonly<Record<string, string>>): Promise<void> {
    switch (action.kind) {
      case "navigate":
        await this.navigate(resolveValueRef(action.url, inputs));
        return;

      case "click": {
        const element = await this.resolveOrThrow(action.target, inputs);
        // Playwright's actionability checks apply: an element covered by a modal
        // scrim will time out here rather than silently clicking through it, which
        // is what turns an unexpected dialog into a detected condition.
        await element.click({ timeout: this.actionTimeoutMs });
        return;
      }

      case "type": {
        const element = await this.resolveOrThrow(action.target, inputs);
        const value = resolveValueRef(action.value, inputs);
        if (action.mode === "append") {
          await element.type(value, { timeout: this.actionTimeoutMs });
        } else {
          await element.fill(value, { timeout: this.actionTimeoutMs });
        }
        return;
      }

      case "select": {
        const element = await this.resolveOrThrow(action.target, inputs);
        await element.selectOption(resolveValueRef(action.value, inputs), {
          timeout: this.actionTimeoutMs,
        });
        return;
      }

      case "check": {
        const element = await this.resolveOrThrow(action.target, inputs);
        // setChecked is idempotent — the whole reason `check` exists as an action
        // distinct from `click`.
        await element.setChecked(action.checked, { timeout: this.actionTimeoutMs });
        return;
      }

      case "key": {
        if (action.target) {
          const element = await this.resolveOrThrow(action.target, inputs);
          await element.press(action.key, { timeout: this.actionTimeoutMs });
        } else {
          await this.page.keyboard.press(action.key);
        }
        return;
      }

      case "wait_for": {
        const deadline = Date.now() + action.timeoutMs;
        while (Date.now() < deadline) {
          if (await this.check(action.condition, inputs)) return;
          await this.page.waitForTimeout(100);
        }
        throw Object.assign(new Error(`condition not met within ${action.timeoutMs}ms`), {
          name: "TimeoutError",
        });
      }
    }
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /* ---------------------------------------------------------------- *
   * Observing
   * ---------------------------------------------------------------- */

  async check(condition: Condition, inputs: Readonly<Record<string, string>>): Promise<boolean> {
    try {
      switch (condition.kind) {
        case "element_present":
          return (await this.resolve(condition.target, inputs)).kind === "hit";

        case "element_absent":
          return (await this.resolve(condition.target, inputs)).kind === "miss";

        case "url_matches":
          return globMatches(this.page.url(), condition.pattern);

        case "text_present": {
          const needle = resolveValueRef(condition.text, inputs);
          for (const frame of this.page.frames()) {
            const text = await frame
              .evaluate(() => {
                const browserGlobal = globalThis as unknown as {
                  document?: { body?: { innerText?: string } };
                };
                return browserGlobal.document?.body?.innerText ?? "";
              })
              .catch(() => "");
            if (nameMatches(text, needle, condition.nameMatch === "exact" ? "contains" : "contains")) {
              return true;
            }
          }
          return false;
        }

        case "field_value": {
          const resolution = await this.resolve(condition.target, inputs);
          if (resolution.kind !== "hit") return false;
          const element = resolution.element as unknown as BrowserElementHandle;
          const actual = await element.evaluate((el: BrowserValueElement) => {
            return typeof el.value === "string" ? el.value : (el.textContent ?? "");
          });
          return nameMatches(actual, resolveValueRef(condition.equals, inputs), "normalized");
        }
      }
    } catch (error) {
      // A frame that has not appeared yet is a "not true yet", not a crash. The
      // executor polls conditions, so returning false lets it keep waiting.
      if (error instanceof FrameNotFoundError || isTransientNavigationError(error)) return false;
      throw error;
    }
  }

  async extract(
    descriptor: LocatorDescriptor,
    options: ExtractOptions,
    inputs: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    const resolution = await this.resolve(descriptor, inputs);
    if (resolution.kind !== "hit") return null;
    const element = resolution.element as unknown as BrowserElementHandle;

    if (options.from === "field_value") {
      return element.evaluate((el: BrowserValueElement) => {
        return typeof el.value === "string" ? el.value : (el.textContent ?? "");
      });
    }
    return element.evaluate((el: BrowserValueElement) => el.textContent ?? "");
  }

  async observe(options: { screenshot?: boolean } = {}): Promise<Observation> {
    const inventory: InventoryElement[] = [];
    let id = 0;

    for (const frame of this.page.frames()) {
      const framePath = pathOf(frame, this.page);
      const raw = await frame
        .evaluate(inventoryScript())
        .catch(() => null) as { elements: Array<Omit<InventoryElement, "id" | "framePath">> } | null;
      if (!raw) continue;
      for (const element of raw.elements) {
        inventory.push({ ...element, id: (id += 1), framePath });
      }
    }

    const observation: Observation = {
      url: this.page.url(),
      title: await this.page.title(),
      inventory,
    };
    if (options.screenshot) {
      observation.screenshot = await this.page.screenshot({ fullPage: false });
    }
    return observation;
  }

  async snapshot(): Promise<{ url: string; screenshot: Buffer; domSnapshot: string }> {
    return {
      url: this.page.url(),
      screenshot: await this.page.screenshot({ fullPage: true }),
      domSnapshot: await this.domSnapshot(),
    };
  }

  async dispose(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private async domSnapshot(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      const framePath = pathOf(frame, this.page);
      const html = await frame
        .evaluate(() => {
          const browserGlobal = globalThis as unknown as {
            document?: { documentElement?: { outerHTML?: string } };
          };
          return browserGlobal.document?.documentElement?.outerHTML ?? "";
        })
        .catch((error: unknown) =>
          error instanceof Error ? `<!-- unavailable: ${error.message} -->` : "<!-- unavailable -->",
        );
      parts.push(`<!-- frame: ${framePath.length ? framePath.join(" > ") : "(main)"} -->\n${html}`);
    }
    return parts.join("\n\n");
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function describeScope(descriptor: LocatorDescriptor): string {
  if (!descriptor.scope) return "on this screen";
  const kind = descriptor.scope.kind === "table_row" ? "table row" : "labelled group";
  return `within the ${kind} identified by ${JSON.stringify(
    descriptor.scope.name.kind === "literal" ? descriptor.scope.name.value : `{${descriptor.scope.name.param}}`,
  )}`;
}

/** Pull element[0] out of the matcher's result object as a real ElementHandle. */
async function firstElementOf(resultHandle: JSHandle): Promise<BrowserElementHandle | null> {
  const properties = await resultHandle.getProperties();
  const elements = properties.get("elements");
  if (!elements) return null;
  const items = await elements.getProperties();
  for (const item of items.values()) {
    const element = item.asElement();
    if (element) return element as BrowserElementHandle;
  }
  return null;
}

/** Frame names outermost-first, relative to the main frame. */
function pathOf(frame: Frame, page: Page): string[] {
  const path: string[] = [];
  let current: Frame | null = frame;
  while (current && current !== page.mainFrame()) {
    path.unshift(current.name());
    current = current.parentFrame();
  }
  return path;
}

/**
 * Glob over path + query. Deliberately not a regex: an artifact is a document that
 * gets reviewed, and route shapes do not need that much power.
 */
export function globMatches(url: string, pattern: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    path = url;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isTransientNavigationError(error: unknown): boolean {
  return error instanceof Error && /Execution context was destroyed|Cannot find context with specified id/.test(error.message);
}
