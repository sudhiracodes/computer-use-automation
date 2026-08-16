import type {
  ContentPart,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
} from "../provider.js";

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI-compatible HTTP adapter.
 *
 * Covers Groq, OpenRouter, Together, DeepSeek, OpenAI, and local Ollama / vLLM.
 * Implemented using native fetch with exponential retry/backoff.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly capabilities = {
    images: true,
    toolCalling: true,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(toOpenAIRequest(this.model, request)),
      });

      const raw = (await response.json().catch(() => ({}))) as OpenAIResponse;

      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const waitSeconds = 5 * (attempt + 1);
        console.error(
          `[openai-compatible] status ${response.status}, retrying in ${waitSeconds}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }

      if (!response.ok) {
        const message =
          raw.error?.message ?? `OpenAI-compatible request failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      return fromOpenAIResponse(raw);
    }

    throw new Error("OpenAI-compatible request failed: max retries exceeded");
  }
}

function toOpenAIRequest(model: string, request: LLMRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: request.system },
  ];

  for (const msg of request.messages) {
    if (msg.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
      });
    } else if (msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: msg.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args),
                },
              })),
            }
          : {}),
      });
    } else {
      messages.push({
        role: "user",
        content: msg.content.map(toOpenAIContentPart),
      });
    }
  }

  return {
    model,
    messages,
    max_tokens: request.maxOutputTokens,
    ...(request.sampling?.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.jsonSchema,
            },
          })),
        }
      : {}),
  };
}

function toOpenAIContentPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${part.mediaType};base64,${part.dataBase64}`,
    },
  };
}

interface OpenAIResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

function fromOpenAIResponse(raw: OpenAIResponse): LLMResponse {
  const choice = raw.choices?.[0];
  const text = choice?.message?.content ?? "";
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = {};
    }
    return {
      id: tc.id,
      name: tc.function.name,
      args,
    };
  });

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(choice?.finish_reason),
    usage: {
      ...(raw.usage?.prompt_tokens !== undefined ? { inputTokens: raw.usage.prompt_tokens } : {}),
      ...(raw.usage?.completion_tokens !== undefined ? { outputTokens: raw.usage.completion_tokens } : {}),
    },
    raw,
  };
}

function mapFinishReason(reason: string | undefined): LLMResponse["stopReason"] {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}
