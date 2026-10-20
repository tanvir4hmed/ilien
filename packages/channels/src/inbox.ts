import { z } from "zod";
import {
  param,
  query,
  rows,
  transaction,
} from "../../persistence/src/database.js";
import type { Source } from "../../coordination/src/service.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { decode, type Binding } from "./intents.js";
import { openDeliveries, type OpenDelivery } from "./matching.js";
import { receive } from "./inbound.js";
import type { Incoming } from "./normalize.js";

export async function inboxView(source: Source) {
  return transaction(source.tenant_id, async (tx) => {
    const items = rows<{
      id: string;
      normalized: Incoming | string;
      status: string;
      reason: string;
      case_id: string | null;
      run_id: string | null;
      request: DeliveryRequest | string | null;
    }>(
      await query(
        "SELECT r.id,r.normalized,r.status,r.reason,r.case_id,r.created_at,d.request,(SELECT id FROM ai_runs WHERE receipt_id=r.id ORDER BY created_at DESC LIMIT 1) AS run_id FROM channel_receipts r LEFT JOIN channel_deliveries d ON d.tenant_id=r.tenant_id AND d.id=r.delivery_id WHERE r.connection_id=CAST(:source AS uuid) ORDER BY r.created_at DESC LIMIT 50",
        [param("source", source.id)],
        tx,
      ),
    );
    const bindings = rows<Binding>(
      await query(
        "SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND enabled",
        [param("source", source.id)],
        tx,
      ),
    );
    const open = rows<OpenDelivery>(
      await query(
        "SELECT d.*,c.snapshot FROM channel_deliveries d JOIN coordination_cases c ON c.tenant_id=d.tenant_id AND c.id=d.case_id WHERE d.connection_id=CAST(:source AS uuid) AND c.status='active' AND d.status IN ('accepted','uncertain','sending') ORDER BY d.attempt_at DESC,d.id LIMIT 201",
        [param("source", source.id)],
        tx,
      ),
    );
    return items.map((row) => {
      const item = decode(row.normalized);
      const binding = bindings.find(
        (b) => b.channel === item.channel && b.address === item.sender,
      );
      return {
        id: row.id,
        channel: item.channel,
        sender: item.sender,
        text: item.text,
        status: row.status,
        reason: row.reason,
        caseId: row.case_id,
        runId: row.run_id,
        request: row.request ? decode(row.request) : null,
        receivedAt: item.timestamp,
        bindingId: binding?.id,
        actorId: binding?.actor_id,
        blockedReason: item.blockedReason,
        candidates:
          binding && open.length <= 200
            ? openDeliveries(
                binding,
                open,
                item.timestamp ?? new Date().toISOString(),
              ).map((d) => ({
                id: d.id,
                caseId: d.case_id,
                subject: d.request.subject,
                question: d.request.contact.question,
                channel: d.channel,
              }))
            : [],
      };
    });
  });
}
type DeliveryRequest = import("./intents.js").Delivery["request"];

export async function resolveReceipt(
  source: Source,
  raw: string,
  actor: string,
) {
  const input = z
    .strictObject({
      receiptId: z.uuid(),
      deliveryId: z.uuid().optional(),
      reason: z.string().min(1).max(500),
    })
    .parse(JSON.parse(raw));
  const receipt = await transaction(
    source.tenant_id,
    async (tx) =>
      rows<{ normalized: Incoming | string; original_text: string }>(
        await query(
          "SELECT r.normalized,e.original_text FROM channel_receipts r JOIN evidence_items e ON e.tenant_id=r.tenant_id AND e.id=r.evidence_id WHERE r.id=CAST(:id AS uuid) AND r.connection_id=CAST(:source AS uuid)",
          [param("source", source.id), param("id", input.receiptId)],
          tx,
        ),
      )[0],
  );
  if (!receipt) throw new CoordinationError("receipt_not_found", 404);
  const item = decode(receipt.normalized);
  return receive(
    source.tenant_id,
    source.id,
    { ...item, raw: receipt.original_text },
    { ...input, actor },
  );
}
