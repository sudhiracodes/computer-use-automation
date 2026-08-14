/**
 * MERIDIAN Core — a stand-in for a credit-union back-office application.
 *
 * A local target rather than a public demo site, for one decisive reason: the
 * runtime conditions the brief centres on (not-found, surprise dialog, app error,
 * session expiry) cannot be induced on somebody else's site. A replay that only
 * ever proves the happy path would leave requirement 3.3 undemonstrated.
 *
 * The trade-off is real and stated plainly in REPORT.md: a self-built target
 * invites "you graded your own homework." The mitigation is that this surface is
 * deliberately *harder* than the usual public demo — see render.ts for the list of
 * removed crutches and the accessible-name ladder.
 *
 * ## Layout
 *
 *   /                       login (top-level document)
 *   /console                shell: nav iframe + content iframe named "content"
 *   /console/nav            nav frame
 *   /console/search         search form, and results on POST
 *   /console/member/:id     member detail — savings balance lives here
 *   .../sub-account/new     multi-field form
 *   .../sub-account/review  review screen — nothing is created yet
 *   .../sub-account/confirm commits, shows the new sub-account number
 *   /admin                  fault control surface — DENIED to the agent by allowlist
 *
 * Everything under /console renders inside the named "content" frame, so every
 * recorded locator carries framePath ["content"]. Cross-frame traversal is
 * therefore exercised by the ordinary happy path rather than by a special case.
 *
 * `<iframe>` rather than `<frameset>`: framesets were removed from the HTML
 * standard, and I did not want the target's realism to rest on a deprecated
 * rendering path that a future Chromium may drop. The automation problem —
 * traversing into a frame whose document re-navigates under you — is identical.
 */

import { pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import {
  ABSENT_MEMBER_ID,
  MEMBERS,
  SUB_ACCOUNT_PURPOSES,
  SUB_ACCOUNT_TYPES,
  findMember,
  formatCurrency,
  nextSubAccountNumber,
  type Member,
} from "./data.js";
import {
  FAULT_KINDS,
  armFault,
  consumeFault,
  disarmAll,
  disarmFault,
  isFaultKind,
  listArmed,
} from "./faults.js";
import {
  IdMinter,
  errorText,
  esc,
  formTable,
  labelledRow,
  noteText,
  page,
  pseudoHeading,
  unlabelledRow,
} from "./render.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSession,
  sessionTtlSeconds,
} from "./session.js";

/**
 * Exported so tests can boot the app on an ephemeral port.
 *
 * The hostile properties this app is built to have — no test ids, ids that change per
 * render, no heading roles, controls with no accessible name — are load-bearing for
 * the whole locator strategy. A later well-meaning edit that "tidied up" the markup
 * would quietly make the target easy and invalidate every result measured against it,
 * so tests/target-app.test.ts asserts them against served HTML.
 */
export const app = express();
app.disable("x-powered-by");
// `extended: false` — these are flat legacy forms; nested bracket syntax would be
// anachronistic for the app being imitated.
app.use(express.urlencoded({ extended: false }));

const OPERATOR_USER = process.env.TARGET_APP_USER ?? "teller01";
const OPERATOR_PASSWORD = process.env.TARGET_APP_PASSWORD ?? "change-me-locally";

/* ------------------------------------------------------------------ *
 * Login (top-level document — the only screen outside the frameset)
 * ------------------------------------------------------------------ */

app.get("/", (req, res) => {
  if (getSession(req)) return res.redirect(302, "/console");
  return res.send(loginScreen());
});

function loginScreen(message?: string): string {
  const ids = new IdMinter();
  const userId = ids.next("u");
  const passId = ids.next("p");

  return page({
    title: "MERIDIAN Core — Sign On",
    body: `
${pseudoHeading("MERIDIAN Core — Operator Sign On")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  ${message ? `${errorText(message)}<br><br>` : ""}
  <form method="post" action="/login">
    ${formTable(
      // Rung 3 of the name ladder: both login fields ARE properly labelled.
      // Legacy apps are usually accessible on the sign-on screen and nowhere else —
      // it is the one page that gets audited.
      labelledRow(userId, "Operator ID", `<input type="text" name="user" id="${userId}" class="fld" size="24">`) +
        labelledRow(passId, "Password", `<input type="password" name="password" id="${passId}" class="fld" size="24">`) +
        `<tr><td></td><td><input type="submit" class="btn" value="Sign On"></td></tr>`,
    )}
  </form>
  <br>
  ${noteText(`Synthetic training environment. Session idle timeout: ${sessionTtlSeconds()}s.`)}
</td></tr></table>`,
  });
}

