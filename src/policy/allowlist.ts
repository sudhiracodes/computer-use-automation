import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Action, ValueRef } from "../artifact/locator.js";
import { resolveValueRef } from "../artifact/locator.js";
import type { Sensitivity, Step } from "../artifact/schema.js";

const AllowlistConfig = z.object({
  version: z.literal(1),
  origins: z.array(z.string().url()).min(1),
  routePatterns: z.array(z.string().min(1)).min(1),
  deniedRoutePatterns: z.array(z.string().min(1)).default([]),
  actionTypes: z.array(z.string().min(1)).min(1),
});

export type AllowlistConfig = z.infer<typeof AllowlistConfig>;
export type PolicyRisk = Step["risk"];

export type PolicyDecision =
  | { status: "allowed"; risk: PolicyRisk }
  | { status: "denied"; code: "POLICY_DENIED"; reason: string; risk: PolicyRisk }
  | { status: "requires_intervention"; code: "APPROVAL_REQUIRED"; reason: string; risk: "irreversible" };

export interface PolicyContext {
  allowlist: AllowlistConfig;
  inputSensitivity: Readonly<Record<string, Sensitivity>>;
  approvalToken?: string | undefined;
}

export interface ActionPolicyContext {
  action: Action;
  inputs: Readonly<Record<string, string>>;
  currentUrl?: string | undefined;
  declaredRisk?: PolicyRisk | undefined;
}

export async function loadAllowlistConfig(path: string): Promise<AllowlistConfig> {
  return AllowlistConfig.parse(JSON.parse(await readFile(path, "utf8")));
}

export function evaluateActionPolicy(
  policy: PolicyContext,
  context: ActionPolicyContext,
): PolicyDecision {
  const risk = context.declaredRisk ?? classifyActionRisk(context.action);
  const actionType = context.action.kind;

  if (!policy.allowlist.actionTypes.includes(actionType)) {
    return denied(`action type "${actionType}" is not allowlisted`, risk);
  }

  const url = urlTouchedBy(context.action, context.inputs) ?? context.currentUrl;
  if (url) {
    const routeDecision = evaluateUrlPolicy(policy.allowlist, url);
    if (routeDecision) return denied(routeDecision, risk);
  }

  const secretUrlParam = secretParamInUrl(context.action, policy.inputSensitivity);
  if (secretUrlParam) {
    return denied(`secret input "${secretUrlParam}" may not be used in a URL`, risk);
  }

  if (risk === "irreversible" && !policy.approvalToken) {
    return {
      status: "requires_intervention",
      code: "APPROVAL_REQUIRED",
      risk,
      reason: "irreversible action requires explicit approval or human handoff",
    };
  }

  return { status: "allowed", risk };
}

export function evaluateUrlPolicy(allowlist: AllowlistConfig, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `URL "${rawUrl}" is not absolute`;
  }

  if (!allowlist.origins.includes(url.origin)) {
    return `origin "${url.origin}" is not allowlisted`;
  }

  const path = `${url.pathname}${url.search}`;
  if (allowlist.deniedRoutePatterns.some((pattern) => routeMatches(path, pattern))) {
    return `route "${path}" is explicitly denied`;
  }

  if (!allowlist.routePatterns.some((pattern) => routeMatches(path, pattern))) {
    return `route "${path}" is not allowlisted`;
  }

  return null;
}

export function inputSensitivityFromArtifact(
  inputs: Readonly<Record<string, { sensitivity: Sensitivity }>>,
): Record<string, Sensitivity> {
  return Object.fromEntries(Object.entries(inputs).map(([name, field]) => [name, field.sensitivity]));
}

export class PolicyDeniedError extends Error {
  readonly code = "POLICY_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

function denied(reason: string, risk: PolicyRisk): PolicyDecision {
  return { status: "denied", code: "POLICY_DENIED", reason, risk };
}

function classifyActionRisk(action: Action): PolicyRisk {
  if (action.kind === "navigate" || action.kind === "wait_for") return "safe";
  if (action.kind === "type" || action.kind === "select" || action.kind === "check") return "sensitive";
  if (action.kind === "click" && /confirm|submit|open account|delete|transfer|commit/i.test(action.target.name)) {
    return "irreversible";
  }
  return action.kind === "click" || action.kind === "key" ? "safe" : "sensitive";
}

function urlTouchedBy(action: Action, inputs: Readonly<Record<string, string>>): string | null {
  return action.kind === "navigate" ? resolveValueRef(action.url, inputs) : null;
}

function secretParamInUrl(
  action: Action,
  sensitivity: Readonly<Record<string, Sensitivity>>,
): string | null {
  if (action.kind !== "navigate") return null;
  return valueRefParam(action.url, sensitivity, "secret");
}

function valueRefParam(
  ref: ValueRef,
  sensitivity: Readonly<Record<string, Sensitivity>>,
  expected: Sensitivity,
): string | null {
  return ref.kind === "param" && sensitivity[ref.param] === expected ? ref.param : null;
}

function routeMatches(pathAndSearch: string, pattern: string): boolean {
  const [path] = pathAndSearch.split("?");
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/:[^/]+/g, "[^/]+");
  return new RegExp(`^${source}$`).test(path ?? pathAndSearch);
}
