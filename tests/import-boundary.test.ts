/**
 * The provider boundary is a claim the architecture makes. This test is what stops
 * it being a comment.
 *
 * It runs the project's real ESLint config over synthetic violating files and
 * asserts the rules actually fire. Checking that eslint.config.js *contains* a rule
 * would prove nothing — a mis-scoped `files` glob or a typo'd package name would
 * pass such a check while enforcing nothing at all.
 *
 * Three boundaries, each protecting a different claim:
 *
 *   1. No provider SDK above src/llm/providers/ — "swapping provider is a config
 *      change" is only true if nothing upstream knows the vendor.
 *   2. Only the factory names a concrete provider — otherwise a caller can pass (1)
 *      while still hard-wiring one.
 *   3. Replay never imports the LLM — requirement 3.3's "no model in the decision
 *      loop" is load-bearing and must not quietly stop being true.
 */

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  return results.flatMap((r) => r.messages.map((m) => m.message));
}

describe("boundary 1: provider SDKs stay inside src/llm/providers/", () => {
  it("rejects a provider SDK import in the discovery agent", async () => {
    const messages = await messagesFor(
      "src/discovery/loop.ts",
      `import { GoogleGenAI } from "@google/genai";\nexport const x = GoogleGenAI;\n`,
    );
    expect(messages.join("\n")).toMatch(/may only be imported inside src\/llm\/providers/);
  });

  it("rejects a TYPE-ONLY provider import too", async () => {
    // A type-only leak still couples the agent's shape to one vendor's wire format,
    // which is why the typescript-eslint variant of the rule is used rather than the
    // core one — the core rule does not see `import type`.
    const messages = await messagesFor(
      "src/discovery/loop.ts",
      `import type { GenerateContentResponse } from "@google/genai";\nexport type X = GenerateContentResponse;\n`,
    );
    expect(messages.join("\n")).toMatch(/may only be imported inside src\/llm\/providers/);
  });

  it("rejects an OpenAI SDK import in the replay engine", async () => {
    const messages = await messagesFor(
      "src/replay/executor.ts",
      `import OpenAI from "openai";\nexport const x = OpenAI;\n`,
    );
    expect(messages.join("\n")).toMatch(/may only be imported inside src\/llm\/providers/);
  });

  it("PERMITS a provider SDK inside src/llm/providers/", async () => {
    // The rule must not be so broad that the adapters themselves cannot be written.
    const messages = await messagesFor(
      "src/llm/providers/gemini.ts",
      `import { GoogleGenAI } from "@google/genai";\nexport const x = GoogleGenAI;\n`,
    );
    expect(messages.join("\n")).not.toMatch(/may only be imported inside/);
  });
});

describe("boundary 2: only the factory names a concrete provider", () => {
  it("rejects the discovery agent importing a provider by name", async () => {
    const messages = await messagesFor(
      "src/discovery/loop.ts",
      `import { GeminiProvider } from "../llm/providers/gemini.js";\nexport const x = GeminiProvider;\n`,
    );
    expect(messages.join("\n")).toMatch(/Import a provider through src\/llm\/factory\.ts/);
  });

  it("PERMITS the factory importing providers by name", async () => {
    const messages = await messagesFor(
      "src/llm/factory.ts",
      `import { GeminiProvider } from "./providers/gemini.js";\nexport const x = GeminiProvider;\n`,
    );
    expect(messages.join("\n")).not.toMatch(/Import a provider through/);
  });
});

describe("boundary 3: replay has no path to the LLM", () => {
  it("rejects replay importing the LLM port", async () => {
    const messages = await messagesFor(
      "src/replay/executor.ts",
      `import type { LLMProvider } from "../llm/provider.js";\nexport type X = LLMProvider;\n`,
    );
    expect(messages.join("\n")).toMatch(/must not depend on the LLM/);
  });

  it("rejects replay importing the discovery agent", async () => {
    const messages = await messagesFor(
      "src/replay/executor.ts",
      `import { runDiscovery } from "../discovery/loop.js";\nexport const x = runDiscovery;\n`,
    );
    expect(messages.join("\n")).toMatch(/must not depend on the LLM/);
  });

  it("rejects the artifact schema importing the LLM port", async () => {
    // The artifact is the durable asset. If its shape could depend on a model API,
    // it would stop outliving vendor decisions.
    const messages = await messagesFor(
      "src/artifact/schema.ts",
      `import type { LLMProvider } from "../llm/provider.js";\nexport type X = LLMProvider;\n`,
    );
    expect(messages.join("\n")).toMatch(/must not depend on the LLM/);
  });

  it("PERMITS the discovery agent importing the LLM port", async () => {
    // Discovery is the one place that legitimately talks to a model.
    const messages = await messagesFor(
      "src/discovery/loop.ts",
      `import type { LLMProvider } from "../llm/provider.js";\nexport type X = LLMProvider;\n`,
    );
    expect(messages.join("\n")).not.toMatch(/must not depend on the LLM/);
  });
});

describe("the real source tree obeys its own boundaries", () => {
  it("lints clean", async () => {
    const results = await eslint.lintFiles(["src/**/*.ts", "target-app/**/*.ts"]);
    const problems = results
      .filter((r) => r.errorCount > 0)
      .map((r) => `${r.filePath}: ${r.messages.map((m) => m.message).join("; ")}`);
    expect(problems).toEqual([]);
  });
});
