/**
 * Code that runs inside the page.
 *
 * Held as strings on purpose. tsx/esbuild rewrites named functions inside
 * `evaluate` callbacks to reference a `__name` helper that does not exist in the
 * browser, so any non-trivial in-page function throws `__name is not defined` at
 * runtime. A string is never transpiled.
 *
 * The cost is no type-checking on this code, so it is kept small, single-purpose,
 * and exercised end to end through the adapter's own tests. The identifiers are
 * `__cua`-prefixed because this evaluates in the page's own global scope and must
 * not collide with anything the application defines.
 *
 * Everything here is a *reimplementation of what a platform accessibility API would
 * give you*, for the cases where the browser gives nothing. That framing matters: a
 * desktop adapter would call UIA/AX for role and name and would need this same
 * fallback ladder wherever those come back empty.
 */

/**
 * Shared helpers, prepended to every script below.
 *
 * ## Role mapping
 * Small and explicit rather than a full ARIA implementation, because the target's
 * vocabulary is small and a partial-but-honest mapping beats an approximate general
 * one. Known gap: `input[type=number]` should be `spinbutton`; the target has none,
 * and guessing at roles nothing exercises would be untested code pretending to be
 * coverage.
 *
 * ## Name ladder
 * Order verified against the real target (see .agents/PHASE_2_NOTES.md):
 *   aria-label -> aria-labelledby -> label[for] -> wrapping label -> title
 *   -> native text/value -> adjacent table cell
 *
 * Native text must precede the adjacent-cell rung, or a submit button sitting in a
 * table row would take the row's label instead of its own text.
 */
const PRELUDE = String.raw`
const __cuaNormalize = (s) => String(s == null ? "" : s)
  .replace(/\s+/g, " ").trim().replace(/[:*：]+$/, "").trim().toLowerCase();

const __cuaNameMatches = (observed, expected, mode) => {
  if (mode === "exact") return observed === expected;
  const a = __cuaNormalize(observed), b = __cuaNormalize(expected);
  return mode === "contains" ? a.indexOf(b) !== -1 : a === b;
};

const __cuaText = (el) => String(el && el.textContent ? el.textContent : "")
  .replace(/\s+/g, " ").trim();

const __cuaVisible = (el) => {
  if (!el || !el.getClientRects) return false;
  if (el.getClientRects().length === 0) return false;
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.visibility !== "hidden";
};

const __cuaRole = (el) => {
  const explicit = el.getAttribute && el.getAttribute("role");
  if (explicit) return explicit.trim().toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "hidden") return null;
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    return "textbox";
  }
  if (tag === "select") return (el.multiple || el.size > 1) ? "listbox" : "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "button") return "button";
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "td") return "cell";
  if (tag === "th") return "columnheader";
  if (tag === "tr") return "row";
  if (tag === "fieldset") return "group";
  return null;
};

const __cuaName = (el) => {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return { name: aria.trim(), source: "aria-label" };

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter(Boolean).map(__cuaText).filter(Boolean);
    if (parts.length) return { name: parts.join(" "), source: "aria-labelledby" };
  }

  if (el.id) {
    const escaped = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id;
    const label = el.ownerDocument.querySelector('label[for="' + escaped + '"]');
    if (label) { const t = __cuaText(label); if (t) return { name: t, source: "label-for" }; }
  }

  const wrapping = el.closest && el.closest("label");
  if (wrapping) { const t = __cuaText(wrapping); if (t) return { name: t, source: "label-wrapping" }; }

  const title = el.getAttribute("title");
  if (title && title.trim()) return { name: title.trim(), source: "title" };

  const role = __cuaRole(el);
  if (role === "button" && el.tagName.toLowerCase() === "input") {
    const v = el.getAttribute("value");
    if (v && v.trim()) return { name: v.trim(), source: "native" };
  }
  if (role === "button" || role === "link" || role === "cell" || role === "columnheader") {
    const t = __cuaText(el);
    if (t) return { name: t, source: "native" };
  }
  if (role === "group") {
    const legend = el.querySelector("legend");
    if (legend) { const t = __cuaText(legend); if (t) return { name: t, source: "native" }; }
  }

  // The rung no platform API provides: label text in a sibling table cell, with no
  // programmatic association. This is the common case in table-laid-out legacy apps.
  const cell = el.closest && el.closest("td");
  if (cell) {
    const prev = cell.previousElementSibling;
    if (prev && prev.tagName === "TD") {
      const t = __cuaText(prev);
      if (t) return { name: t, source: "adjacent-cell" };
    }
  }

  return { name: "", source: null };
};

const __CUA_SCAN = "input,select,textarea,button,a,td,th,tr,fieldset,[role]";

const __cuaCandidates = (root, role) => {
  const out = [];
  const nodes = root.querySelectorAll(__CUA_SCAN);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (__cuaRole(el) !== role) continue;
    if (!__cuaVisible(el)) continue;
    out.push(el);
  }
  return out;
};

/*
 * Scope resolution, and the reason it exists.
 *
 * On nested-table markup every outer LAYOUT row contains every inner DATA row, so
 * "the row containing 100236" naively matches 5 rows whose union is the whole grid.
 * Measured on the real target before this was written.
 *
 * The fix: keep only candidates that contain no other candidate — the innermost
 * match. If more than one survives, the scope is genuinely ambiguous and the caller
 * must fail rather than guess.
 *
 * The two kinds match on deliberately different things. A table_row is identified by
 * what it CONTAINS (a member number). A labelled_group is identified by its LABEL —
 * matching a fieldset on full text would match every field inside it.
 */
const __cuaResolveScope = (scope) => {
  const selector = scope.kind === "table_row" ? "tr" : "fieldset";
  const all = [];
  const nodes = document.querySelectorAll(selector);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (!__cuaVisible(el)) continue;
    const haystack = scope.kind === "table_row"
      ? __cuaText(el)
      : (el.querySelector("legend") ? __cuaText(el.querySelector("legend")) : "");
    if (__cuaNameMatches(haystack, scope.name, scope.nameMatch)) all.push(el);
  }
  const innermost = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  return { matches: innermost, total: all.length };
};
`;

