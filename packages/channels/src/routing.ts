import type { Binding } from "./intents.js";
import type { Actor, Obligation } from "../../coordination/src/types.js";
type SharedRouting={demoRouting?:{enabled:boolean;actorId:string;routes?:{group:string;channel:string;actorId:string}[]}};
/** Explicit shared recipients are limited to simulated sources; logical business roles stay distinct. */
export function contactBindings<T extends {actor_id:string;channel:string;enabled:boolean}>(bindings:T[],actorId:string,group:string,origin:string,configuration:SharedRouting):T[] {
 const shared=configuration.demoRouting;
 if(origin!=="simulated"||!shared?.enabled)return bindings.filter(b=>b.enabled&&b.actor_id===actorId);
 if(shared.routes?.length)return bindings.filter(b=>b.enabled&&shared.routes!.some(r=>r.group===group&&r.channel===b.channel&&r.actorId===b.actor_id));
 return bindings.filter(b=>b.enabled&&b.actor_id===shared.actorId);
}

/** Model preferences are constrained to consented contacts; never invent addresses. */
export function chooseBinding(bindings:Binding[],task:Obligation,actor:Actor|undefined,hasTemplate:boolean) {
  const preferred=task.preferredChannel ?? actor?.preferredChannel;
  const scored=bindings.filter(b=>b.enabled).map(b=>{
    const session=b.channel==="email" || !!b.last_inbound_at && Date.parse(b.last_inbound_at)>Date.now()-23.9*3600000;
    const ready=session || hasTemplate;
    return {binding:b,score:(ready?10000:0)+(b.channel===preferred?1000:0)+(b.channel==="email"&&task.kind==="evidence"?100:0)-((b as Binding & {priority?:number}).priority ?? 10)};
  }).sort((a,b)=>b.score-a.score || a.binding.id.localeCompare(b.binding.id));
  const selected=scored[0]?.binding;
  return selected ? {binding:selected,reason:task.channelReason ?? (selected.channel===preferred?"Registered preference for this conversation":"Available consented channel suitable for the current request")} : undefined;
}
