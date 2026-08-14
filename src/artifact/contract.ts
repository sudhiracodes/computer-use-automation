/**
 * The two machine-readable views of an artifact.
 *
 *   1. `artifactJsonSchema()` — JSON Schema for the artifact *format*, for editor
 *      completion and CI validation of hand-edited files.
 *   2. `capabilityContract()` — the *agent-facing* view of a specific artifact:
 *      what to call it, what arguments it takes, what comes back, and which
 *      business outcomes it can legitimately return.
 *
 * The second one is the point of requirement 3.2. An artifact that a human can
 * read but an agent cannot invoke is a document, not a capability; deriving the
 * calling contract from the same Zod definition that validates the document is
 * what keeps the two from drifting apart.
 */

import { z } from "zod";
import {
  CapabilityArtifactShape,
  type CapabilityArtifact,
  type ScalarType,
  type Sensitivity,
} from "./schema.js";

/** Minimal JSON Schema shape we emit. Deliberately not a full JSON Schema type. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface JsonSchemaProperty {
  type: ScalarType;
  description: string;
  examples?: string[];
  /**
   * Non-standard annotation, carried deliberately.
   *
   * A calling agent's harness needs to know that an argument is regulated
   * *before* it logs the call. Standard JSON Schema has nowhere to say that, and
   * the alternative — a side-channel table of sensitive field names — is exactly
   * the kind of thing that drifts out of sync with the contract it describes.
   */
  "x-sensitivity": Sensitivity;
}

export interface CapabilityContract {
  /** The name an agent invokes. Stable across versions. */
  name: string;
  title: string;
  version: string;
  /**
   * Surfaced to the caller so a harness can refuse to run `draft` capabilities
   * unattended. Approval state belongs in the contract, not in a wrapper.
   */
  status: "draft" | "approved";
  description: string;
  surface: string;
  app: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  /**
   * Business outcomes this capability can return instead of a result.
   *
   * Publishing these in the contract is what lets a caller write correct code:
   * `MEMBER_NOT_FOUND` is an answer to be handled, not an exception to be caught,
   * and the caller can only know that if the contract says so up front.
   */
  outcomes: Array<{ code: string; description: string }>;
}

/**
 * JSON Schema for the artifact format itself.
 *
 * Emitted from the structural schema only — cross-field invariants (a parameter
 * naming a declared input, a detector scoped to a real step) are not expressible
 * in JSON Schema. This document is therefore a convenience, and the Zod validator
 * remains the authority. Saying so matters: a file that passes this schema can
 * still be a semantically invalid capability.
 */
export function artifactJsonSchema(): unknown {
  return z.toJSONSchema(CapabilityArtifactShape, {
    io: "input",
    // `reused: "ref"` factors repeated subschemas into $defs. LocatorDescriptor
    // appears at ~20 sites; inlining it produced a 260KB document that no editor
    // or reviewer would tolerate. Refs bring it to a few KB and, more usefully,
    // make the shared vocabulary visible as named definitions rather than as
    // twenty coincidentally-identical blobs.
    reused: "ref",
  });
}

/** Derive the agent-facing calling contract from a validated artifact. */
export function capabilityContract(doc: CapabilityArtifact): CapabilityContract {
  const inputProperties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(doc.inputs)) {
    const property: JsonSchemaProperty = {
      type: field.type,
      description: field.description,
      "x-sensitivity": field.sensitivity,
    };
    if (field.example !== undefined) property.examples = [field.example];
    inputProperties[name] = property;
    if (field.required) required.push(name);
  }

  const outputProperties: Record<string, JsonSchemaProperty> = {};
  for (const [name, field] of Object.entries(doc.outputs)) {
    outputProperties[name] = {
      type: field.type,
      description: field.description,
      "x-sensitivity": field.sensitivity,
    };
  }

  return {
    name: doc.id,
    title: doc.name,
    version: doc.version,
    status: doc.status,
    description: doc.description,
    surface: doc.target.surface,
    app: doc.target.app,
    inputSchema: {
      type: "object",
      properties: inputProperties,
      // Sorted so the emitted contract is byte-stable across runs — a contract
      // that reorders itself produces noisy diffs and defeats review.
      required: required.sort(),
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: outputProperties,
      required: Object.keys(outputProperties).sort(),
      additionalProperties: false,
    },
    outcomes: doc.knownOutcomes.map((o) => ({
      code: o.code,
      description: o.description,
    })),
  };
}
