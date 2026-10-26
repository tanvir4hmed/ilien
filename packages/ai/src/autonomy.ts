import type { Context, Proposal } from "./contracts.js";
import { CoordinationError } from "../../coordination/src/types.js";
import { gate } from "./store.js";

/** Server settings select execution mode. Model confidence never grants authority. */
export function autonomousGate(context: Context, proposal: Proposal) {
  if (context.executionMode !== "autonomous")
    throw new CoordinationError("autonomous_mode_required");
  gate(context, proposal);
  if (proposal.disposition !== "propose" || !proposal.operation)
    throw new CoordinationError("autonomous_no_effect");
  if (proposal.uncertainties.length)
    throw new CoordinationError("autonomous_clarification_required");
  return proposal.operation;
}
