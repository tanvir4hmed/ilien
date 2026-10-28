import type {Journey,RecordRow} from './journey.js';
import type {Obligation} from '../../../packages/coordination/src/types.js';

export const attempted=(d:RecordRow)=>!!d.attempt_at||['sending','accepted','blocked','uncertain'].includes(String(d.status));
export function noticeContactIds(data:Journey){return new Set((data.contacts??[]).filter(c=>{const contact=typeof c.contact==='string'?JSON.parse(c.contact):c.contact;return contact?.kind==='completion_notice';}).map(c=>c.id));}
export function taskSends(data:Journey,id:string){const notices=noticeContactIds(data);return data.deliveries.filter(d=>d.obligation_id===id&&!notices.has(d.contact_id));}
export function runtimeGroups(data:Journey){return [...new Set(data.state.obligations.filter(o=>taskSends(data,o.id).some(attempted)).map(o=>o.group))];}
export function publishedFinalResult(data:Journey){
 return data.results.find(r=>{if(!r.current||r.dispatch_state!=='published'||data.state.status!=='completed')return false;try{const value=typeof r.result==='string'?JSON.parse(r.result):r.result;return value?.outcome==='completed'||value?.status==='completed';}catch{return false;}});
}
export function taskMapStatus(data:Journey,o:Obligation){
 if(o.skipped)return 'not required';
 if(o.satisfiedFrom)return 'evidence reused';
 if(['accepted','verified','blocked','disputed','uncertain'].includes(o.status))return o.status;
 if(o.dependencies.some(id=>!data.state.obligations.some(d=>d.id===id&&(d.skipped||['accepted','verified'].includes(d.status)))))return 'waiting for prerequisites';
 const sends=taskSends(data,o.id),attempts=sends.filter(attempted);
 if(!attempts.length)return sends.length?'queued':'not started';
 const ids=new Set(attempts.map(d=>d.id));
 const reply=data.receipts.filter(r=>ids.has(r.delivery_id)).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
 if(reply&&['quarantined','rejected','unmatched'].includes(String(reply.status)))return 'reply held';
 if(reply&&['needs_review','processing'].includes(String(reply.status)))return 'processing reply';
 if(attempts.every(d=>['blocked','uncertain'].includes(String(d.status))))return 'channel blocked';
 return 'awaiting answer';
}
export function departmentMapStatus(data:Journey,group:string){
 const tasks=data.state.obligations.filter(o=>o.group===group),contacted=tasks.filter(o=>taskSends(data,o.id).some(attempted));
 if(tasks.every(o=>o.skipped||['accepted','verified'].includes(o.status)))return 'accepted';
 const states:string[]=contacted.map(o=>taskMapStatus(data,o));
 for(const state of ['reply held','processing reply','blocked','disputed','uncertain','awaiting answer','channel blocked'])if(states.includes(state))return state;
 return 'waiting for next step';
}
export function channelMapStatus(data:Journey,sends:RecordRow[]){
 const latest=[...sends].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
 if(!latest)return 'not started';
 if(['blocked','uncertain'].includes(String(latest.status)))return String(latest.status);
 if(latest.provider_message_id&&data.deliveryEvents.some(e=>e.provider_message_id===latest.provider_message_id&&['delivered','read','delivery'].includes(String(e.event_type))))return 'delivered';
 return latest.status==='accepted'?'provider accepted':String(latest.status);
}
