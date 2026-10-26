import {needsCasePlanning} from "../../ai/src/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { seedCase, textilePolicy } from "../../domain-packs/src/textile.js";
import { sourceEventSchema } from "../../contracts/src/validation.js";
import { initialize, transition, resolveActor, nextWake } from "../src/engine.js";
import type { CaseState, Operation } from "../src/types.js";
import { renderProfile } from "../../channels/src/profiles.js";
import type { Delivery } from "../../channels/src/intents.js";
import { contactCurrent } from "../../channels/src/intents.js";
import { gate } from "../../ai/src/store.js";
import { autonomousGate, clarificationFallback } from "../../ai/src/autonomy.js";
import { autonomousTools, autonomousToolProposal } from "../../ai/src/tools.js";
import { hash, serializeProposal } from "../../ai/src/contracts.js";
import { messageProfileSchema } from "../../contracts/src/communication.js";
import { recordedRequirements } from "../../../apps/console/src/journey.js";
const now=new Date().toISOString(), later=new Date(Date.now()+1800000).toISOString();
function fresh() {
 const event=sourceEventSchema.parse(JSON.parse(readFileSync("packages/contracts/examples/production-coordination.event.json","utf8")));
 return seedCase(event,{id:"case-test",inboxId:"inbox-test",sourceId:"source-test",sourceEvidenceId:"source-evidence"},textilePolicy,now)!;
}
function apply(state:CaseState,actor:string,op:Operation) {return transition(state,textilePolicy,resolveActor(textilePolicy,actor),op,`evidence-${state.revision}`,now);}
function answer(state:CaseState,id:string,statement:string,facts:{key:string;value:string;quote:string;unit?:string}[]=[],progress?:"in_progress"|"ready") {
 const o=state.obligations.find(o=>o.id===id)!;
 return apply(state,o.assignee,{type:"reply",obligationId:id,expectedObligationRevision:o.revision,statement,observedAt:now,validUntil:later,subjectRevision:"1",facts,progress,statusQuote:progress?statement:undefined});
}
function approved() {
 let s=fresh();
 assert.equal(initialize(s,textilePolicy,now).contacts.length,0);
 s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:s.obligations[0]!.question}).state;
 const stock=answer(s,"stock","800 units usable",[{key:"usable_quantity",value:"800",unit:"units",quote:"800 units usable"}]);
 assert.equal(stock.state.obligations[0]!.status,"accepted");
 assert.ok(stock.contacts.some(c=>c.obligationId==="impact"));
 assert.ok(!stock.contacts.some(c=>c.kind==="verify_request"));
 s=stock.state;
 const missing=answer(s,"impact","Delivery will be delayed");
 assert.equal(missing.state.obligations[1]!.status,"waiting");
 assert.match(missing.contacts[0]!.question,/completion time/);
 s=answer(missing.state,"impact","Ready at 16:00",[{key:"completion_time",value:"16:00",quote:"Ready at 16:00"}]).state;
 s=apply(s,"coordinator",{type:"attach_proposal",obligationId:"approval",proposalId:"plan-1",proposalRevision:1,statement:"800 units; production ready at 16:00",reason:"Reported quantity and schedule"}).state;
 const o=s.obligations.find(o=>o.id==="approval")!;
 const decision=apply(s,"planning_owner",{type:"decide",obligationId:o.id,expectedObligationRevision:o.revision,proposalHash:o.proposal!.sha256,choice:"approve",reason:"Schedule accepted",subjectRevision:"1",observedAt:now,validUntil:later});
 assert.ok(decision.contacts.some(c=>c.kind==="decision_notice" && c.question.includes("800 units")));
 return decision.state;
}
test("quantity → missing time → approval → in progress → production ready completes without an internal verifier",()=>{
 let s=approved();
 const relay=apply(s,"coordinator",{type:"relay_decision",obligationId:"stock",decisionId:"approval"});
 assert.match(relay.contacts[0]!.question,/800 units/);
 assert.throws(()=>apply(relay.state,"coordinator",{type:"relay_decision",obligationId:"stock",decisionId:"approval"}),/decision_already_relayed/);
 s=answer(relay.state,"ready","Production started",[],"in_progress").state;
 assert.equal(s.status,"active");
 s=answer(s,"ready","Production is ready",[],"ready").state;
 assert.equal(s.status,"active","Missing completion reference cannot finish production");
 const done=answer(s,"ready","Production ready, completion PR-001",[{key:"completion_reference",value:"PR-001",quote:"completion PR-001"}],"ready");
 assert.equal(done.state.status,"completed");assert.equal(done.result?.outcome,"completed");
});
test("a quantity correction invalidates the previous approval and queued decision notice",()=>{
 const s=approved();
 const notice:Delivery={case_id:s.id,obligation_id:"ready",obligation_revision:s.obligations[3]!.revision,actor_id:"production_owner",request:{contact:{kind:"decision_notice",decisionId:"approval",decisionHash:s.obligations[2]!.proposal!.sha256},subject:s.subject}} as Delivery;
 assert.ok(contactCurrent(s,notice));
 const corrected=answer(s,"stock","700 units usable",[{key:"usable_quantity",value:"700",unit:"units",quote:"700 units usable"}]).state;
 assert.equal(corrected.obligations[2]!.status,"waiting");
 assert.equal(corrected.obligations[2]!.proposal,undefined,"Old proposed terms must not survive a changed prerequisite");
 assert.ok(!contactCurrent(corrected,notice));
 assert.throws(()=>apply(corrected,"coordinator",{type:"relay_decision",obligationId:"stock",decisionId:"approval"}),/current_approved_decision_required/);
 const correction=answer(s,"stock","700 units usable",[{key:"usable_quantity",value:"700",unit:"units",quote:"700 units usable"}]);
 assert.ok(correction.contacts.some(c=>c.kind==="decision_update" && c.actorId==="production_owner"));
});
test("clarification keeps the same task; rerouting stays inside the published service scope",()=>{
 let s=fresh();s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm available quantity"}).state;
 const clarified=apply(s,"coordinator",{type:"clarify",obligationId:"stock",question:"How much is usable rather than total stock?",reason:"Clarify usable amount"});
 assert.equal(clarified.state.obligations.length,4);assert.equal(clarified.contacts[0]!.actorId,"stores_owner");
 assert.throws(()=>apply(s,"coordinator",{type:"reroute",obligationId:"stock",group:"unauthorized",reason:"Guess"}),/group_outside_service_scope/);
 const routed=apply(s,"coordinator",{type:"reroute",obligationId:"stock",group:"procurement",reason:"Source identified procurement as the owner"});
 assert.equal(routed.contacts[0]!.actorId,"procurement_owner");
});
test("source clarification is a typed source request and cannot be answered by the model",()=>{
 let s=approved();s=apply(s,"coordinator",{type:"source_query",questionId:"destination",question:"Confirm the destination for this order"}).state;
 s=answer(s,"ready","Production ready, PR-001",[{key:"completion_reference",value:"PR-001",quote:"PR-001"}],"ready").state;
 assert.notEqual(s.status,"completed");
 const c={state:s,policy:textilePolicy,policyHash:"hash",actorId:"coordinator",evidence:[{id:"source-evidence",text:"Confirm destination",origin:"simulated",sha256:"hash"}],knowledge:[]};
 assert.throws(()=>gate(c,{disposition:"propose",operation:{type:"source_response",questionId:"destination",answer:"Invented destination"},reason:"Guess",citations:[{ref:"source-evidence",quote:"Confirm destination"}],uncertainties:[]}),/ai_operation_forbidden/);
 assert.equal(apply(s,"coordinator",{type:"source_response",questionId:"destination",answer:"Authorized source confirms destination A"}).state.status,"completed");
});
test("machine email renders only the exact typed field mapping; absent required fields block",()=>{
 const p=messageProfileSchema.parse({group:"production",channel:"email",format:"json",version:"v1",sourceFields:["quantity"],factKeys:[],fields:[{name:"order",path:"subject.id",type:"string",required:true},{name:"amount",path:"source.quantity",type:"number",required:true}]});
 const d={case_id:"case-1",token:"route-token",request:{subject:{id:"ORDER-1",type:"order",revision:"1"},contact:{question:"Coordinate"},deadline:later,sourceContext:{quantity:800,confidentialPrice:1234}}} as unknown as Delivery;
 assert.deepEqual(JSON.parse(renderProfile(d,p)),{order:"ORDER-1",amount:800});
 d.request.sourceContext={};assert.throws(()=>renderProfile(d,p),/machine_payload_required_field_missing/);
});
test("autonomous fact extraction cannot invent quantity and future estimates cannot mean ready",()=>{
 const s=approved(),o=s.obligations[3]!;
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"reply",text:"Not ready; 800 units in progress",origin:"external",sha256:"hash"}],knowledge:[],receipt:{id:"receipt",evidenceId:"reply",deliveryId:"send",bindingId:"binding",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"decision_notice",text:"Not ready; 800 units in progress",receivedAt:now,expiresAt:later}};
 const op:Operation={type:"reply",obligationId:o.id,expectedObligationRevision:o.revision,statement:"800 units",observedAt:now,validUntil:later,timeBasis:"received",subjectRevision:"1",facts:[{key:"quantity",value:"8000",quote:"800 units"}]};
 const p={disposition:"propose" as const,operation:op,reason:"Interpret",citations:[{ref:"reply",quote:"800 units"}],uncertainties:[]};
 assert.throws(()=>autonomousGate(c,p),/ai_fact_not_grounded/);
 op.facts=[];op.progress="ready";op.statusQuote="Not ready";
 assert.throws(()=>autonomousGate(c,p),/ai_completion_not_explicit/);
});
test("conditional or negative language cannot authorize a business approval",()=>{
 let s=fresh();s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm usable quantity"}).state;
 s=answer(s,"stock","800 units",[{key:"usable_quantity",value:"800",unit:"units",quote:"800 units"}]).state;
 s=answer(s,"impact","16:00",[{key:"completion_time",value:"16:00",quote:"16:00"}]).state;
 s=apply(s,"coordinator",{type:"attach_proposal",obligationId:"approval",proposalId:"p",proposalRevision:1,statement:"800 units at 16:00",reason:"Report"}).state;
 const o=s.obligations[2]!,text="I would approve, but the delivery time is not confirmed.";
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"r",text,sha256:"hash",origin:"external"}],knowledge:[],receipt:{id:"r",evidenceId:"r",deliveryId:"d",bindingId:"b",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text}};
 assert.throws(()=>autonomousGate(c,{disposition:"propose",operation:{type:"decide",obligationId:o.id,expectedObligationRevision:o.revision,proposalHash:o.proposal!.sha256,choice:"approve",reason:"Yes",subjectRevision:"1",observedAt:now,validUntil:later},citations:[{ref:"r",quote:text}],reason:"Interpret",uncertainties:[]}),/ai_explicit_decision_required/);
 const conditional="Approved only if overtime is authorized. Overtime is not approved yet.";
 c.receipt.text=conditional;c.evidence[0]!.text=conditional;
 for(const choice of ["approve","reject"] as const)assert.throws(()=>autonomousGate(c,{disposition:"propose",operation:{type:"decide",obligationId:o.id,expectedObligationRevision:o.revision,proposalHash:o.proposal!.sha256,choice,reason:"Interpret",subjectRevision:"1",observedAt:now,validUntil:later},citations:[{ref:"r",quote:conditional}],reason:"Interpret",uncertainties:[]}),/ai_conditional_decision_requires_clarification/);

});