/**
 * Find every element matching a descriptor, innermost scope first.
 *
 * Returns an ARRAY so the caller learns the match count in one round trip: zero is a
 * miss, one is a hit, more than one is ambiguity that must fail loudly rather than
 * silently taking the first.
 *
 * `scope.name` arrives already resolved against the invocation's inputs — the page
 * never sees a ValueRef, and never sees an input value it was not given.
 */
export function matchScript(descriptor: unknown): string {
  return `(() => {
${PRELUDE}
const d = ${JSON.stringify(descriptor)};

let roots = [document];
if (d.scope) {
  const scoped = __cuaResolveScope(d.scope);
  if (scoped.matches.length !== 1) return { ambiguousScope: scoped.matches.length, scopeCandidates: scoped.total, elements: [] };
  roots = scoped.matches;
}

let found = [];
for (let r = 0; r < roots.length; r++) {
  const candidates = __cuaCandidates(roots[r], d.role);
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const computed = __cuaName(el);
    if (d.name === "") { found.push(el); continue; }
    if (__cuaNameMatches(computed.name, d.name, d.nameMatch || "normalized")) found.push(el);
  }
}

if (typeof d.ordinal === "number") {
  found = found[d.ordinal] ? [found[d.ordinal]] : [];
}

return { ambiguousScope: 0, scopeCandidates: 0, elements: found, roleCount: __cuaCandidates(roots[0] || document, d.role).length };
})()`;
}

/** Full inventory of one frame — what the discovery agent will choose from. */
export function inventoryScript(): string {
  return `(() => {
${PRELUDE}
const ROLES = ["textbox","button","link","combobox","listbox","checkbox","radio","cell","columnheader"];
const seen = new Set();
const out = [];
const nodes = document.querySelectorAll(__CUA_SCAN);
for (let i = 0; i < nodes.length; i++) {
  const el = nodes[i];
  const role = __cuaRole(el);
  if (!role || ROLES.indexOf(role) === -1) continue;
  if (!__cuaVisible(el)) continue;
  if (seen.has(el)) continue;
  seen.add(el);
  const computed = __cuaName(el);
  const rect = el.getBoundingClientRect();
  const entry = {
    role: role,
    name: computed.name,
    nameSource: computed.source,
    enabled: !el.disabled,
    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
  if (typeof el.value === "string") entry.value = el.value;
  if (typeof el.checked === "boolean") entry.checked = el.checked;
  out.push(entry);
}
return { url: location.href, title: document.title, elements: out };
})()`;
}
