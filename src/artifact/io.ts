/**
 * Loading, validating, and saving artifacts.
 *
 * Validation errors are formatted for a human at a terminal rather than dumped as
 * a Zod tree. An artifact is a document people hand-edit and review, so the error
 * that says which step is wrong and why is doing real work — a raw issue array
 * shifts that work onto the reader.
 */

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from "./schema.js";

export type ValidationResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; errors: ValidationError[] };

export interface ValidationError {
  /** Dotted path into the document, e.g. `steps.3.postcondition`. */
  path: string;
  message: string;
}

/** Validate an already-parsed value. */
export function validateArtifact(value: unknown): ValidationResult {
  const result = CapabilityArtifact.safeParse(value);
  if (result.success) return { ok: true, artifact: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}

function formatIssues(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** Render errors as a terminal-friendly block. */
export function formatValidationErrors(errors: ValidationError[]): string {
  const lines = [`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`];
  for (const error of errors) {
    lines.push(`  ${error.path}`);
    lines.push(`    ${error.message}`);
  }
  return lines.join("\n");
}

export class ArtifactValidationError extends Error {
  constructor(
    readonly path: string,
    readonly errors: ValidationError[],
  ) {
    super(`${path} is not a valid capability artifact:\n${formatValidationErrors(errors)}`);
    this.name = "ArtifactValidationError";
  }
}

/**
 * Read and validate an artifact from disk.
 *
 * Always validates. There is no `loadUnchecked` escape hatch on purpose: every
 * consumer downstream — replay especially — is entitled to assume the invariants
 * hold, and an unchecked loader is how that assumption quietly stops being true.
 */
export async function loadArtifact(path: string): Promise<Artifact> {
  const raw = await readFile(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON: ${(cause as Error).message}`, { cause });
  }

  const result = validateArtifact(parsed);
  if (!result.ok) throw new ArtifactValidationError(path, result.errors);
  return result.artifact;
}

/**
 * Validate then write, with stable key ordering and a trailing newline.
 *
 * Writing is validate-then-write rather than write-then-hope: an invalid artifact
 * never reaches disk, so a recorder bug cannot leave a corrupt capability behind
 * for replay to trip over later.
 *
 * The serialization is deterministic because these files live in git and get
 * reviewed in pull requests. A recorder that emitted keys in hash order would
 * produce a diff nobody could read, which defeats the reviewability the schema
 * exists to provide.
 */
export async function saveArtifact(path: string, artifact: unknown): Promise<Artifact> {
  const result = validateArtifact(artifact);
  if (!result.ok) throw new ArtifactValidationError(path, result.errors);
  await writeFile(path, serializeArtifact(result.artifact), "utf8");
  return result.artifact;
}

/** Canonical JSON: 2-space indent, top-level keys in declaration order. */
export function serializeArtifact(artifact: Artifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
