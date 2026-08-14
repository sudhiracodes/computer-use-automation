/**
 * Markup helpers for MERIDIAN Core.
 *
 * Every choice here is deliberately hostile, and hostile in a *specific* way: the
 * point is not ugliness, it is to remove each of the crutches automation normally
 * leans on, so the locator strategy has to earn its results.
 *
 * | Hostile property                     | What it defeats                                    |
 * |--------------------------------------|----------------------------------------------------|
 * | No `data-testid` anywhere            | Test-id targeting. Legacy enterprise apps never have them. |
 * | `id` re-minted per render            | Any recorded CSS/id selector. Reload changes them.  |
 * | 3–4 deep layout tables               | Structural/positional selectors and XPath.          |
 * | `<font>`/`<b>` instead of `<h1>`     | Heading roles in the accessibility tree.            |
 * | Content in an iframe                 | Single-document assumptions; forces frame traversal. |
 * | Inconsistent labelling (below)       | The assumption that every control has an accessible name. |
 *
 * ## The accessible-name ladder
 *
 * The interesting hostility is the *last* row. Real legacy apps are accidentally
 * accessible in some places and not others, so a name-derivation strategy must
 * have a documented ladder of fallbacks rather than one rule. Controls in this app
 * are spread across every rung on purpose:
 *
 * | Rung | Mechanism                        | Where it appears                         |
 * |------|----------------------------------|------------------------------------------|
 * | 1    | Native text content              | All buttons and links                    |
 * | 2    | `aria-label`                     | Sub-account "Notes" textarea             |
 * | 3    | `<label for>`                    | Sub-account "Initial Deposit" field      |
 * | 4    | `title` attribute                | Sub-account "Account Type" select        |
 * | 5    | Adjacent table-cell text only    | Member ID search box; "Confirm" checkbox |
 *
 * Rung 5 controls have **no accessible name at all** — the label lives in a sibling
 * `<td>` with no programmatic association. A naive `getByRole("textbox", {name})`
 * finds nothing. Handling that is Phase 2's job, and it is the honest version of
 * the problem: if the target app labelled everything properly, the locator strategy
 * would look robust without having been tested.
 */

import { randomBytes } from "node:crypto";

/** HTML-escape. Applied to every interpolated value without exception. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Mints element ids that look like a server-side control tree and change on every
 * render.
 *
 * This is the single most useful hostile property in the app. It converts "don't
 * rely on generated ids" from advice into a property of the target: an artifact
 * that recorded `#ctl00_c3_a91f2e` as its primary locator is broken on the very
 * next request, and the failure is immediate and obvious rather than latent.
 */
export class IdMinter {
  private counter = 0;
  private readonly salt = randomBytes(3).toString("hex");

  next(prefix = "c"): string {
    this.counter += 1;
    return `ctl00_${prefix}${this.counter}_${this.salt}`;
  }
}

export interface PageOptions {
  title: string;
  body: string;
  /** Rendered before the body, outside the content table. Used for interstitials. */
  overlay?: string;
}

/**
 * Legacy page chrome.
 *
 * Note the absence of a doctype, `lang`, and any landmark element. Chromium renders
 * this in quirks mode, which is authentic for the era these apps come from and
 * incidentally makes layout-derived heuristics less reliable — as intended.
 */
export function page({ title, body, overlay }: PageOptions): string {
  return `<html>
<head>
<title>${esc(title)}</title>
<style type="text/css">
  body { background: #d4d0c8; font-family: Verdana, Geneva, sans-serif; font-size: 11px; margin: 0; }
  table { border-collapse: collapse; }
  .pane { background: #ffffff; border: 2px inset #808080; }
  .hdr { background: #000080; color: #ffffff; padding: 3px 6px; }
  .fld { border: 1px inset #808080; background: #ffffff; font-family: Verdana; font-size: 11px; }
  .btn { background: #d4d0c8; border: 2px outset #ffffff; font-family: Verdana; font-size: 11px; padding: 1px 8px; }
  .grid td { border: 1px solid #c0c0c0; padding: 2px 6px; }
  .grid th { background: #c0c0c0; border: 1px solid #808080; padding: 2px 6px; text-align: left; }
  .err { color: #a00000; }
  .modal { position: fixed; top: 90px; left: 50%; margin-left: -190px; width: 380px;
           background: #d4d0c8; border: 2px outset #ffffff; z-index: 50; }
</style>
</head>
<body bgcolor="#d4d0c8">
${overlay ?? ""}
<table border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td>
  <table border="0" cellpadding="4" cellspacing="0" width="100%"><tr><td>
    <table border="0" cellpadding="0" cellspacing="0" width="100%" class="pane"><tr><td>
${body}
    </td></tr></table>
  </td></tr></table>
</td></tr></table>
</body>
</html>`;
}

/**
 * A pseudo-heading: bold text where a modern app would use `<h1>`.
 *
 * Deliberately not a heading element, so the accessibility tree exposes no
 * `heading` role. A `labelled_group` scope cannot latch onto these — only the real
 * `<fieldset>` on the sub-account form offers that — which forces the resolver to
 * cope with both a properly grouped region and a merely bold one.
 */
export function pseudoHeading(text: string): string {
  return `<table border="0" cellpadding="3" cellspacing="0" width="100%"><tr>
    <td class="hdr"><font size="2" face="Verdana"><b>${esc(text)}</b></font></td>
  </tr></table>`;
}

/** A form row: label text in one cell, control in the next, with no association. */
export function unlabelledRow(labelText: string, controlHtml: string): string {
  return `<tr>
    <td width="150" align="right"><font size="1" face="Verdana">${esc(labelText)}</font></td>
    <td>${controlHtml}</td>
  </tr>`;
}

/** A form row whose label IS associated, via `<label for>`. */
export function labelledRow(forId: string, labelText: string, controlHtml: string): string {
  return `<tr>
    <td width="150" align="right"><label for="${esc(forId)}"><font size="1" face="Verdana">${esc(labelText)}</font></label></td>
    <td>${controlHtml}</td>
  </tr>`;
}

/** Wraps rows in the layout table used by every form in the app. */
export function formTable(rows: string): string {
  return `<table border="0" cellpadding="4" cellspacing="0">${rows}</table>`;
}

export function errorText(message: string): string {
  return `<font size="2" face="Verdana" class="err"><b>${esc(message)}</b></font>`;
}

export function noteText(message: string): string {
  return `<font size="1" face="Verdana">${esc(message)}</font>`;
}
