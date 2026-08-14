/**
 * Target-application tests.
 *
 * Two jobs, and the second is the important one.
 *
 * 1. The flow works and every fault reaches its screen — otherwise later phases have
 *    nothing to replay against.
 *
 * 2. **The hostile properties stay hostile.** This app is only useful as evidence if
 *    it withholds the crutches automation normally leans on. A later edit that
 *    "tidied up" the markup — added a test id, stabilised an id, used a real heading,
 *    labelled the search box — would silently make the target easy and invalidate
 *    every result measured against it. These assertions run against *served HTML*,
 *    not source, so a comment claiming a property cannot satisfy them.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../target-app/server.js";

let server: Server;
let base: string;

/** Cookie jar just rich enough for these tests. */
class Jar {
  private cookie = "";

  capture(response: Response): void {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
  }

  headers(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }
}

async function get(path: string, jar?: Jar): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${path}`, {
    headers: jar ? jar.headers() : {},
    redirect: "manual",
  });
  jar?.capture(response);
  return { status: response.status, body: await response.text() };
}

async function post(
  path: string,
  form: Record<string, string>,
  jar?: Jar,
): Promise<{ status: number; body: string; location: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...(jar ? jar.headers() : {}), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
  jar?.capture(response);
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get("location"),
  };
}

async function signedIn(): Promise<Jar> {
  const jar = new Jar();
  const result = await post(
    "/login",
    { user: process.env.TARGET_APP_USER ?? "teller01", password: process.env.TARGET_APP_PASSWORD ?? "change-me-locally" },
    jar,
  );
  expect(result.location).toBe("/console");
  return jar;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    // Port 0 — the OS picks a free port, so tests never collide with a dev server.
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the flow", () => {
  it("rejects a wrong password without revealing which field was wrong", async () => {
    const result = await post("/login", { user: "teller01", password: "wrong" });
    expect(result.status).toBe(401);
    expect(result.body).toContain("Check your Operator ID and password");
  });

  it("signs on and serves a console with a content frame", async () => {
    const jar = await signedIn();
    const { body } = await get("/console", jar);
    expect(body).toContain('iframe name="content"');
    expect(body).toContain('iframe name="sidebar"');
  });

  it("walks search -> detail -> form -> review -> commit", async () => {
    const jar = await signedIn();

    const search = await post("/console/search", { memberId: "100234" }, jar);
    expect(search.body).toContain("1 record(s) returned");

    const detail = await get("/console/member/100234", jar);
    expect(detail.body).toContain("Dana Whitfield");
    expect(detail.body).toContain("$1,284.36");

    const form = await get("/console/member/100234/sub-account/new", jar);
    expect(form.body).toContain('title="Account Type"');

    const review = await post(
      "/console/member/100234/sub-account/review",
      { accountType: "Holiday Club", initialDeposit: "25.00", purpose: "Personal", notes: "", disclosure: "yes" },
      jar,
    );
    expect(review.body).toContain("Nothing has been created yet");
    expect(review.body).toContain("Confirm and Open Account");

    const confirm = await post(
      "/console/member/100234/sub-account/confirm",
      { accountType: "Holiday Club", initialDeposit: "25.00", purpose: "Personal", notes: "" },
      jar,
    );
    expect(confirm.body).toContain("Sub-Account Opened");
    expect(confirm.body).toMatch(/SV-100234-\d+/);
  });

  it("blocks review when the disclosure is not acknowledged", async () => {
    const jar = await signedIn();
    const result = await post(
      "/console/member/100234/sub-account/review",
      { accountType: "Holiday Club", initialDeposit: "25.00", purpose: "Personal", notes: "" },
      jar,
    );
    expect(result.body).toContain("Account disclosure must be acknowledged");
  });

  it("rejects a malformed deposit amount", async () => {
    const jar = await signedIn();
    const result = await post(
      "/console/member/100234/sub-account/review",
      { accountType: "Holiday Club", initialDeposit: "twenty", purpose: "Personal", notes: "", disclosure: "yes" },
      jar,
    );
    expect(result.body).toContain("Initial Deposit must be a dollar amount");
  });
});

describe("runtime conditions", () => {
  it("reaches MEMBER_NOT_FOUND naturally, with no fault armed", async () => {
    // The outcome a caller most needs to handle correctly must be provable on the
    // ordinary code path — not only under a test hook a reviewer could call staged.
    const jar = await signedIn();
    const result = await post("/console/search", { memberId: "999999" }, jar);
    expect(result.body).toContain("No member found matching that ID");
  });

  it("forces not_found on a member that does exist", async () => {
    const jar = await signedIn();
    const result = await post("/console/search?_fault=not_found", { memberId: "100234" }, jar);
    expect(result.body).toContain("No member found matching that ID");
  });

  it("interposes a modal notice that genuinely covers the page", async () => {
    const jar = await signedIn();
    const { body } = await get("/console/member/100234?_fault=unexpected_dialog", jar);
    expect(body).toContain("System Notice");
    expect(body).toContain('value="OK"');
    // The scrim is what makes this a *recoverable condition* rather than cosmetic:
    // an automation that ignores the dialog fails its next click instead of
    // silently mis-clicking through it.
    expect(body).toMatch(/z-index:\s*40/);
  });

  it("dismissing the notice returns a clean screen", async () => {
    const jar = await signedIn();
    const { body } = await get("/console/member/100234?dismissed=1", jar);
    expect(body).not.toContain("System Notice");
    expect(body).toContain("Dana Whitfield");
  });

  it("returns a 500 with a debuggable code on app_error", async () => {
    const jar = await signedIn();
    const result = await get("/console/member/100234?_fault=app_error", jar);
    expect(result.status).toBe(500);
    expect(result.body).toContain("MBR-0500");
  });

  it("expires the session in-frame, and really destroys it", async () => {
    const jar = await signedIn();

    const expired = await get("/console/member/100234?_fault=session_expired", jar);
    // 200, not a redirect: the notice renders *inside* the content frame while the
    // outer shell still looks signed in. A checkpoint watching the top-level URL
    // would not notice, which is what makes this the realistic hard case.
    expect(expired.status).toBe(200);
    expect(expired.body).toContain("Your session has timed out");

    const after = await get("/console/member/100234", jar);
    expect(after.body).toContain("Session Expired");
  });

  it("consumes a once-armed fault exactly once", async () => {
    const jar = await signedIn();
    await post("/admin/fault", { kind: "not_found", mode: "once" });

    const first = await post("/console/search", { memberId: "100234" }, jar);
    expect(first.body).toContain("No member found");

    const second = await post("/console/search", { memberId: "100234" }, jar);
    expect(second.body).toContain("1 record(s) returned");
  });

  it("keeps a persistently-armed fault armed, so bounded recovery can be tested", async () => {
    const jar = await signedIn();
    await post("/admin/fault", { kind: "not_found", mode: "persistent" });
    for (let i = 0; i < 3; i += 1) {
      const result = await post("/console/search", { memberId: "100234" }, jar);
      expect(result.body).toContain("No member found");
    }
    await post("/admin/fault", { disarmAll: "1" });
    const restored = await post("/console/search", { memberId: "100234" }, jar);
    expect(restored.body).toContain("1 record(s) returned");
  });
});

describe("hostile properties (regression guards — do not 'fix' the target)", () => {
  const SCREENS = [
    "/console/search",
    "/console/member/100234",
    "/console/member/100234/sub-account/new",
  ];

  it("serves no test ids on any screen", async () => {
    const jar = await signedIn();
    for (const path of SCREENS) {
      const { body } = await get(path, jar);
      expect(body, `${path} leaked a test id`).not.toMatch(/data-(testid|test|cy|qa)\b/);
    }
  });

  it("serves no heading elements, so the a11y tree exposes no heading roles", async () => {
    const jar = await signedIn();
    for (const path of SCREENS) {
      const { body } = await get(path, jar);
      expect(body, `${path} used a real heading`).not.toMatch(/<h[1-6][\s>]/i);
    }
  });

  it("re-mints element ids on every render", async () => {
    // The single most useful hostile property: it converts "don't record generated
    // ids" from advice into a fact about the target.
    const jar = await signedIn();
    const extract = (body: string): string[] => [...body.matchAll(/id="(ctl00_[^"]+)"/g)].map((m) => m[1]!);

    const first = extract((await get("/console/member/100234", jar)).body);
    const second = extract((await get("/console/member/100234", jar)).body);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    expect(second).not.toEqual(first);
  });

  it("leaves the member-search box with no accessible name", async () => {
    // Rung 5 of the name ladder. If this input ever gains a label/aria-label/title,
    // the hardest case the resolver must handle disappears from the target.
    const jar = await signedIn();
    const { body } = await get("/console/search", jar);

    const input = body.match(/<input type="text" name="memberId"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).not.toMatch(/aria-label|title=|placeholder=/);
    expect(body).not.toMatch(/<label[^>]*>\s*<font[^>]*>Member ID/);
  });

  it("keeps every rung of the accessible-name ladder represented", async () => {
    const jar = await signedIn();
    const { body } = await get("/console/member/100234/sub-account/new", jar);
    expect(body, "rung 4: title").toContain('title="Account Type"');
    expect(body, "rung 3: label for").toMatch(/<label for="ctl00_dep\d+_[a-f0-9]+">/);
    expect(body, "rung 2: aria-label").toContain('aria-label="Notes"');
    expect(body, "rung 5: unnamed select").toMatch(/<select name="purpose" class="fld">/);
    expect(body, "rung 5: unnamed checkbox").toMatch(/<input type="checkbox" name="disclosure"[^>]*>/);
    expect(body, "rung 1: native button text").toContain('value="Continue"');
  });

  it("nests layout tables deeply enough to defeat structural selectors", async () => {
    const jar = await signedIn();
    const { body } = await get("/console/member/100234", jar);
    expect((body.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
