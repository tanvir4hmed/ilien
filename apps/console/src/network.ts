import type {Journey,RecordRow} from './journey.js';
import {node,words,summary} from './journey.js';
import {openMapPreview} from './map-preview.js';
export const statusTone=(status:unknown)=>({active:'active',received:'received',pending:'waiting',waiting:'waiting',answered:'waiting',accepted:'accepted',verified:'success',completed:'success',published:'accepted',blocked:'danger',disputed:'danger',uncertain:'danger',failed:'danger',paused:'paused',cancelled:'paused'}[String(status)] ?? 'neutral');
export function channelIcon(channel:string) {
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('channel-icon',`channel-${channel==='email'?'email':channel==='whatsapp'?'whatsapp':'source'}`);
 const add=(d:string,fill?:string,stroke?:string)=>{const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);if(fill)path.setAttribute('fill',fill);if(stroke)path.setAttribute('stroke',stroke);svg.append(path);};
 if(channel==='email'){
  // Email is deliberately a clean red envelope, not an imitation multicolour logo.
  add('M3.5 5.5h17v13h-17z','#fff','#c83f3f');add('M4 6 12 12.5 20 6','#fff','#c83f3f');
 } else if(channel==='whatsapp'){
  add('M12 2.5a9.5 9.5 0 0 0-8.1 14.5L2.7 21.3 7.2 20A9.5 9.5 0 1 0 12 2.5z','#25d366');add('M8.2 6.9c-.4 0-.8.2-1 .6-.4.7-1 2.1-.2 3.8.9 2 3.4 4.4 6.5 5.2 1.2.3 2.2-.3 2.8-1.3l.4-.8-2.6-1.2-1 1.2c-1.7-.6-3.2-2-3.8-3.7l1.2-.9-1.2-2.7z','#fff');
 } else {
  // A source/intake request enters the system. It is deliberately not a third channel.
  add('M4 10.5h16v9H4z','#7657ad');add('M4 10.5 7.2 5h9.6l3.2 5.5','#7657ad');add('M8.2 14h7.6v2.1c0 .8-.7 1.4-1.5 1.4H9.7c-.8 0-1.5-.6-1.5-1.4z','#fff');add('M12 3v8m0 0-3-3m3 3 3-3','none','#fff');
 }
 return svg;
}
export function deliveryRecoveries(data:Journey) {
 return data.deliveries.filter(d=>['blocked','uncertain'].includes(String(d.status))).map(failed=>{
  const alternatives=data.deliveries.filter(d=>d.id!==failed.id&&d.contact_id===failed.contact_id&&d.actor_id===failed.actor_id);
  const obligation=data.state.obligations.find(o=>o.id===failed.obligation_id);
  const answered=!!obligation&&['accepted','verified'].includes(obligation.status)&&alternatives.some(d=>data.receipts.some(r=>r.delivery_id===d.id&&r.status==='applied'&&r.evidence_id===obligation.reply?.evidenceId));
  return {failed,alternatives,state:answered?'alternate_answer_received':alternatives.length?'alternate_delivery_recorded':failed.status==='uncertain'?'send_outcome_unknown':'no_alternate_answer'};
 });
}
export const departmentGroups=(data:Journey)=>[...new Set(data.state.obligations.map(o=>o.group))];
function readiness(data:Journey,actorId:string) {
 const bindings=(data.channelBindings??[]).filter(b=>b.actor_id===actorId&&b.enabled);
 if(!bindings.length)return [{channel:'unavailable',label:'No enabled consented endpoint'}];
 return bindings.map(binding=>{
  if(binding.channel==='email')return {channel:'email',label:'Email endpoint ready'};
  const session=!!binding.last_inbound_at&&Date.parse(binding.last_inbound_at)>Date.now()-23.9*3600000;
  return session?{channel:'whatsapp',label:'WhatsApp session active'}:data.whatsappTemplateEnabled?{channel:'whatsapp',label:'Template configured; provider availability checked on send'}:{channel:'whatsapp',label:'Needs active session or approved template'};
 });
}
export function renderCommunicationNetwork(host:HTMLElement,data:Journey,evidence:(id:string)=>Promise<void>) {
 host.replaceChildren();const groups=departmentGroups(data);
 const legend=node('div','','network-legend');for(const [name,status]of [['Active','active'],['Waiting','waiting'],['Accepted','accepted'],['Completed','completed'],['Blocked / uncertain','blocked'],['Paused','paused']]){const b=node('span',name,'badge');b.dataset.tone=statusTone(status);legend.append(b);}host.append(legend);
 const frame=node('div','','journey-scroll network-scroll'),canvas=node('div','','journey-canvas network-canvas'),inspector=node('section','','journey-inspector');frame.append(canvas);frame.tabIndex=0;frame.setAttribute('aria-label','Communication network with ILIEN between participants');
 const nodeWidth=220,nodeHeight=128,width=1180,height=Math.max(500,Math.ceil(groups.length/4)*500);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('aria-hidden','true');canvas.append(svg);
 const defs=document.createElementNS(svg.namespaceURI,'defs'),marker=document.createElementNS(svg.namespaceURI,'marker');const markerId=`network-arrow-${crypto.randomUUID()}`;marker.id=markerId;for(const[k,v]of Object.entries({viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'6',markerHeight:'6',orient:'auto-start-reverse'}))marker.setAttribute(k,v);const tip=document.createElementNS(svg.namespaceURI,'path');tip.setAttribute('d','M0 0 L10 5 L0 10z');tip.setAttribute('fill','context-stroke');marker.append(tip);defs.append(marker);svg.append(defs);
 type Pos={x:number;y:number};const hub={x:465,y:196};
 function edge(a:Pos,b:Pos,kind:'outbound'|'inbound'|'planned'|'failure',offset=0){const line=document.createElementNS(svg.namespaceURI,'path');const ax=a.x+nodeWidth/2,ay=a.y+nodeHeight/2+offset,bx=b.x+nodeWidth/2,by=b.y+nodeHeight/2+offset;const dx=bx-ax,dy=by-ay,length=Math.hypot(dx,dy)||1;const start={x:ax+dx/length*(nodeWidth/2-8),y:ay+dy/length*(nodeHeight/2-8)},end={x:bx-dx/length*(nodeWidth/2-10),y:by-dy/length*(nodeHeight/2-10)};line.setAttribute('d',`M${start.x} ${start.y} Q${(ax+bx)/2+offset*2} ${(ay+by)/2-offset*2} ${end.x} ${end.y}`);line.setAttribute('class',`network-edge edge-${kind}`);line.setAttribute('marker-end',`url(#${markerId})`);svg.append(line);}
 function inspect(title:string,value:unknown,evidenceId?:string){inspector.replaceChildren(node('h3',title));summary(value,inspector);if(evidenceId){const b=node('button','Read original evidence');b.onclick=()=>void evidence(evidenceId);inspector.append(b);}inspector.scrollIntoView({block:'nearest',behavior:'smooth'});}
 function box(title:string,subtitle:string,pos:Pos,status:string,details:unknown,channels:string[]=[],accent?:string,evidenceId?:string){const b=node('button','','journey-node network-node');b.style.left=`${pos.x}px`;b.style.top=`${pos.y}px`;b.dataset.status=status;b.dataset.tone=statusTone(status);if(accent)b.style.setProperty('--department-accent',accent);b.append(node('span',subtitle,'eyebrow'),node('strong',title));if(channels.length){const row=node('div','','network-channels');for(const channel of channels){const tag=node('span','','channel-tag');tag.append(channelIcon(channel),node('span',words(channel)));row.append(tag);}b.append(row);}const badge=node('span',words(status),'badge');badge.dataset.tone=statusTone(status);b.append(badge);b.onclick=()=>inspect(title,details,evidenceId);canvas.append(b);return b;}
 const source={x:0,y:196},outcome={x:930,y:196};edge(source,hub,'outbound');box(data.state.subject.id,'Source request',source,'received',{subject:data.state.subject,goal:data.state.goal,origin:data.state.origin},['source'],undefined,data.state.sourceEvidenceId);
 box('ILIEN','AI coordination agent',hub,data.state.status,{goal:data.state.goal,status:data.state.status,accepted:data.state.obligations.filter(o=>['accepted','verified'].includes(o.status)).length,requirements:data.state.obligations.length,rule:'All participant communication passes through ILIEN. The agent cannot approve its own proposal.'});
 const palette=['#7657ad','#2274a5','#ae6532','#257f72','#a14478','#57689c'];
 for(const[index,group]of groups.entries()){
  const page=Math.floor(index/4),slot=index%4,pos={x:slot%2===0?230:700,y:(slot<2?28:332)+page*500};const tasks=data.state.obligations.filter(o=>o.group===group),ids=new Set(tasks.map(o=>o.id));
  const sends=data.deliveries.filter(d=>ids.has(String(d.obligation_id))),sendIds=new Set(sends.map(d=>d.id)),replies=data.receipts.filter(r=>sendIds.has(r.delivery_id));
  const hasFailure=sends.some(d=>['blocked','uncertain'].includes(String(d.status)))||tasks.some(o=>['blocked','disputed','uncertain'].includes(o.status));const allAccepted=tasks.every(o=>o.skipped||['accepted','verified'].includes(o.status));const anyReply=replies.length>0;const status=data.state.status==='paused'?'paused':allAccepted?'completed':hasFailure?'blocked':anyReply?'answered':sends.length?'waiting':'pending';
  const channels=[...new Set(sends.map(d=>String(d.channel)))];const ownerReadiness=[...new Map(tasks.flatMap(o=>readiness(data,o.assignee)).map(r=>[`${r.channel}/${r.label}`,r])).values()];const planned=[...new Set(ownerReadiness.filter(r=>r.channel!=="unavailable").map(r=>r.channel))];
  if(sends.some(d=>['accepted','sending'].includes(String(d.status))))edge(hub,pos,'outbound',-9);else edge(hub,pos,hasFailure?'failure':'planned');if(replies.length)edge(pos,hub,'inbound',9);
  const synthetic=tasks.some(o=>o.reply&&data.journal.some(j=>j.evidence_id===o.reply!.evidenceId&&j.origin==='simulated')&&!data.receipts.some(r=>r.evidence_id===o.reply!.evidenceId));
  const directory=(data.participants??[]).filter(p=>p.group===group);const b=box(words(group),`${tasks.filter(o=>o.skipped||['accepted','verified'].includes(o.status)).length}/${tasks.length} requirements · ${replies.length} replies`,pos,status,{department:group,people:directory.map(p=>({name:p.name??p.id,role:p.role,enabled:p.enabled,handles:p.capabilities,approvalScopes:p.approvalScopes})),requirements:tasks.map(o=>({question:o.question,status:o.skipped?'not applicable':o.status,assignedTo:words(o.assignee),facts:o.reply?.facts,proposal:o.proposal,decision:o.decision})),channels:ownerReadiness,sends:sends.map(d=>({channel:d.channel,status:d.status,reason:d.reason})),answerOrigin:synthetic?'Includes simulated participant evidence':'Inspect original evidence for participant provenance'},channels.length?channels:planned,palette[index%palette.length]);
  if(!sends.length)b.append(node('small',ownerReadiness.map(r=>r.label).join(' · ')||'No configured send recorded','muted'));if(hasFailure)b.append(node('small','Delivery failure retained','failure-label'));if(synthetic)b.append(node('small','Simulated answer','simulation-label'));
 }
 const result=data.results.find(r=>r.current);if(result){edge(hub,outcome,'outbound');box('Result to source',result.acknowledgement?`Receipt: ${words(result.acknowledgement)}`:`Delivery: ${words(result.dispatch_state)}`,outcome,data.state.status,{dispatch:result.dispatch_state,acknowledgement:result.acknowledgement,scope:'Communication outcome; no operational execution'});}
 const fit=node('button','Fit map to screen');fit.dataset.fitMap='true';fit.onclick=()=>openMapPreview(canvas,'Communication network');const meta=host.querySelector('.journey-meta');meta?.append(fit);host.append(frame,node('p','Teal arrow: request sent. Blue arrow: reply received. Dashed arrow: planned or delivery problem. Select a department to inspect its messages and evidence.','muted'),inspector);
 const recoveries=deliveryRecoveries(data);if(recoveries.length){const card=node('section','','recovery-visibility');card.append(node('h3','Delivery recovery'));for(const r of recoveries){const p=node('p',`${words(r.failed.channel)}: ${words(r.failed.reason)}. ${r.state==='alternate_answer_received'?'An applied answer arrived through the same authorized actor’s alternate channel.':r.state==='alternate_delivery_recorded'?'Alternate delivery recorded; a valid answer is still required.':r.state==='send_outcome_unknown'?'Outcome unknown. Do not resend or fail over until reconciled.':'No authorized alternate-channel answer recorded. Required evidence cannot be skipped.'}`);p.dataset.tone=statusTone(r.state==='alternate_answer_received'?'accepted':'blocked');card.append(p);}host.append(card);}
}