app.post("/login", (req, res) => {
  const user = String(req.body.user ?? "");
  const password = String(req.body.password ?? "");

  if (user !== OPERATOR_USER || password !== OPERATOR_PASSWORD) {
    // Same message for a wrong user and a wrong password — no enumeration, even in
    // a mock. Modelling an app worse than it needs to be teaches the wrong lesson.
    return res.status(401).send(loginScreen("Sign-on failed. Check your Operator ID and password."));
  }

  createSession(res, user);
  return res.redirect(302, "/console");
});

app.get("/logout", (req, res) => {
  destroySession(req);
  clearSessionCookie(res);
  return res.redirect(302, "/");
});

/* ------------------------------------------------------------------ *
 * Console shell + nav frame
 * ------------------------------------------------------------------ */

app.get("/console", (req, res) => {
  if (!getSession(req)) return res.redirect(302, "/");

  return res.send(`<html>
<head><title>MERIDIAN Core</title>
<style type="text/css">
  body { margin: 0; background: #d4d0c8; font-family: Verdana; font-size: 11px; }
  iframe { border: 0; }
</style></head>
<body>
<table border="0" cellpadding="0" cellspacing="0" width="100%" height="100%"><tr>
  <td width="170" valign="top">
    <iframe name="sidebar" src="/console/nav" width="170" height="620" scrolling="no"></iframe>
  </td>
  <td valign="top">
    <iframe name="content" src="/console/search" width="820" height="620"></iframe>
  </td>
</tr></table>
</body></html>`);
});

app.get("/console/nav", (req, res) => {
  if (!getSession(req)) return res.send(expiredFrame());

  return res.send(
    page({
      title: "Navigation",
      body: `
${pseudoHeading("Functions")}
<table border="0" cellpadding="6" cellspacing="0"><tr><td>
  <font size="1" face="Verdana">
    <!-- target="content" is why the nav frame can re-navigate the content frame
         out from under an automation run. framePath is not decoration. -->
    <a href="/console/search" target="content">Member Search</a><br><br>
    <a href="/logout" target="_top">Sign Out</a>
  </font>
</td></tr></table>`,
    }),
  );
});

/* ------------------------------------------------------------------ *
 * Session-expiry guard for content-frame routes
 * ------------------------------------------------------------------ */

/**
 * Rendered *inside* the content frame when the session is gone.
 *
 * Deliberately in-frame: the outer shell still looks signed in, so the automation
 * sees a logged-in chrome wrapped around an expired pane. That is exactly how this
 * fails in the real world, and it is meaningfully harder than a top-level redirect —
 * a naive `url_matches` checkpoint on the outer document would not notice at all.
 */
function expiredFrame(): string {
  return page({
    title: "Session Expired",
    body: `
${pseudoHeading("Session Expired")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  ${errorText("Your session has timed out due to inactivity.")}
  <br><br>
  ${noteText("Sign on again to continue. Unsaved work has been discarded.")}
  <br><br>
  <font size="1" face="Verdana"><a href="/" target="_top">Return to Sign On</a></font>
</td></tr></table>`,
  });
}