test("granular tools bind identity and time in application code and require explicit completion evidence",()=>{
 const s=approved(),o=s.obligations[3]!,text="Production will be ready tomorrow.";
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"r",text,sha256:"hash",origin:"external"}],knowledge:[],receipt:{id:"r",evidenceId:"r",deliveryId:"d",bindingId:"b",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text,receivedAt:now,expiresAt:later}};
 const p=autonomousToolProposal("coordinate_record_answer",{reason:"Reported future schedule",statement:text,facts:[],progress:"in_progress",statusQuote:text},c);
 assert.equal(p.operation?.type,"reply");
 if(p.operation?.type!=="reply")throw new Error("reply required");
 assert.equal(p.operation.observedAt,now);assert.equal(p.operation.timeBasis,"received");
 assert.equal(p.operation.obligationId,o.id);assert.equal(p.citations[0]!.ref,"r");
 assert.throws(()=>autonomousToolProposal("coordinate_record_answer",{reason:"Invalid",statement:text,facts:[],progress:"ready"},c));
 p.operation.progress="ready";
 assert.throws(()=>autonomousGate(c,p),/ai_completion_not_explicit/);
 const names=autonomousTools(c).map(t=>t.toolSpec?.name);
 assert.ok(!names.includes("coordinate_propose_decision"));
 assert.throws(()=>autonomousToolProposal("coordinate_source_response",{},c),/ai_unknown_action_tool/);
});

