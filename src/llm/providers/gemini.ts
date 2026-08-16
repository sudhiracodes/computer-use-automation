import type {
  ContentPart,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolDef,
} from "../provider.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini implementation using the public HTTP API directly.
 *
 * No provider SDK is imported here, which keeps installation light. If a SDK is
 * added later, this file is the only legal place for it under the lint boundary.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";
  readonly model: string;
  readonly capabilities = {
    images: true,
    toolCalling: true,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const MAX_RETRIES = 8;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(toGeminiRequest(request)),
        },
      );

      const raw = (await response.json().catch(() => ({}))) as GeminiResponse;

      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const retryMatch = raw.error?.message?.match(/retry in ([\d.]+)s/i);
        const parsedSeconds = retryMatch && retryMatch[1] ? parseFloat(retryMatch[1]) : NaN;
        const waitSeconds = !Number.isNaN(parsedSeconds) ? Math.ceil(parsedSeconds) + 2 : 20 * (attempt + 1);
        console.error(`[gemini] ${response.status === 429 ? "rate limited" : "service overloaded"}, retrying in ${waitSeconds}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }

      if (!response.ok) {
        const message = raw.error?.message ?? `Gemini request failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      return fromGeminiResponse(raw);
    }

    throw new Error("Gemini request failed: max retries exceeded on rate limit");
  }
}

function toGeminiRequest(request: LLMRequest): GeminiRequest {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map(toGeminiContent),
    ...(request.tools.length > 0
      ? { tools: [{ functionDeclarations: request.tools.map(toGeminiTool) }] }
      : {}),
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens,
      ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    },
  };
}

function toGeminiContent(message: LLMMessage): GeminiContent {
  const role = message.role === "assistant" ? "model" : "user";
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.toolCallId,
            response: { result: message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n") },
          },
        },
      ],
    };
  }

  const parts: GeminiPart[] = message.content.map(toGeminiPart);
  if (message.role === "assistant" && message.toolCalls) {
    parts.push(
      ...message.toolCalls.map((call) => ({
        functionCall: { name: call.name, args: asRecord(call.args) },
      })),
    );
  }
  return { role, parts };
}

function toGeminiPart(part: ContentPart): GeminiPart {
  if (part.type === "text") return { text: part.text };
  return {
    inlineData: {
      mimeType: part.mediaType,
      data: part.dataBase64,
    },
  };
}

function toGeminiTool(tool: ToolDef): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema,
  };
}

function fromGeminiResponse(raw: GeminiResponse): LLMResponse {
  const candidate = raw.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.flatMap((part) => part.text ? [part.text] : []).join("\n");
  const toolCalls: ToolCall[] = parts.flatMap((part, index) =>
    part.functionCall
      ? [{
          id: `gemini-${index}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        }]
      : [],
  );

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(candidate?.finishReason),
    usage: {
      ...(raw.usageMetadata?.promptTokenCount !== undefined ? { inputTokens: raw.usageMetadata.promptTokenCount } : {}),
      ...(raw.usageMetadata?.candidatesTokenCount !== undefined ? { outputTokens: raw.usageMetadata.candidatesTokenCount } : {}),
    },
    raw,
  };
}

function mapFinishReason(reason: string | undefined): LLMResponse["stopReason"] {
  switch (reason) {
    case "STOP":
      return "end";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "refusal";
    default:
      return "other";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface GeminiRequest {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig: { maxOutputTokens: number; temperature?: number };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: unknown };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}