/** Guard for every content-frame route. Returns true when the request may proceed. */
function requireSession(req: Request, res: Response): boolean {
  if (consumeFault("session_expired", req.query._fault)) {
    destroySession(req);
    res.send(expiredFrame());
    return false;
  }
  if (!getSession(req)) {
    res.send(expiredFrame());
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Member search
 * ------------------------------------------------------------------ */

app.get("/console/search", (req, res) => {
  if (!requireSession(req, res)) return;
  return res.send(searchScreen());
});

function searchScreen(options: { results?: Member[]; query?: string; notFound?: boolean } = {}): string {
  const ids = new IdMinter();
  const searchInputId = ids.next("s");

  let resultsHtml = "";
  if (options.notFound) {
    resultsHtml = `
<br>
${pseudoHeading("Search Results")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  ${errorText("No member found matching that ID.")}
  <br><br>
  ${noteText("Check the member number and try again.")}
</td></tr></table>`;
  } else if (options.results && options.results.length > 0) {
    const rows = options.results
      .map(
        (m) => `<tr>
          <td><font size="1" face="Verdana">${esc(m.memberId)}</font></td>
          <td><font size="1" face="Verdana">${esc(m.fullName)}</font></td>
          <td><font size="1" face="Verdana">${esc(m.branch)}</font></td>
          <td><font size="1" face="Verdana">${esc(m.status)}</font></td>
          <td><font size="1" face="Verdana"><a href="/console/member/${esc(m.memberId)}">View</a></font></td>
        </tr>`,
      )
      .join("");

    // Every row's action link is named "View". With more than one result the name
    // alone is ambiguous, which is the single most common targeting failure on
    // legacy grids — and the reason LocatorScope.table_row exists.
    resultsHtml = `
<br>
${pseudoHeading("Search Results")}
<table border="0" cellpadding="6" cellspacing="0"><tr><td>
  <table class="grid" border="1" cellpadding="2" cellspacing="0">
    <tr><th>Member #</th><th>Name</th><th>Branch</th><th>Status</th><th>Action</th></tr>
    ${rows}
  </table>
  <br>
  ${noteText(`${options.results.length} record(s) returned.`)}
</td></tr></table>`;
  }

  return page({
    title: "Member Search",
    body: `
${pseudoHeading("Member Search")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  <form method="post" action="/console/search">
    ${formTable(
      // RUNG 5 — the hard case. The label "Member ID" sits in a sibling <td> with
      // no `for`, no aria-label, no title, no placeholder. This input has NO
      // accessible name; getByRole("textbox", { name: "Member ID" }) finds nothing.
      // Deriving the name from proximate cell text is Phase 2's problem, and this
      // is where it gets proven.
      unlabelledRow(
        "Member ID",
        `<input type="text" name="memberId" id="${searchInputId}" class="fld" size="20" value="${esc(options.query ?? "")}">`,
      ) + `<tr><td></td><td><input type="submit" class="btn" value="Search"></td></tr>`,
    )}
  </form>
  ${noteText("Enter a full member number, or a prefix to list matches.")}
</td></tr></table>
${resultsHtml}`,
  });
}

app.post("/console/search", (req, res) => {
  if (!requireSession(req, res)) return;

  const query = String(req.body.memberId ?? "").trim();

  // The not_found fault forces the empty result even for a member that exists.
  // Searching for ABSENT_MEMBER_ID reaches the same screen with no fault armed —
  // the business outcome is provable on the ordinary path.
  if (consumeFault("not_found", req.query._fault)) {
    return res.send(searchScreen({ query, notFound: true }));
  }

  if (!query) {
    return res.send(searchScreen({ query, notFound: true }));
  }

  const results = MEMBERS.filter((m) => m.memberId.startsWith(query));
  if (results.length === 0) {
    return res.send(searchScreen({ query, notFound: true }));
  }
  return res.send(searchScreen({ query, results: [...results] }));
});

/* ------------------------------------------------------------------ *
 * Member detail
 * ------------------------------------------------------------------ */

app.get("/console/member/:memberId", (req, res) => {
  if (!requireSession(req, res)) return;

  const memberId = String(req.params.memberId);

  if (consumeFault("app_error", req.query._fault)) {
    return res.status(500).send(appErrorFrame("MBR-0500", "Unhandled exception in MemberInquiry.aspx"));
  }

  const member = findMember(memberId);
  if (!member) {
    return res.status(404).send(
      page({
        title: "Member Not Found",
        body: `${pseudoHeading("Member Inquiry")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  ${errorText("No member found matching that ID.")}
  <br><br><font size="1" face="Verdana"><a href="/console/search">Back to Member Search</a></font>
</td></tr></table>`,
      }),
    );
  }

  // The interstitial is dismissed by navigating back with ?dismissed=1, which is how
  // these server-rendered notices actually work — there is no client-side state to
  // toggle. A declared recovery clicks OK and the run continues.
  const showDialog =
    req.query.dismissed !== "1" && consumeFault("unexpected_dialog", req.query._fault);

  return res.send(memberDetailScreen(member, showDialog));
});

function memberDetailScreen(member: Member, showDialog: boolean): string {
  const ids = new IdMinter();
  const savings = member.accounts.find((a) => a.kind === "Savings");
  const checking = member.accounts.find((a) => a.kind === "Checking");

  const accountRows = member.accounts
    .map(
      (a) => `<tr>
        <td><font size="1" face="Verdana">${esc(a.accountNumber)}</font></td>
        <td><font size="1" face="Verdana">${esc(a.kind)}</font></td>
        <td align="right"><font size="1" face="Verdana">${esc(formatCurrency(a.balanceCents))}</font></td>
      </tr>`,
    )
    .join("");

  const overlay = showDialog
    ? `<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:#000;opacity:0.35;z-index:40;"></div>
<div class="modal">
  <table border="0" cellpadding="6" cellspacing="0" width="100%">
    <tr><td class="hdr"><font size="1" face="Verdana"><b>System Notice</b></font></td></tr>
    <tr><td><font size="1" face="Verdana">
      Scheduled maintenance window begins at 23:00. Save work in progress.
    </font></td></tr>
    <tr><td align="right">
      <!-- The scrim above genuinely covers the page, so an automation that ignores
           this dialog fails its next click rather than silently mis-clicking. That
           is the behaviour worth testing: a recoverable condition must be *noticed*. -->
      <a href="/console/member/${esc(member.memberId)}?dismissed=1"><input type="button" class="btn" value="OK"></a>
    </td></tr>
  </table>
</div>`
    : "";

  return page({
    title: `Member ${member.memberId}`,
    overlay,
    body: `
${pseudoHeading(`Member Inquiry — ${member.memberId}`)}
<table border="0" cellpadding="8" cellspacing="0" width="100%"><tr><td>

  <fieldset>
    <legend><font size="1" face="Verdana"><b>Member Details</b></font></legend>
    ${formTable(
      unlabelledRow("Member Name", `<font size="2" face="Verdana"><b>${esc(member.fullName)}</b></font>`) +
        unlabelledRow("Branch", `<font size="1" face="Verdana">${esc(member.branch)}</font>`) +
        unlabelledRow("Member Since", `<font size="1" face="Verdana">${esc(member.memberSince)}</font>`) +
        unlabelledRow("Status", `<font size="1" face="Verdana">${esc(member.status)}</font>`),
    )}
  </fieldset>

  <br>

  <!-- fieldset/legend gives LocatorScope kind "labelled_group" something real to
       latch onto. Only three blocks in the app do this (two here, one on the
       sub-account form); every other section heading is bold text with no group
       semantics at all, which is the harder case the resolver must also handle. -->
  <fieldset>
    <legend><font size="1" face="Verdana"><b>Balance Summary</b></font></legend>
    ${formTable(
      // RUNG 5 again, and the extraction target for the savings balance.
      // A readonly text input displaying a value is a pervasive legacy pattern: it
      // has role "textbox" and no accessible name, so it is reachable only by
      // deriving the name from the adjacent cell. Extracted via `field_value`.
      unlabelledRow(
        "Savings Balance",
        `<input type="text" readonly class="fld" size="16" id="${ids.next("bal")}" value="${esc(
          savings ? formatCurrency(savings.balanceCents) : "$0.00",
        )}">`,
      ) +
        unlabelledRow(
          "Checking Balance",
          `<input type="text" readonly class="fld" size="16" id="${ids.next("bal")}" value="${esc(
            checking ? formatCurrency(checking.balanceCents) : "$0.00",
          )}">`,
        ),
    )}
  </fieldset>

  <br>
  ${pseudoHeading("Accounts")}
  <table class="grid" border="1" cellpadding="2" cellspacing="0">
    <tr><th>Account</th><th>Type</th><th>Balance</th></tr>
    ${accountRows}
  </table>

  <br>
  <form method="get" action="/console/member/${esc(member.memberId)}/sub-account/new">
    <input type="submit" class="btn" value="Open Sub-Account">
  </form>