test("an uncertain proposed reply becomes a bounded clarification, never accepted business data",()=>{
 let s=fresh();s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm usable quantity"}).state;
 const o=s.obligations[0]!,text="Maybe 800 units; I have to check.";
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"r",text,sha256:"hash",origin:"external"}],knowledge:[],receipt:{id:"r",evidenceId:"r",deliveryId:"d",bindingId:"b",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text,receivedAt:now,expiresAt:later}};
 const p=clarificationFallback(c,{disposition:"propose",operation:{type:"reply",obligationId:o.id,expectedObligationRevision:o.revision,statement:text,subjectRevision:"1",observedAt:now,validUntil:later},reason:"Uncertain",citations:[{ref:"r",quote:text}],uncertainties:["Usable amount unknown"]});
 assert.equal(autonomousGate(c,p).type,"clarify");
 if(p.operation?.type!=="clarify")throw new Error("clarify required");
 c.state=apply(s,"coordinator",p.operation).state;
 const escalated=clarificationFallback(c,{disposition:"review",operation:null,reason:"Still uncertain",citations:[],uncertainties:["Unknown"]});
 assert.equal(autonomousGate(c,escalated).type,"source_query");
});

test("planning and proposal assembly wait for events rather than invalidating model work with one-second ticks",()=>{
 let s=fresh();assert.equal(nextWake(s,textilePolicy,now),s.deadline);
 const expired=transition(s,textilePolicy,null,{type:"tick"},"clock",new Date(Date.parse(s.deadline)+1).toISOString());
 assert.equal(expired.state.status,"blocked");assert.equal(expired.result?.terminal,true);
 s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm stock"}).state;
 s=answer(s,"stock","800 units",[{key:"usable_quantity",value:"800",quote:"800 units"}]).state;
 s=answer(s,"impact","16:00",[{key:"completion_time",value:"16:00",quote:"16:00"}]).state;
 assert.equal(s.obligations[2]!.proposal,undefined);
 assert.ok(Date.parse(nextWake(s,textilePolicy,now)!)>Date.parse(now)+1000);
});

