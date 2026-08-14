/**
 * Operator CLI.
 *
 * Argument parsing is hand-rolled rather than pulled from a framework: there are
 * a handful of subcommands, and a reviewer reading this file should be able to see
 * exactly what each one does without learning a builder API first.
 *
 * Phase 1 exposes only the artifact commands. `discover` and `replay` land in
 * Phases 4 and 2 respectively.
 */

import { artifactJsonSchema, capabilityContract, loadArtifact } from "../artifact/index.js";

const USAGE = `
Usage: npm run cli -- <command> [args]

Commands:
  artifact validate <path>   Validate a capability artifact and report problems
  artifact contract <path>   Print the agent-facing calling contract for an artifact
  artifact schema            Print JSON Schema for the artifact format itself

Phase 1 exposes the artifact commands only.
`.trim();

async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (group !== "artifact") {
    console.error(`Unknown command group "${group}".\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case "validate":
      return artifactValidate(rest[0]);
    case "contract":
      return artifactContract(rest[0]);
    case "schema":
      console.log(JSON.stringify(artifactJsonSchema(), null, 2));
      return 0;
    default:
      console.error(`Unknown artifact command "${command ?? ""}".\n\n${USAGE}`);
      return 2;
  }
}

async function artifactValidate(path: string | undefined): Promise<number> {
  if (!path) {
    console.error("artifact validate requires a path");
    return 2;
  }
  // loadArtifact throws ArtifactValidationError with a formatted report; letting
  // it propagate to main's handler keeps the success path free of error plumbing.
  const artifact = await loadArtifact(path);
  console.log(`OK  ${path}`);
  console.log(`    ${artifact.id}@${artifact.version} (${artifact.status})`);
  const plural = (n: number, singular: string, pluralForm = `${singular}s`): string =>
    `${n} ${n === 1 ? singular : pluralForm}`;

  console.log(
    `    ${[
      plural(artifact.steps.length, "step"),
      plural(Object.keys(artifact.inputs).length, "input"),
      plural(Object.keys(artifact.outputs).length, "output"),
      plural(artifact.knownOutcomes.length, "known outcome"),
      plural(artifact.recoveries.length, "recovery", "recoveries"),
    ].join(", ")}`,
  );
  console.log(
    `    discovered by ${artifact.provenance.discoveredBy}` +
      (artifact.provenance.model ? ` (${artifact.provenance.provider}/${artifact.provenance.model})` : ""),
  );
  return 0;
}

async function artifactContract(path: string | undefined): Promise<number> {
  if (!path) {
    console.error("artifact contract requires a path");
    return 2;
  }
  const artifact = await loadArtifact(path);
  console.log(JSON.stringify(capabilityContract(artifact), null, 2));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
