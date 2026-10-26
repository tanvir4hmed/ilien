# Partial dispatch coordination

This synthetic scenario exercises a source-integrated communication service. The browser observes coordination; business participants respond through their existing channels. Shipment execution remains outside ILIEN.

## Setup

Use `packages/contracts/examples/dispatch-exception.event.json`, or Cases → Start case → Partial dispatch coordination. Set a current source timestamp and future needed-by date. Keep the same lot, order and revision throughout. Configure consented `quality_owner` email and `stores_owner` WhatsApp bindings. Never infer recipient consent or authority from a phone number in message text. A system-first WhatsApp message outside the customer-service window requires an approved template and a ready sender; see [channels](CHANNELS.md).

## Exchange

| Step | Participant/channel | Input and expected behavior |
| --- | --- | --- |
| 1 | Synthetic source | Requests coordination for 1200 metre of LOT-TX-204; no release authority is implied. |
| 2 | Quality / email | Reports **1100 metre passes inspection; 100 metre remains quarantined; stock release is not authorized**. Omits the dispatch deadline deliberately. |
| 3 | ILIEN → Quality / email | Records the known facts and asks for the missing deadline. It does not request a complete restatement or invent the date. |
| 4 | Quality / email | Supplies the exact date, time and timezone. Original quantity evidence keeps its own provenance and expiry. |
| 5 | ILIEN → Stores / WhatsApp | Initiates the allocation question using the current lot, inspection constraints and deadline, formatted for that recipient. |
| 6 | Stores / WhatsApp | Reports **only 800 metre usable now; 300 metre of passing stock reserved elsewhere; 100 metre quarantined**. Use the current message reference/thread. |
| 7 | ILIEN → Quality / email | Returns to a previous channel with an exact partial-dispatch proposal grounded in both participants' evidence. It does not propose all 1200 metre or release quarantined stock. |
| 8 | Quality / email | Says approval is conditional and explicitly withholds final approval. ILIEN asks clarification and keeps the exact proposal; conditional agreement is not authorization. |
| 9 | Quality / email | Explicitly approves the exact 800 metre proposal and deadline, keeping quarantine/reservation conditions. |
| 10 | Source handback | Typed facts, decision hash, validity, unresolved requirements and communication status return through the source result contract. Publication, source receipt and operational action are distinct. |

Use a future date in live replies and quote the date from the actual proposal. Do not reuse the example's calendar date after it expires. For a short recording, omit the optional conditional turn only after it has been practiced separately.

## Additional probes

- **Missing prerequisite:** a participant explicitly needs a supplier certificate before answering. An eligible configured supplier contact is required for real delivery; child creation alone is not contact success.
- **Wrong owner:** Stores says Quality owns inspection. Correct the eligible group rather than treating refusal as the answer.
- **Correction:** a participant withdraws an earlier quantity. Dependent evidence/approval becomes stale; a corrected proposal needs fresh business approval.
- **Silence/provider failure:** preserve waiting or blocked/partial outcome, bounded reminder and source report. Never close from silence or silently fabricate a reply.
- **Concurrent cases:** the same sender answers two subjects. Require exact thread/reference correlation; ambiguous messages remain unassigned.

These probes are separate cases when their conditions conflict. Not every possible industry issue is an executable built-in workflow; new mappings and recipient permissions still need configuration.

## Evidence honesty

A real email and a simulated WhatsApp response are different evidence origins. A failed or gated WhatsApp attempt cannot demonstrate delivered AWS WhatsApp communication. A rehearsal can use explicitly simulated transport; keep the live case blocked until the missing real reply arrives. No automatic reset is performed by this guide.