test("persisted proposal hashing survives JSONB key reordering but detects changed terms",()=>{
 const p={operation:{question:"Confirm 800 units",group:"stores",obligationId:"stock",type:"route_initial"},uncertainties:[],citations:[{quote:"800",ref:"source"}],reason:"Start",disposition:"propose"};
 const reorder=(v:unknown):unknown=>Array.isArray(v)?v.map(reorder):v && typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
 assert.equal(hash(serializeProposal(p)),hash(serializeProposal(reorder(p))));
 const changed=structuredClone(p);changed.operation.question="Confirm 8000 units";
 assert.notEqual(hash(serializeProposal(p)),hash(serializeProposal(changed)));
});

test("an explicit negative report is preserved rather than converted to positive authority",()=>{
 let s=fresh();s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm usable quantity"}).state;
 const o=s.obligations[0]!,text="Stock release is not authorized.";
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"r",text,sha256:"hash",origin:"external"}],knowledge:[],receipt:{id:"r",evidenceId:"r",deliveryId:"d",bindingId:"b",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text,receivedAt:now,expiresAt:later}};
 const p=autonomousToolProposal("coordinate_record_answer",{reason:"Preserve negative release status",statement:text,facts:[{key:"release_authorization",value:"not authorized",quote:text}]},c);
 assert.equal(autonomousGate(c,p).type,"reply");
 if(p.operation?.type!=="reply")throw new Error("reply required");
 p.operation.facts![0]!.value="authorized";
 assert.throws(()=>autonomousGate(c,p),/ai_fact_negation_lost/);
});

