import { z } from "zod";
const id = z.string().min(1).max(160);
export const sourceEventSchema = z.strictObject({
  contractVersion: z.literal("1.0"), eventId: id,
  eventType: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/),
  payloadVersion: z.string().min(1).max(32), occurredAt: z.iso.datetime({ offset: true }),
  correlationId: id, causationEventId: id.optional(),
  subject: z.strictObject({ type: id, id, revision: id.optional() }),
  payload: z.record(z.string(), z.unknown()),
});