</td></tr></table>`,
  });
}

function appErrorFrame(code: string, detail: string): string {
  return page({
    title: "Application Error",
    body: `
${pseudoHeading("Application Error")}
<table border="0" cellpadding="10" cellspacing="0"><tr><td>
  ${errorText(`Error ${esc(code)}`)}
  <br><br>
  <font size="1" face="Verdana">${esc(detail)}</font>
  <br><br>
  ${noteText("Contact the service desk with the error code above.")}
</td></tr></table>`,
  });
}

/* ------------------------------------------------------------------ *
 * Sub-account: form -> review -> commit
 * ------------------------------------------------------------------ */

app.get("/console/member/:memberId/sub-account/new", (req, res) => {
  if (!requireSession(req, res)) return;
  const member = findMember(String(req.params.memberId));
  if (!member) return res.status(404).send(appErrorFrame("MBR-0404", "Member not found."));
  return res.send(subAccountFormScreen(member));
});

function subAccountFormScreen(member: Member, message?: string): string {
  const ids = new IdMinter();
  const depositId = ids.next("dep");

  const typeOptions = SUB_ACCOUNT_TYPES.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const purposeOptions = SUB_ACCOUNT_PURPOSES.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");

  return page({
    title: "Open Sub-Account",
    body: `
${pseudoHeading(`Open Sub-Account — Member ${member.memberId}`)}
<table border="0" cellpadding="8" cellspacing="0"><tr><td>
  ${message ? `${errorText(message)}<br><br>` : ""}
  <form method="post" action="/console/member/${esc(member.memberId)}/sub-account/review">
  <fieldset>
    <legend><font size="1" face="Verdana"><b>New Sub-Account</b></font></legend>
    ${formTable(
      // RUNG 4 — `title` is the only naming mechanism. Accessible almost by accident,
      // which is how legacy apps usually get there.
      unlabelledRow(
        "Account Type",
        `<select name="accountType" title="Account Type" class="fld">${typeOptions}</select>`,
      ) +
        // RUNG 3 — properly associated `<label for>`. One field in the form does this
        // correctly, which is realistic: whoever fixed one never fixed the rest.
        labelledRow(
          depositId,
          "Initial Deposit",
          `<input type="text" name="initialDeposit" id="${depositId}" class="fld" size="12" value="0.00">`,
        ) +
        // RUNG 5 — adjacent cell only.
        unlabelledRow("Purpose", `<select name="purpose" class="fld">${purposeOptions}</select>`) +
        // RUNG 2 — aria-label present.
        unlabelledRow(
          "Notes",
          `<textarea name="notes" aria-label="Notes" class="fld" rows="3" cols="30"></textarea>`,
        ) +
        // RUNG 5 — an unnamed checkbox. Consent controls being unlabelled is
        // depressingly true to life.
        unlabelledRow(
          "Disclosure",
          `<input type="checkbox" name="disclosure" value="yes"> <font size="1" face="Verdana">Member acknowledged account disclosure</font>`,
        ) +
        `<tr><td></td><td><input type="submit" class="btn" value="Continue"></td></tr>`,
    )}
  </fieldset>
  </form>
  <br>
  <font size="1" face="Verdana"><a href="/console/member/${esc(member.memberId)}">Back to Member Inquiry</a></font>