test("a wrong-department refusal cannot satisfy the task or invent a replacement owner",()=>{
 let s=fresh();s=apply(s,"coordinator",{type:"route_initial",obligationId:"stock",group:"stores",question:"Confirm usable stock"}).state;
 const o=s.obligations[0]!,text="We do not own this inspection. Quality owns the inspection result.";
 const c={executionMode:"autonomous" as const,state:s,policy:textilePolicy,policyHash:"hash",actorId:o.assignee,evidence:[{id:"r",text,sha256:"hash",origin:"external"}],knowledge:[],receipt:{id:"r",evidenceId:"r",deliveryId:"d",bindingId:"b",actorId:o.assignee,obligationId:o.id,obligationRevision:o.revision,kind:"ask",text,receivedAt:now,expiresAt:later}};
 assert.throws(()=>autonomousGate(c,autonomousToolProposal("coordinate_record_answer",{reason:"Refusal",statement:text,facts:[]},c)),/ai_wrong_department_requires_routing/);
 assert.equal(autonomousGate(c,autonomousToolProposal("coordinate_reroute",{reason:"Quality explicitly identified",group:"quality"},c)).type,"reroute");
 assert.throws(()=>autonomousGate(c,autonomousToolProposal("coordinate_reroute",{reason:"Guess",group:"procurement"},c)),/ai_route_owner_not_identified/);
});

test("earlier source outcome cards preserve their recorded requirement states",()=>{
 const earlier={requirements:[{requirementId:"request",status:"missing",reasonCode:"waiting"}]};
 const current={requirements:[{requirementId:"request",status:"satisfied",reasonCode:"accepted"}]};
 assert.deepEqual(recordedRequirements(earlier),[{requirement:"request",status:"Waiting"}]);
 assert.deepEqual(recordedRequirements(current),[{requirement:"request",status:"Accepted"}]);
 assert.equal(earlier.requirements[0]!.reasonCode,"waiting");
});

test("an email clarification adds only the missing deadline and preserves each earlier fact's evidence and expiry",()=>{
 const event=sourceEventSchema.parse(JSON.parse(readFileSync('packages/contracts/examples/dispatch-exception.event.json','utf8')));
 let s=seedCase(event,{id:'dispatch-test',inboxId:'inbox-test',sourceId:'source-test',sourceEvidenceId:'source'},textilePolicy,now)!;
 s=apply(s,'coordinator',{type:'route_initial',obligationId:'inspection',group:'quality',question:'Confirm inspection and deadline'}).state;
 const originalRevision=s.revision;
 s=answer(s,'inspection','1100 metre passes; 100 metre quarantined',[{key:'passing_quantity',value:'1100',unit:'metre',quote:'1100 metre passes'},{key:'quarantined_quantity',value:'100',unit:'metre',quote:'100 metre quarantined'}]).state;
 assert.equal(s.obligations[0]!.status,'waiting');
 const newer=new Date(Date.parse(now)+120000).toISOString(),expiry=new Date(Date.parse(later)+120000).toISOString(),o=s.obligations[0]!;
 const effect=transition(s,textilePolicy,resolveActor(textilePolicy,o.assignee),{type:'reply',obligationId:o.id,expectedObligationRevision:o.revision,statement:'Deadline16:00 Dhaka today',subjectRevision:'1',observedAt:newer,validUntil:expiry,facts:[{key:'dispatch_deadline',value:'16:00 Dhaka today',quote:'Deadline16:00 Dhaka today'}]},'deadline-reply',newer);
 const facts=effect.state.obligations[0]!.reply!.facts!;
 assert.equal(effect.state.obligations[0]!.status,'accepted');assert.equal(facts.length,3);
 assert.equal(facts.find(f=>f.key==='passing_quantity')!.evidenceId,`evidence-${originalRevision}`);
 assert.equal(facts.find(f=>f.key==='dispatch_deadline')!.evidenceId,'deadline-reply');
 assert.equal(effect.state.obligations[0]!.reply!.validUntil,later,'A new reply must not renew older facts');
 assert.ok(effect.contacts.some(c=>c.obligationId==='allocation'));
});

