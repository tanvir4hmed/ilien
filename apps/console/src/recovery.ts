import type {CaseState,Policy,Operation} from "../../../packages/coordination/src/types.js";

export function renderRecovery(parent:HTMLElement,state:CaseState,policy:Policy,submit:(op:Operation,actorId:string)=>Promise<void>) {
  const box=document.createElement("details");box.className="card";
  const heading=document.createElement("summary");heading.textContent="Resolve a blockage / operator controls";box.append(heading);
  const info=document.createElement("p");info.textContent=state.attentionReason ?? "Normal communication runs automatically. These controls are for exceptional recovery.";box.append(info);
  const form=document.createElement("form");box.append(form);
  function field(label:string,type="text") {const wrap=document.createElement("label"),input=document.createElement("input");wrap.textContent=label;input.type=type;wrap.append(input);form.append(wrap);return input;}
  const action=document.createElement("select");
  for(const [value,label] of [["extend_deadline","Extend response deadline (keep evidence)"],["takeover","Take manual control"],["release","Return to autonomous communication"],["pause","Pause"],["resume","Resume"],["reassign","Change responsible person"],["select_channel","Change communication channel"],["cancel","Cancel"],["handoff","Hand off"]]){const o=document.createElement("option");o.value=value!;o.textContent=label!;action.append(o);}
  form.append(action);
  const adopt=document.createElement("option");adopt.value="adopt_configuration";adopt.textContent="Adopt current company configuration";action.append(adopt);
  const reason=field("Reason"),deadline=field("New response deadline","datetime-local");reason.required=true;
  const task=document.createElement("select");for(const o of state.obligations){const option=document.createElement("option");option.value=o.id;option.textContent=`${o.group}: ${o.question}`;task.append(option);}form.append(task);
  const person=document.createElement("select");for(const a of policy.actors.filter(a=>a.enabled&&a.role==="respondent")){const option=document.createElement("option");option.value=a.id;option.textContent=a.name??a.id;person.append(option);}form.append(person);
  const channel=document.createElement("select");for(const value of ["email","whatsapp"]){const option=document.createElement("option");option.value=value;option.textContent=value;channel.append(option);}form.append(channel);
  const update=()=>{deadline.parentElement!.hidden=action.value!=="extend_deadline";deadline.required=action.value==="extend_deadline";task.hidden=!["reassign","select_channel"].includes(action.value);person.hidden=action.value!=="reassign";channel.hidden=action.value!=="select_channel";};action.onchange=update;update();
  const button=document.createElement("button");button.type="submit";button.textContent="Apply recovery action";form.append(button);
  const status=document.createElement("p");form.append(status);
  form.onsubmit=async e=>{e.preventDefault();button.disabled=true;try{
    const actor=policy.actors.find(a=>a.enabled&&a.role==="coordinator");if(!actor)throw new Error("No authorised coordinator configured");
    const op={type:action.value,reason:reason.value,...(action.value==="extend_deadline"?{deadline:new Date(deadline.value).toISOString()}:{}),...(["reassign","select_channel"].includes(action.value)?{obligationId:task.value}:{}),...(action.value==="reassign"?{actorId:person.value}:{}),...(action.value==="select_channel"?{channel:channel.value}:{})} as Operation;
    if(op.type==="adopt_configuration")op.version=policy.version;
    await submit(op,actor.id);status.textContent="Saved. The case will reassess evidence and communication under the current rules.";
  }catch(error){status.textContent=error instanceof Error?error.message:String(error);}finally{button.disabled=false;}};
  parent.append(box);
}
