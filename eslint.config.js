import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * LLM provider SDKs and raw HTTP clients used to reach them.
 *
 * These may be imported ONLY inside src/llm/providers/. Everything above the
 * port depends on the LLMProvider interface and nothing else, so swapping
 * provider is a config change rather than a refactor.
 */
const PROVIDER_SDKS = [
  "@google/genai",
  "@google/generative-ai",
  "@anthropic-ai/*",
  "openai",
  "groq-sdk",
  "cohere-ai",
  "@mistralai/*",
  "ollama",
  "replicate",
  "langchain",
  "langchain/*",
  "@langchain/*",
  "ai",
  "@ai-sdk/*",
];

const BOUNDARY_MESSAGE =
  "LLM provider SDKs may only be imported inside src/llm/providers/. " +
  "Code above the port must depend on the LLMProvider interface only — that is what makes " +
  "the provider swappable by config and keeps replay provider-independent.";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "evidence/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Unused args are fine when prefixed with _ (interface implementations).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Surfacing `any` matters here: the tool-call boundary deliberately
      // receives `unknown` and narrows with Zod. `any` would defeat that.
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
    },
  },

  /**
   * Boundary 1 — no provider SDK outside src/llm/providers/.
   *
   * Uses the typescript-eslint variant rather than the core rule so that
   * `import type { ... }` is caught too; a type-only leak still couples the
   * agent's shape to one vendor's wire format.
   */
  {
    files: ["src/**/*.ts", "target-app/**/*.ts", "tests/**/*.ts"],
    ignores: ["src/llm/providers/**"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ group: PROVIDER_SDKS, message: BOUNDARY_MESSAGE }] },
      ],
    },
  },

  /**
   * Boundary 2 — only the factory may name a concrete provider.
   *
   * Without this, `import { GeminiProvider } from "../llm/providers/gemini.js"`
   * inside the discovery agent would pass Boundary 1 while still hard-wiring a
   * vendor. Consumers resolve a provider through the factory; the concrete
   * classes are an implementation detail of src/llm/.
   */
  {
    files: ["src/**/*.ts"],
    ignores: ["src/llm/factory.ts", "src/llm/providers/**"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: PROVIDER_SDKS, message: BOUNDARY_MESSAGE },
            {
              group: ["**/llm/providers/*", "**/providers/gemini*", "**/providers/openai*"],
              message:
                "Import a provider through src/llm/factory.ts, not by name. Naming a concrete " +
                "provider outside the factory re-couples the caller to a vendor.",
            },
          ],
        },
      ],
    },
  },

  /**
   * Boundary 3 — replay must never depend on the LLM at all.
   *
   * This is the load-bearing claim of the whole record-once/replay-many model:
   * a saved artifact replays with no model in the decision loop. Making it a
   * lint error means the claim cannot quietly stop being true.
   */
  {
    files: ["src/replay/**/*.ts", "src/artifact/**/*.ts", "src/surface/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: PROVIDER_SDKS, message: BOUNDARY_MESSAGE },
            {
              group: ["**/llm/**", "**/discovery/**"],
              message:
                "Replay, the artifact schema, and the surface adapter must not depend on the LLM " +
                "port or the discovery agent. Deterministic replay with no model in the decision " +
                "loop is requirement 3.3 — enforce it here rather than trusting it.",
            },
          ],
        },
      ],
    },
  },
);