</td></tr></table>`,
  });
}

/**
 * Review screen. Nothing has been created at this point.
 *
 * The split between review and commit is what gives the safety model something real
 * to gate: reaching this screen is reversible, and the button on it is not. Without
 * the split, "irreversible action" would have no honest example in the flow and the
 * risk classification would be decoration.
 */
app.post("/console/member/:memberId/sub-account/review", (req, res) => {
  if (!requireSession(req, res)) return;

  const member = findMember(String(req.params.memberId));
  if (!member) return res.status(404).send(appErrorFrame("MBR-0404", "Member not found."));

  const accountType = String(req.body.accountType ?? "");
  const initialDeposit = String(req.body.initialDeposit ?? "").trim();
  const purpose = String(req.body.purpose ?? "");
  const notes = String(req.body.notes ?? "");
  const disclosure = req.body.disclosure === "yes";

  if (!disclosure) {
    return res.send(
      subAccountFormScreen(member, "Account disclosure must be acknowledged before continuing."),
    );
  }
  if (!/^\d+(\.\d{1,2})?$/.test(initialDeposit)) {
    return res.send(subAccountFormScreen(member, "Initial Deposit must be a dollar amount, e.g. 25.00"));
  }

  return res.send(
    page({
      title: "Review Sub-Account",
      body: `
