import { z } from "zod";
const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
export const factSchema = z.strictObject({
  key: identifier, value: z.string().min(1).max(300),
  unit: z.string().min(1).max(32).optional(), quote: z.string().min(1).max(500),
});
export type Fact = z.infer<typeof factSchema>;
export const messageProfileSchema = z.strictObject({
  group: identifier, channel: z.enum(["whatsapp", "email"]),
  format: z.enum(["human", "json"]), version: identifier,
  language: z.enum(["en", "bn"]).default("en"),
  style: z.enum(["concise", "formal"]).default("concise"),
  sourceFields: z.array(identifier).max(24),
  factKeys: z.array(identifier).max(24),
  fields: z.array(z.strictObject({
    name: identifier, path: z.string().regex(/^(caseId|token|question|deadline|subject\.(id|type|revision)|source\.[A-Za-z0-9_-]+|facts\.[A-Za-z0-9_-]+)$/),
    type: z.enum(["string", "number", "boolean", "object"]), required: z.boolean(),
  })).max(24).default([]),
}).superRefine((p,c) => {
  if (p.format === "json" && (p.channel !== "email" || !p.fields.length))
    c.addIssue({code:"custom", message:"Machine JSON requires an email endpoint and mapped fields"});
  if (new Set(p.fields.map(f=>f.name)).size !== p.fields.length)
    c.addIssue({code:"custom", message:"Duplicate mapped field"});
});
export type MessageProfile = z.infer<typeof messageProfileSchema>;
