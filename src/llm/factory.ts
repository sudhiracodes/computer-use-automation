import { readFile } from "node:fs/promises";
import { GeminiProvider } from "./providers/gemini.js";
import type { LLMProvider } from "./provider.js";

interface LLMConfig {
  provider: "gemini";
  model: string;
  baseUrl?: string;
}

export async function createLLMProvider(configPath = "config/llm.json"): Promise<LLMProvider> {
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as LLMConfig;
  const provider = process.env.LLM_PROVIDER ?? config.provider;
  const model = process.env.LLM_MODEL ?? config.model;

  switch (provider) {
    case "gemini": {
      const apiKey = process.env.LLM_API_KEY;
      if (!apiKey) {
        throw new Error("LLM_API_KEY is required for Gemini discovery runs");
      }
      const baseUrl = process.env.LLM_BASE_URL ?? config.baseUrl;
      return new GeminiProvider({
        apiKey,
        model,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    default:
      throw new Error(`unsupported LLM provider "${provider}"`);
  }
}

export type { LLMProvider } from "./provider.js";