test("decision clarification keeps exact proposed terms but removes any earlier approval",()=>{
 const s=approved(),proposal=s.obligations.find(o=>o.id==='approval')!.proposal!;
 const effect=apply(s,'coordinator',{type:'clarify',obligationId:'approval',question:'Is that an unconditional approval of the exact current proposal?',reason:'Conditional reply'});
 const o=effect.state.obligations.find(o=>o.id==='approval')!;
 assert.equal(o.proposal!.sha256,proposal.sha256);assert.equal(o.decision,undefined);assert.equal(o.status,'waiting');
 assert.ok(effect.contacts.some(c=>c.obligationId==='approval'&&c.kind==='ask'));
});

test("withdrawn or rerouted facts cannot silently survive as current clarification context",()=>{
 let s=fresh();s=apply(s,'coordinator',{type:'route_initial',obligationId:'stock',group:'stores',question:'Confirm stock'}).state;
 s=answer(s,'stock','800 units',[{key:'usable_quantity',value:'800',quote:'800 units'}]).state;
 const withdrawn=apply(s,'coordinator',{type:'clarify',obligationId:'stock',question:'Provide the corrected usable quantity',reason:'Earlier quantity is incorrect',discardFacts:true}).state;
 assert.deepEqual(withdrawn.obligations[0]!.retainedFacts,[]);assert.equal(withdrawn.obligations[0]!.reply,undefined);
 const rerouted=apply(s,'coordinator',{type:'reroute',obligationId:'stock',group:'procurement',reason:'Confirmed new owner'}).state;
 assert.equal(rerouted.obligations[0]!.retainedFacts,undefined);assert.equal(rerouted.obligations[0]!.reply,undefined);
});

test("automatic questions wait without a second model run; grounded proposal assembly still wakes",()=>{
 let s=fresh();assert.equal(needsCasePlanning(s,'activate'),true);
 s=apply(s,'coordinator',{type:'route_initial',obligationId:'stock',group:'stores',question:'Confirm usable quantity'}).state;
 assert.equal(needsCasePlanning(s,'route_initial'),false);
 s=answer(s,'stock','800 units',[{key:'usable_quantity',value:'800',unit:'units',quote:'800 units'}]).state;
 assert.equal(needsCasePlanning(s,'reply'),false);
 s=answer(s,'impact','16:00',[{key:'completion_time',value:'16:00',quote:'16:00'}]).state;
 assert.equal(needsCasePlanning(s,'reply'),true);
 s=apply(s,'coordinator',{type:'attach_proposal',obligationId:'approval',proposalId:'p',proposalRevision:1,statement:'800 units by 16:00',reason:'Grounded plan'}).state;
 assert.equal(needsCasePlanning(s,'attach_proposal'),false);
 s=apply(s,'coordinator',{type:'clarify',obligationId:'approval',question:'Please confirm this exact plan',reason:'Conditional reply'}).state;
 assert.equal(needsCasePlanning(s,'clarify'),false);
 assert.equal(needsCasePlanning(s,'source_response'),false);
});
