/**
 * Provider-neutral model boundary.
 *
 * Discovery can ask for text and tool calls. Provider-specific wire formats,
 * request knobs, SDKs, and retry behaviour stay behind implementations of this
 * interface. Replay imports none of this.
 */

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: {
    images: boolean;
    toolCalling: boolean;
    maxContextTokens?: number;
  };
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: ToolDef[];
  maxOutputTokens: number;
  sampling?: { temperature?: number };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string };

export type LLMMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: ContentPart[]; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  jsonSchema: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_calls" | "max_tokens" | "refusal" | "other";
  usage: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}
