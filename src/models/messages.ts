/**
 * Messages: an engine sentence as data, for an app to translate. Each has a `code` (a key of
 * `MESSAGES_EN`, the English templates), its `params`, and the English `text` rendered from them.
 * A parameter is a string, a number, a nested message or a list of them, so a translation can
 * rephrase every part. Content names and ids in params (spells, conditions, damage types)
 * stay as the catalog has them.
 */

import { z } from "zod";

export type MessageParam = string | number | boolean | Message | readonly MessageParam[];

export interface Message {
  readonly code: string;
  readonly params: Readonly<Record<string, MessageParam>>;
  readonly text: string;
}

const ParamSchema: z.ZodType<MessageParam> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), MessageSchema, z.array(ParamSchema)]),
);

export const MessageSchema: z.ZodType<Message> = z
  .object({
    code: z.string(),
    params: z.record(z.string(), ParamSchema),
    text: z.string(),
  })
  .meta({ id: "Message" });
