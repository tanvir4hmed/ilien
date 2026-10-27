import { z } from "zod";
import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { factSchema } from "../../contracts/src/communication.js";
import { satisfied } from "../../coordination/src/engine.js";
import { CoordinationError, type Operation } from "../../coordination/src/types.js";
import { hash, type Context, type Proposal } from "./contracts.js";
const text=z.string().min(1).max(1000);
const common=z.strictObject({reason:z.string().min(1).max(800),citations:z.array(z.strictObject({ref:z.string().min(1).max(100),quote:z.string().min(1).max(500)})).max(8).optional(),uncertainties:z.array(z.string().min(1).max(200)).max(8).default([])});
type Definition={name:string;description:string;schema:z.ZodType;operation:(input:any)=>Operation|null};
function definitions(c:Context):Definition[] {
 const r=c.receipt,s=c.state;
 const group=z.enum(c.policy.groups as [string,...string[]]);
 const task=s.obligations.find(o=>o.id===r?.obligationId);
 const scoped=r ? {obligationId:r.obligationId,expectedObligationRevision:r.obligationRevision,subjectRevision:s.subject.revision,observedAt:r.receivedAt!,validUntil:r.expiresAt!,timeBasis:"received" as const} : null;
 const defs:Definition[]=[];
 const add=(name:string,description:string,fields:z.ZodRawShape,operation:Definition["operation"])=>defs.push({name:`coordinate_${name}`,description,schema:common.extend(fields),operation});
 if(s.awaitingPlan && !r) {
  const roots=s.obligations.filter(o=>!o.dependencies.length).map(o=>o.id);
  add("route_initial","Start coordination. Select the responsible eligible group and ask the first question supported by the source event. The application binds the original source evidence.",{obligationId:z.enum(roots as [string,...string[]]),group:group.optional(),question:text,channel:z.enum(["email","whatsapp"]).optional()},i=>({type:"route_initial",obligationId:i.obligationId,group:i.group ?? s.obligations.find(o=>o.id===i.obligationId)!.group,question:i.question,channel:i.channel,channelReason:i.reason}));
 } else if(r && ["operator_attention","source_question"].includes(r.kind)) {
  if(r.kind==="source_question"&&r.sourceQuestionId)add("source_response","Record the configured supervisor's answer to this exact source clarification. Preserve their answer without inventing participant approvals.",{answer:text},i=>({type:"source_response",questionId:r.sourceQuestionId!,answer:i.answer}));
  if(r.kind==="operator_attention")add("extend_deadline","Record an explicit response-deadline extension requested by the bound supervisor. Use an ISO timestamp with timezone. This never refreshes evidence or changes a business deadline.",{deadline:z.iso.datetime({offset:true})},i=>({type:"extend_deadline",deadline:i.deadline,reason:i.reason}));
 } else if(r && task) {
  if(r.kind==="verify_request") add("record_verification","Record the authorized verifier's explicit acceptance or rejection of the exact reported claim. Do not invent verification.",{accept:z.boolean()},i=>({type:"verify",obligationId:r.obligationId,replyRevision:r.replyRevision!,accept:i.accept,reason:i.reason}));
  else if(task.kind==="decision" && task.proposal) add("record_decision","Record this bound approver's explicit approval or rejection. Conditional or uncertain agreement is not approval.",{choice:z.enum(["approve","reject"])},i=>({type:"decide",...scoped!,proposalHash:task.proposal!.sha256,choice:i.choice,reason:i.reason}));
  else add("record_answer",`Record THIS participant's answer to task ${task.id}. Extract required facts ${JSON.stringify(task.requiredFacts ?? [])}; if absent, use facts=[] rather than inventing a value. Do this before planning any next department. Values and optional units MUST be literal substrings of each quote. Omit units absent from the quote. ${task.kind === "completion" ? "Progress AND verbatim statusQuote are required. Future tense (will be ready) is in_progress; only current explicit readiness is ready. Do not extract progress itself as a fact; facts contain the completion reference only when present." : "This is not a completion task. Omit progress and statusQuote."}`,{statement:text,facts:z.array(factSchema).max(12),restrictions:z.array(z.string().min(1).max(1000)).max(12).optional(),corrects:z.array(z.string().min(1).max(80)).max(12).optional(),withdrawRestrictions:z.array(z.string().min(1).max(1000)).max(12).optional(),...(task.kind === "completion" ? {progress:z.enum(["in_progress","ready"]),statusQuote:z.string().min(1).max(500)} : {})},i=>({type:"reply",...scoped!,statement:i.statement,facts:i.facts,restrictions:i.restrictions,corrects:i.corrects,withdrawRestrictions:i.withdrawRestrictions,progress:i.progress,statusQuote:i.statusQuote}));
  add("clarify","Ask this SAME participant a precise missing question. Previously supported facts remain valid; do not discard them for ambiguity.",{question:text,channel:z.enum(["email","whatsapp"]).optional()},i=>({type:"clarify",obligationId:r.obligationId,question:i.question,reason:i.reason,channel:i.channel,channelReason:i.reason}));
  add("reroute","PRIORITY when this participant says they do not own the requested information and names an eligible responsible department. Correct that task's group instead of recording their refusal as an answer. Ask the source if ownership is ambiguous.",{group},i=>({type:"reroute",obligationId:r.obligationId,group:i.group,reason:i.reason}));
  add("prerequisite","PRIORITY when the participant cannot answer until another named eligible group supplies a missing prerequisite. Ask that group for that prerequisite before accepting an empty answer. Existing questions must not be duplicated.",{group,question:text,kind:z.enum(["fact","decision","acknowledgement","evidence","commitment","completion"]),proposalStatement:text.optional()},i=>({type:"add_child",parentId:r.obligationId,obligationId:`child_${hash(i.group+i.question).slice(0,16)}`,group:i.group,question:i.question,kind:i.kind,proposalStatement:i.kind==="decision"?i.proposalStatement:undefined}));
 } else {
  const optional=s.obligations.filter(o=>o.optional&&!o.skipped&&o.kind!=="decision"&&o.kind!=="completion"&&!o.requiredFacts?.length&&!s.obligations.some(n=>n.dependencies.includes(o.id)));
  if(optional.length)add("skip_optional","Skip only an explicitly optional notification that is unnecessary for the requested outcome. Mandatory requirements cannot be removed.",{obligationId:z.enum(optional.map(o=>o.id) as [string,...string[]])},i=>({type:"skip_optional",obligationId:i.obligationId,reason:i.reason}));
  const pendingTasks=s.obligations.filter(o=>!satisfied(o));
  if(pendingTasks.length) {
    add("select_channel","Choose a channel for an existing unmet need using registered preferences, evidence complexity, urgency and available channel bindings. Do not send the same request again without a distinct reason.",{obligationId:z.enum(pendingTasks.map(o=>o.id) as [string,...string[]]),channel:z.enum(["email","whatsapp"])},i=>({type:"select_channel",obligationId:i.obligationId,channel:i.channel,reason:i.reason}));
    const reusable=s.obligations.filter(o=>satisfied(o)&&o.reply);
    if(reusable.length)add("reuse_evidence","Satisfy an exact duplicate information request from current evidence of the same responsible participant. Approval, completion and merely similar questions cannot be reused.",{obligationId:z.enum(pendingTasks.map(o=>o.id) as [string,...string[]]),evidenceTaskId:z.enum(reusable.map(o=>o.id) as [string,...string[]])},i=>({type:"satisfy_from",obligationId:i.obligationId,evidenceTaskId:i.evidenceTaskId,reason:i.reason}));
  }
  const pending=s.obligations.filter(o=>o.kind==="decision" && !satisfied(o) && o.dependencies.every(id=>s.obligations.some(d=>d.id===id && satisfied(d))));
  if(pending.length) add("propose_decision","Assemble the exact proposed quantity, timing and conditions from cited participant evidence for an eligible business approver. Cite EVERY number in the statement, including quarantined/reserved quantities and dates, using the original receipt containing that value. A later deadline-only receipt does not support quantities from earlier receipts. Awaiting the approver is normal workflow, not uncertainty about reported facts. This creates a proposal, not an approval.",{obligationId:z.enum(pending.map(o=>o.id) as [string,...string[]]),statement:text},i=>{const o=pending.find(o=>o.id===i.obligationId)!;return {type:"attach_proposal",obligationId:o.id,proposalId:o.proposal?.id ?? `proposal_${o.id}`,proposalRevision:(o.proposal?.revision ?? 0)+1,statement:i.statement,reason:i.reason};});
  const approved=s.obligations.filter(o=>satisfied(o) && o.decision?.choice==="approve" && o.proposal);
  if(approved.length) add("relay_decision","Relay the exact CURRENT approved business decision to an existing responsibility. The application constructs the message; do not rewrite the approval or repeat a relay.",{obligationId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]]),decisionId:z.enum(approved.map(o=>o.id) as [string,...string[]])},i=>({type:"relay_decision",obligationId:i.obligationId,decisionId:i.decisionId}));
  add("clarify_task","Ask the assigned participant a precise missing question on an existing task. Do not repeat questions already waiting for a reply.",{obligationId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]]),question:text},i=>({type:"clarify",obligationId:i.obligationId,question:i.question,reason:i.reason}));
  add("reroute_task","Correct a responsibility using current source evidence and the eligible group directory.",{obligationId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]]),group},i=>({type:"reroute",obligationId:i.obligationId,group:i.group,reason:i.reason}));
  add("prerequisite","Create a genuinely missing prerequisite for an existing task; it must not duplicate a current question.",{parentId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]]),group,question:text,kind:z.enum(["fact","decision","acknowledgement","evidence","commitment","completion"]),proposalStatement:text.optional()},i=>({type:"add_child",parentId:i.parentId,obligationId:`child_${hash(i.group+i.question).slice(0,16)}`,group:i.group,question:i.question,kind:i.kind,proposalStatement:i.kind==="decision"?i.proposalStatement:undefined}));
  add("link_dependency","Link an existing prerequisite rather than creating a duplicate. Cycles are forbidden.",{obligationId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]]),dependencyId:z.enum(s.obligations.map(o=>o.id) as [string,...string[]])},i=>({type:"link_dependency",obligationId:i.obligationId,dependencyId:i.dependencyId}));
 }
 if(r || s.awaitingPlan || !s.obligations.some(o=>o.status==="waiting" && o.reminders>0 && o.dependencies.every(id=>s.obligations.some(d=>d.id===id && satisfied(d)))))add("ask_source","Request genuinely missing SOURCE-owned information through the registered source result contract. Never ask the source for facts already delegated to an outstanding participant question. Never answer the question yourself or repeat an unanswered source question.",{question:text},i=>({type:"source_query",questionId:`source_${hash(i.question).slice(0,16)}`,question:i.question}));
 add("wait","Existing questions cover the goal. Continue the validated plan and wait for new evidence; never manufacture an answer.",{},i=>s.planningPending&&!r?{type:"continue_plan",reason:i.reason}:null);
 return defs;
}
export function autonomousTools(context:Context):Tool[] {
 return definitions(context).map(d=>{const schema=z.toJSONSchema(d.schema);return {toolSpec:{name:d.name,description:d.description+" Include a concise reason. Use uncertainties=[] unless the action actually relies on unresolved doubt. Known negative facts, explicit eligible ownership corrections and pending approval are not uncertainties. The application pins original evidence references; extracted facts require exact quotes.",inputSchema:{json:{type:"object",properties:schema.properties ?? {},required:schema.required ?? []} as never}}};});
}
export function autonomousToolProposal(name:string,input:unknown,context:Context):Proposal {
 const definition=definitions(context).find(d=>d.name===name);
 if(!definition)throw new CoordinationError("ai_unknown_action_tool");
 const parsed=definition.schema.parse(input) as z.infer<typeof common>;
 const operation=definition.operation(parsed);
 let citations=parsed.citations ?? [];
 if(context.receipt) citations=[{ref:context.receipt.evidenceId,quote:context.receipt.text.slice(0,500)}];
 else if(operation) {
   const original=context.evidence.find(e=>e.id===context.state.sourceEvidenceId);
   if(operation.type==="route_initial" && original) citations=[{ref:original.id,quote:original.text.slice(0,200)}];
   else if(!citations.length) citations=context.evidence.slice(0,8).map(e=>({ref:e.id,quote:e.text.slice(0,500)}));
 }
 if(operation?.type==="attach_proposal") {
   const needed=new Set<string>();
   const collect=(id:string)=>{if(needed.has(id))return;needed.add(id);for(const dep of context.state.obligations.find(o=>o.id===id)?.dependencies ?? [])collect(dep);};
   for(const dep of context.state.obligations.find(o=>o.id===operation.obligationId)?.dependencies ?? [])collect(dep);
   const inherited=context.state.obligations.filter(o=>needed.has(o.id)&&satisfied(o)).flatMap(o=>(o.reply?.facts ?? []).map(f=>({ref:f.evidenceId ?? o.reply!.evidenceId,quote:f.quote})));
   const source=context.evidence.find(e=>e.id===context.state.sourceEvidenceId);
   const references:{ref:string;quote:string}[]=[];
   if(source) {
     const identifiers=[context.state.subject.id];
     try{const event=JSON.parse(source.text);for(const [key,value] of Object.entries(event.payload ?? {}))if(key.endsWith("Id")&&typeof value==="string")identifiers.push(value);}catch{}
     for(const value of identifiers)if(operation.statement.includes(value)&&source.text.includes(value))references.push({ref:source.id,quote:value});
   }
   citations=[...new Map([...citations,...inherited,...references].map(c=>[`${c.ref}/${c.quote}`,c])).values()].slice(0,8);
 }
 return {disposition:operation?"propose":"wait",operation,reason:parsed.reason,citations,uncertainties:parsed.uncertainties};
}