${pseudoHeading("Review — Confirm New Sub-Account")}
<table border="0" cellpadding="8" cellspacing="0"><tr><td>
  ${noteText("Nothing has been created yet. Review the details, then confirm.")}
  <br><br>
  <table class="grid" border="1" cellpadding="3" cellspacing="0">
    <tr><th>Field</th><th>Value</th></tr>
    <tr><td><font size="1" face="Verdana">Member #</font></td><td><font size="1" face="Verdana">${esc(member.memberId)}</font></td></tr>
    <tr><td><font size="1" face="Verdana">Account Type</font></td><td><font size="1" face="Verdana">${esc(accountType)}</font></td></tr>
    <tr><td><font size="1" face="Verdana">Initial Deposit</font></td><td><font size="1" face="Verdana">${esc(initialDeposit)}</font></td></tr>
    <tr><td><font size="1" face="Verdana">Purpose</font></td><td><font size="1" face="Verdana">${esc(purpose)}</font></td></tr>
  </table>
  <br>
  <form method="post" action="/console/member/${esc(member.memberId)}/sub-account/confirm">
    <input type="hidden" name="accountType" value="${esc(accountType)}">
    <input type="hidden" name="initialDeposit" value="${esc(initialDeposit)}">
    <input type="hidden" name="purpose" value="${esc(purpose)}">
    <input type="hidden" name="notes" value="${esc(notes)}">
    <input type="submit" class="btn" value="Confirm and Open Account">
  </form>
</td></tr></table>`,
    }),
  );
});

app.post("/console/member/:memberId/sub-account/confirm", (req, res) => {
  if (!requireSession(req, res)) return;

  const member = findMember(String(req.params.memberId));
  if (!member) return res.status(404).send(appErrorFrame("MBR-0404", "Member not found."));

  if (consumeFault("app_error", req.query._fault)) {
    return res.status(500).send(appErrorFrame("SUB-0500", "Posting failed in AccountOpen.aspx"));
  }

  const accountNumber = nextSubAccountNumber(member.memberId);
  const accountType = String(req.body.accountType ?? "");

  return res.send(
    page({
      title: "Sub-Account Opened",
      body: `
${pseudoHeading("Sub-Account Opened")}
<table border="0" cellpadding="8" cellspacing="0"><tr><td>
  <font size="2" face="Verdana"><b>Sub-Account Opened</b></font>
  <br><br>
  <!-- The new account number is extracted via text_content from the cell in the
       row labelled "New Sub-Account Number". The savings balance on the detail
       screen is extracted via field_value instead, so both extraction modes in
       the schema are exercised by one flow rather than one being untested. -->
  <table class="grid" border="1" cellpadding="3" cellspacing="0">
    <tr><th>Field</th><th>Value</th></tr>
    <tr>
      <td><font size="1" face="Verdana">New Sub-Account Number</font></td>
      <td><font size="1" face="Verdana">${esc(accountNumber)}</font></td>
    </tr>
    <tr>
      <td><font size="1" face="Verdana">Account Type</font></td>
      <td><font size="1" face="Verdana">${esc(accountType)}</font></td>
    </tr>
    <tr>
      <td><font size="1" face="Verdana">Member #</font></td>
      <td><font size="1" face="Verdana">${esc(member.memberId)}</font></td>
    </tr>
  </table>
  <br>
  ${noteText("The account number is assigned by the core and differs on every open.")}
  <br><br>
  <font size="1" face="Verdana"><a href="/console/member/${esc(member.memberId)}">Back to Member Inquiry</a></font>
