import type { Action, Condition, LocatorDescriptor, ValueRef } from "../artifact/locator.js";
import type { CapabilityArtifact, Step } from "../artifact/schema.js";
import type { DiscoveryToolCall } from "./tools.js";
import type { InventoryElement, Observation } from "../surface/adapter.js";

export interface RecordedDiscoveryAction {
  call: Exclude<DiscoveryToolCall, { kind: "finish" }>;
  before: Observation;
  after: Observation;
}

export function buildDiscoveredArtifact(
  template: CapabilityArtifact,
  recorded: RecordedDiscoveryAction[],
  provenance: CapabilityArtifact["provenance"],
  initialObservation: Observation,
): CapabilityArtifact {
  const steps = [navigateStep(template, initialObservation), ...recorded.map((entry) => toStep(entry, template.inputs))];
  return {
    ...template,
    status: "draft",
    steps,
    provenance,
  };
}

function navigateStep(template: CapabilityArtifact, initialObservation: Observation): Step {
  const preferred = initialObservation.inventory.find((element) => element.role === "textbox" && element.name === "Operator ID");
  return {
    id: "open-signon",
    intent: "Load the target application entry point.",
    risk: "safe",
    action: { kind: "navigate", url: { kind: "literal", value: template.target.entryUrl } },
    postcondition: preferred
      ? { kind: "element_present", target: descriptorForElement(preferred, template.inputs) }
      : { kind: "url_matches", pattern: "*" },
    timeoutMs: 10_000,
  };
}

function toStep(
  entry: RecordedDiscoveryAction,
  inputs: CapabilityArtifact["inputs"],
): Step {
  const element = inventoryElement(entry.before, entry.call.elementId);
  const target = descriptorForElement(element, inputs);
  const action = actionForCall(entry.call, target);
  const postcondition = needsPostcondition(action) ? checkpointFor(entry.call, entry.after, inputs) : undefined;

  return {
    id: stepIdFor(entry.call, element),
    intent: entry.call.intent,
    action,
    ...(postcondition ? { postcondition } : {}),
    risk: riskFor(entry.call, element),
    timeoutMs: 10_000,
  };
}

function actionForCall(
  call: Exclude<DiscoveryToolCall, { kind: "finish" }>,
  target: LocatorDescriptor,
): Action {
  switch (call.kind) {
    case "click":
      return { kind: "click", target };
    case "type_param":
      return { kind: "type", target, value: { kind: "param", param: call.inputName }, mode: "replace" };
    case "select_param":
      return { kind: "select", target, value: { kind: "param", param: call.inputName } };
    case "check":
      return { kind: "check", target, checked: call.checked };
  }
}

function descriptorForElement(
  element: InventoryElement,
  inputs: CapabilityArtifact["inputs"],
): LocatorDescriptor {
  const descriptor: LocatorDescriptor = {
    strategy: "semantic",
    role: element.role,
    name: element.name,
    nameMatch: "normalized",
    framePath: element.framePath,
    fallbacks: [],
    ...(toArtifactNameSource(element.nameSource) ? { nameSource: toArtifactNameSource(element.nameSource) } : {}),
  };

  const scope = scopeForElement(element, inputs);
  if (scope) descriptor.scope = scope;
  return descriptor;
}

function scopeForElement(
  element: InventoryElement,
  inputs: CapabilityArtifact["inputs"],
): LocatorDescriptor["scope"] | undefined {
  if (element.role !== "link") return undefined;
  const hint = element.scopeHint;
  if (!hint) return undefined;
  for (const name of Object.keys(inputs)) {
    if (name === "operatorPassword") continue;
    const valueRef = valueRefForInputInText(name, hint.text);
    if (valueRef) {
      return { kind: "table_row", name: valueRef, nameMatch: "contains" };
    }
  }
  return undefined;
}

function valueRefForInputInText(inputName: string, text: string): ValueRef | null {
  if (inputName === "memberId" && /\b\d{6}\b/.test(text)) {
    return { kind: "param", param: inputName };
  }
  return null;
}

function checkpointFor(
  call: Exclude<DiscoveryToolCall, { kind: "finish" }>,
  after: Observation,
  inputs: CapabilityArtifact["inputs"],
): Condition {
  const content = after.inventory.filter((element) => element.framePath.includes("content"));
  const named = (role: string, name: string): InventoryElement | undefined =>
    content.find((element) => element.role === role && element.name === name);

  if (named("cell", "Sub-Account Opened")) {
    return { kind: "text_present", text: { kind: "literal", value: "Sub-Account Opened" }, nameMatch: "contains" };
  }

  const preferred =
    named("button", "Confirm and Open Account") ??
    named("link", "View") ??
    named("textbox", "Savings Balance") ??
    named("combobox", "Account Type") ??
    named("textbox", "Member ID") ??
    content.find((element) => element.role === "button" || element.role === "textbox" || element.role === "combobox" || element.role === "link");

  if (preferred) {
    return { kind: "element_present", target: descriptorForElement(preferred, inputs) };
  }

  return { kind: "url_matches", pattern: "*" };
}

function stepIdFor(call: Exclude<DiscoveryToolCall, { kind: "finish" }>, element: InventoryElement): string {
  if (call.kind === "type_param" && call.inputName === "operatorId") return "enter-operator-id";
  if (call.kind === "type_param" && call.inputName === "operatorPassword") return "enter-operator-password";
  if (call.kind === "type_param" && call.inputName === "memberId") return "enter-member-id";
  if (call.kind === "type_param" && call.inputName === "initialDeposit") return "enter-initial-deposit";
  if (call.kind === "select_param" && call.inputName === "accountType") return "choose-account-type";
  if (call.kind === "check") return "acknowledge-disclosure";
  if (call.kind === "click" && element.name === "Sign On") return "submit-signon";
  if (call.kind === "click" && element.name === "Search") return "run-search";
  if (call.kind === "click" && element.name === "View") return "open-member-detail";
  if (call.kind === "click" && element.name === "Open Sub-Account") return "open-subaccount-form";
  if (call.kind === "click" && element.name === "Continue") return "continue-to-review";
  if (call.kind === "click" && element.name === "Confirm and Open Account") return "confirm-open-account";
  return `${call.kind}-${element.role}-${element.id}`;
}

function riskFor(call: Exclude<DiscoveryToolCall, { kind: "finish" }>, element: InventoryElement): Step["risk"] {
  if (call.kind === "click" && element.name === "Confirm and Open Account") return "irreversible";
  if (call.kind === "type_param" || call.kind === "select_param" || call.kind === "check") return "sensitive";
  return "safe";
}

function needsPostcondition(action: Action): boolean {
  return action.kind === "click" || action.kind === "navigate";
}

function inventoryElement(observation: Observation, id: number): InventoryElement {
  const element = observation.inventory.find((candidate) => candidate.id === id);
  if (!element) throw new Error(`model selected unknown inventory element ${id}`);
  return element;
}

function toArtifactNameSource(source: InventoryElement["nameSource"]): LocatorDescriptor["nameSource"] | undefined {
  switch (source) {
    case "native":
    case "aria-label":
    case "label-for":
    case "title":
    case "adjacent-cell":
    case "derived-other":
      return source;
    default:
      return undefined;
  }
}
