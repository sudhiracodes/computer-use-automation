import { z } from "zod";
import type { Action } from "../artifact/locator.js";
import type { ToolDef } from "../llm/provider.js";

export const DiscoveryToolCall = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    elementId: z.number().int().positive(),
    intent: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("type_param"),
    elementId: z.number().int().positive(),
    inputName: z.string().min(1),
    intent: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("select_param"),
    elementId: z.number().int().positive(),
    inputName: z.string().min(1),
    intent: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("check"),
    elementId: z.number().int().positive(),
    checked: z.boolean(),
    intent: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("finish"),
    intent: z.string().min(1),
  }),
]);
export type DiscoveryToolCall = z.infer<typeof DiscoveryToolCall>;

export function discoveryToolDefs(): ToolDef[] {
  return [
    {
      name: "act",
      description:
        "Choose exactly one action using an element id from the current inventory. Use input names, never raw secret values.",
      jsonSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["click", "type_param", "select_param", "check", "finish"],
          },
          elementId: { type: "integer", minimum: 1 },
          inputName: { type: "string" },
          checked: { type: "boolean" },
          intent: { type: "string" },
        },
        required: ["kind", "intent"],
      },
    },
  ];
}

export function actionKindOf(call: DiscoveryToolCall): Action["kind"] | "finish" {
  switch (call.kind) {
    case "click":
      return "click";
    case "type_param":
      return "type";
    case "select_param":
      return "select";
    case "check":
      return "check";
    case "finish":
      return "finish";
  }
}
