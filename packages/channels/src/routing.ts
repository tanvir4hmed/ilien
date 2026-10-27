import type { Binding } from "./intents.js";
import type { Actor, Obligation } from "../../coordination/src/types.js";

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
