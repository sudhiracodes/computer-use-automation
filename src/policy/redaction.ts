import type { CapabilityArtifact } from "../artifact/schema.js";

export interface Redactor {
  (value: string): string;
}

export function redactorForArtifact(
  artifact: CapabilityArtifact,
  inputs: Readonly<Record<string, string>>,
): Redactor {
  const sensitiveValues = Object.entries(artifact.inputs)
    .filter(([, field]) => field.sensitivity === "secret" || field.sensitivity === "pii")
    .map(([name]) => inputs[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return (value: string): string => {
    let redacted = value;
    for (const sensitive of sensitiveValues) {
      redacted = redacted.split(sensitive).join("[REDACTED]");
    }
    return redacted;
  };
}

export function redactDomSnapshot(domSnapshot: string, redactor: Redactor): string {
  return redactor(domSnapshot)
    .replace(/\bvalue=(["'])(.*?)\1/gi, 'value="[REDACTED]"')
    .replace(/\bdata-[\w-]*(password|token|secret)[\w-]*=(["'])(.*?)\2/gi, 'data-secret="[REDACTED]"');
}