</td></tr></table>`,
    }),
  );
});

/* ------------------------------------------------------------------ *
 * /admin — fault control surface. DENIED to the agent by config/allowlist.json.
 * ------------------------------------------------------------------ */

app.get("/admin", (_req, res) => {
  const rows = FAULT_KINDS.map((kind) => {
    const armed = listArmed().find((f) => f.kind === kind);
    return `<tr>
      <td><font size="1" face="Verdana"><b>${esc(kind)}</b></font></td>
      <td><font size="1" face="Verdana">${armed ? `ARMED (${esc(armed.mode)})` : "—"}</font></td>
      <td>
        <form method="post" action="/admin/fault" style="display:inline">
          <input type="hidden" name="kind" value="${esc(kind)}">
          <input type="hidden" name="mode" value="once">
          <input type="submit" class="btn" value="Arm once">
        </form>
        <form method="post" action="/admin/fault" style="display:inline">
          <input type="hidden" name="kind" value="${esc(kind)}">
          <input type="hidden" name="mode" value="persistent">
          <input type="submit" class="btn" value="Arm persistent">
        </form>
        <form method="post" action="/admin/fault" style="display:inline">
          <input type="hidden" name="kind" value="${esc(kind)}">
          <input type="hidden" name="disarm" value="1">
          <input type="submit" class="btn" value="Disarm">
        </form>
      </td>
    </tr>`;
  }).join("");

  res.send(
    page({
      title: "MERIDIAN Core — Fault Injection",
      body: `
${pseudoHeading("Fault Injection (operator only)")}
<table border="0" cellpadding="8" cellspacing="0"><tr><td>
  ${noteText(
    "This surface exists so the four runtime conditions in the replay result contract can be induced on demand. It is denied to the agent in config/allowlist.json: an agent able to reach it could disarm the conditions the safety model exists to handle.",
  )}
  <br><br>
  <table class="grid" border="1" cellpadding="3" cellspacing="0">
    <tr><th>Fault</th><th>State</th><th>Control</th></tr>
    ${rows}
  </table>
  <br>
  <form method="post" action="/admin/fault"><input type="hidden" name="disarmAll" value="1">
    <input type="submit" class="btn" value="Disarm all"></form>
  <br>
  ${noteText(
    `Per-request alternative, no state to reset: append ?_fault=<kind> to a console URL. Absent member for a natural not-found: ${ABSENT_MEMBER_ID}`,
  )}
</td></tr></table>`,
    }),
  );
});

app.post("/admin/fault", (req, res) => {
  if (req.body.disarmAll === "1") {
    disarmAll();
    return res.redirect(302, "/admin");
  }

  const kind = req.body.kind;
  if (!isFaultKind(kind)) return res.status(400).send("unknown fault kind");

  if (req.body.disarm === "1") {
    disarmFault(kind);
  } else {
    armFault(kind, req.body.mode === "persistent" ? "persistent" : "once");
  }
  return res.redirect(302, "/admin");
});

/* ------------------------------------------------------------------ */

/**
 * Listen only when run as a program, not when imported.
 *
 * Without this guard, importing the app in a test would bind port 3000 as a side
 * effect of the import — which fails outright if a dev server is already running.
 */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const port = Number(process.env.TARGET_APP_PORT ?? 3000);
  app.listen(port, () => {
    console.log(`MERIDIAN Core (mock)   http://localhost:${port}`);
    console.log(`Fault injection        http://localhost:${port}/admin`);
    console.log(`Operator               ${OPERATOR_USER} / ${OPERATOR_PASSWORD}`);
    console.log(`Session idle timeout   ${sessionTtlSeconds()}s`);
    console.log("");
    console.log("All data is synthetic. No real credentials or PII.");
  });
}
