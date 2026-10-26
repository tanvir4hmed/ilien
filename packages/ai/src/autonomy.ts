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
  if (proposal.uncertainties.length && !["route_initial","clarify","source_query"].includes(proposal.operation.type))
    throw new CoordinationError("autonomous_clarification_required");
  return proposal.operation;
}

/** A question asks for evidence; it never substitutes for the missing answer. */
export function clarificationFallback(context: Context, proposal: Proposal): Proposal {
  if(!context.state.autonomous) return proposal;
  if(proposal.disposition === "propose" && (!proposal.uncertainties.length || ["route_initial","clarify","source_query"].includes(proposal.operation?.type ?? ""))) return proposal;
  const receipt=context.receipt;
  if(!receipt || !receipt.text.trim()) return proposal;
  const task=context.state.obligations.find(o=>o.id===receipt.obligationId);
  if(!task) return proposal;
  const missing=task.requiredFacts?.map(k=>k.replaceAll("_"," ")).join(", ");
  const question=task.kind === "completion" ? `Please confirm current production progress for ${context.state.subject.id}. When production is ready, explicitly confirm ready status and provide ${missing || "the completion reference"}. Starting work alone is not completion.` : missing ? `Please confirm ${missing} for ${context.state.subject.id}. Include the quantity and unit or exact date, time and timezone where relevant. If it is not yet known, say what must be checked and who can confirm it.` : `Please clarify your reply to this request: ${task.question.slice(0,650)}. Confirm what is known, what remains uncertain, and what information is missing.`;
  if((task.clarificationCount ?? 0)>=4 || task.question.trim().toLowerCase()===question.trim().toLowerCase()) {
    const sourceQuestion=`The responsible ${task.group} participant could not provide a supported answer for ${context.state.subject.id} after clarification. Please supply the missing ${missing || "required information"}, or identify an authorized alternative owner.`;
    if(context.state.sourceQuestions?.some(q=>!q.answer && q.question===sourceQuestion)) return {...proposal,disposition:"wait",operation:null,reason:"Awaiting the existing source clarification."};
    return {disposition:"propose",operation:{type:"source_query",questionId:`clarification_${task.id}_${task.revision}`,question:sourceQuestion},reason:"Repeated unresolved clarification requires source attention.",citations:[{ref:receipt.evidenceId,quote:receipt.text.slice(0,500)}],uncertainties:proposal.uncertainties};
  }
  return {
    disposition:"propose",reason:"The bound response needs clarification; no business answer is inferred.",
    operation:{type:"clarify",obligationId:task.id,question,reason:"Ambiguous participant reply"},
    citations:[{ref:receipt.evidenceId,quote:receipt.text.slice(0,500)}],uncertainties:proposal.uncertainties,
  };
}
