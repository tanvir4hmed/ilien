import { readFileSync, writeFileSync } from "node:fs";
import { plan } from "../src/planner.js";
import { MODEL_ID, hash, type Context } from "../src/contracts.js";
import { autonomousGate, clarificationFallback } from "../src/autonomy.js";
import { executionActor, gate } from "../src/store.js";
import { seedCase, textilePolicy } from "../../domain-packs/src/textile.js";
import { sourceEventSchema } from "../../contracts/src/validation.js";
import { transition, resolveActor } from "../../coordination/src/engine.js";
const evaluationModel=process.env.AUTONOMY_EVALUATION_MODEL ?? MODEL_ID;
const event=sourceEventSchema.parse(JSON.parse(readFileSync("packages/contracts/examples/production-coordination.event.json","utf8")));
const now=new Date().toISOString();event.occurredAt=now;
let state=seedCase(event,{id:"synthetic-case",inboxId:"synthetic-inbox",sourceId:"synthetic-source",sourceEvidenceId:"source-original"},textilePolicy,now)!;
const evidence:Context["evidence"]=[{id:"source-original",text:JSON.stringify(event),sha256:hash(JSON.stringify(event)),origin:"simulated"}];
const report:{model:string;transport:string;steps:unknown[];observations:unknown[];outcome?:string;error?:string;inputTokens:number;outputTokens:number}={model:evaluationModel,transport:"simulated; only Bedrock inference is real",steps:[],observations:[],inputTokens:0,outputTokens:0};
async function run(task?:string,text?:string) {
 const context:Context={executionMode:"autonomous",state,policy:textilePolicy,policyHash:hash(JSON.stringify(textilePolicy)),actorId:"coordinator",evidence:[...evidence],knowledge:[]};
 if(task && text) {
  const o=state.obligations.find(o=>o.id===task)!;
  const id=`response-${state.revision}`;
  const receivedAt=new Date().toISOString(),expiresAt=new Date(Date.parse(receivedAt)+textilePolicy.evidenceAgeSeconds*1000).toISOString();
  evidence.push({id,text,sha256:hash(text),origin:"simulated"});context.evidence=[...evidence];
  context.actorId=o.assignee;context.receipt={id,evidenceId:id,deliveryId:`send-${o.id}`,bindingId:`binding-${o.assignee}`,actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text,receivedAt,expiresAt};
 }
 let calls=0;
 const result=await plan(context,evaluationModel,{retrieve:async()=>[],record:async(step,obs)=>{report.observations.push({task:task??"case",step,observation:obs});const usage=(obs as {usage?:{inputTokens?:number;outputTokens?:number}}).usage;if(usage){calls++;report.inputTokens+=usage.inputTokens??0;report.outputTokens+=usage.outputTokens??0;}},stillCurrent:async()=>{},validate:p=>gate(context,p)});
 result.proposal=clarificationFallback(context,result.proposal);
 if(result.proposal.disposition!=="propose") {report.steps.push({task:task??"case",state:"waiting",reason:result.proposal.reason,calls});return;}
 const op=autonomousGate(context,result.proposal);
 const actor=executionActor(context,op);
 const effect=transition(state,textilePolicy,resolveActor(textilePolicy,actor),op,context.receipt?.evidenceId??"source-original",new Date().toISOString());
 state=effect.state;
 report.steps.push({task:task??"case",operation:op,actor,calls,status:state.status,contacts:effect.contacts.map(c=>({task:c.obligationId,kind:c.kind,actor:c.actorId}))});
 console.log(JSON.stringify({task:task??"case",operation:op.type,status:state.status}));
}
try {
 await run();if(state.awaitingPlan)throw new Error("initial_routing_not_completed");
 await run("stock","800 units are usable now. The remaining 400 units are unavailable.");
 await run("impact","Using 800 units will delay delivery. I need to confirm how long.");
 await run("impact","Production with 800 units will be ready by 16:00 Dhaka today.");
 for(let i=0;i<3 && !state.obligations.find(o=>o.id==="approval")!.proposal;i++)await run();
 if(!state.obligations.find(o=>o.id==="approval")!.proposal)throw new Error("business_proposal_not_created");
 await run("approval","Approved. Proceed with the exact quantity and completion schedule in your proposal.");
 await run();
 await run("ready","Production has started and is in progress. It is not ready yet.");
 if(state.status==="completed")throw new Error("premature_production_completion");
 await run("ready","Production is ready. Completion reference: PR-AUTO-001.");
 report.outcome=state.status;
 if(String(state.status)!=="completed")throw new Error("mission_not_completed");
} catch(error) {report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
writeFileSync(process.argv[2]??"dist/autonomy-evaluation.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({outcome:report.outcome,error:report.error,inputTokens:report.inputTokens,outputTokens:report.outputTokens,steps:report.steps.length}));
