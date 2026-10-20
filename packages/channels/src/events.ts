import { param, query, rows } from "../../persistence/src/database.js";
import { decode } from "./intents.js";
type ProviderEvent = {
  event_type: string;
  normalized:
    | {
        channelMessageId?: string;
        failure?: {
          code?: number | string;
          title?: string;
          message?: string;
          error_data?: unknown;
        };
      }
    | string;
};
/** Project immutable receipts using the AWS request ID and Meta message alias. */
export async function projectProviderEvents(providerId: string, tx: string) {
  const events = rows<ProviderEvent>(
    await query(
      "SELECT event_type,normalized FROM channel_delivery_events WHERE provider_message_id=:provider OR normalized->>'providerRequestId'=:provider ORDER BY occurred_at DESC,created_at DESC LIMIT 100",
      [param("provider", providerId)],
      tx,
    ),
  ).map((e) => ({ ...e, normalized: decode(e.normalized) }));
  const alias = events.find((e) => e.normalized.channelMessageId)?.normalized
    .channelMessageId;
  if (alias)
    await query(
      "UPDATE channel_deliveries SET channel_message_id=:alias WHERE provider_message_id=:provider AND channel='whatsapp'",
      [param("alias", alias), param("provider", providerId)],
      tx,
    );
  const failed = events.find((e) =>
    ["failed", "bounce", "complaint", "reject", "renderingfailure"].includes(
      e.event_type,
    ),
  );
  if (!failed) return null;
  const conflicting = events.some((e) =>
    ["delivered", "read", "delivery"].includes(e.event_type),
  );
  const failure = failed.normalized.failure;
  const error = {
    code: String(failure?.code ?? failed.event_type),
    message: String(
      failure?.title ??
        failure?.message ??
        "Provider could not deliver this message",
    ).slice(0, 300),
  };
  const d = rows<{ id: string }>(
    await query(
      "UPDATE channel_deliveries SET status=:status,reason=:reason,provider_error=CAST(:error AS jsonb) WHERE provider_message_id=:provider AND status IN ('sending','accepted','uncertain','blocked') RETURNING id",
      [
        param("provider", providerId),
        param("status", conflicting ? "uncertain" : "blocked"),
        param(
          "reason",
          conflicting
            ? "conflicting_provider_events"
            : "provider_delivery_failed",
        ),
        param("error", JSON.stringify(error)),
      ],
      tx,
    ),
  )[0];
  return conflicting ? null : (d?.id ?? null);
}
