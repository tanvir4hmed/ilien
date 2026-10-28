import type {Policy,Actor} from "../../../packages/coordination/src/types.js";
import type {ProductConfiguration} from "../../../packages/product/src/configuration.js";
type Settings={revision:number;policy:Policy;configuration:ProductConfiguration};
type Api=<T=unknown>(path:string,body?:unknown)=>Promise<T>;

/** Admin changes remain versioned and previewed; no field becomes executable code. */
export function companySettings(parent:HTMLElement,current:Settings,api:Api) {
  const draft=structuredClone(current);
  const section=document.createElement("section");section.className="card";parent.append(section);
  const title=document.createElement("h2");title.textContent="Company directory and communication rules";section.append(title);
  const help=document.createElement("p");help.textContent="Set up departments, responsible people and what information may be shared. A person can have both email and WhatsApp endpoints in People & channels. Archive keeps case history; remove is only for entries never used.";section.append(help);
  const status=document.createElement("p"),body=document.createElement("div");section.append(body,status);
  function input(container:HTMLElement,label:string,value:string,type="text") {const l=document.createElement("label"),i=document.createElement("input");l.textContent=label;i.type=type;i.value=value;l.append(i);container.append(l);return i;}
  function button(container:HTMLElement,label:string,action:()=>void|Promise<void>) {const b=document.createElement("button");b.type="button";b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){status.textContent=e instanceof Error?e.message:String(e);}finally{b.disabled=false;}};container.append(b);return b;}
  const list=(value:string)=>value.split(",").map(v=>v.trim()).filter(Boolean);
  const fold=(label:string)=>{const d=document.createElement("details"),s=document.createElement("summary");s.textContent=label;d.append(s);body.append(d);return d;};
  function render() {
    body.replaceChildren();
    const groups=fold("Departments (used to route requests)");
    for(const group of draft.policy.groups){const row=document.createElement("div");row.textContent=group;groups.append(row);button(row,"Remove",()=>{
      if(draft.policy.actors.some(a=>a.group===group)||draft.configuration.workflows.some(w=>w.branches.some(b=>b.group===group)))throw new Error("Remove or reassign directory/workflow references first. Existing case history is retained.");
      draft.policy.groups=draft.policy.groups.filter(g=>g!==group);draft.configuration.messageProfiles=draft.configuration.messageProfiles?.filter(p=>p.group!==group);render();
    });}
    const groupId=input(groups,"Department ID — short internal name, e.g. quality or production","" );button(groups,"Add department",()=>{if(!/^[A-Za-z0-9_-]{1,80}$/.test(groupId.value)||draft.policy.groups.includes(groupId.value))throw new Error("Use a unique short department ID");draft.policy.groups.push(groupId.value);render();});
    const people=fold("People, responsibilities & approval authority");
    for(const actor of draft.policy.actors) {
      const row=document.createElement("details"),summary=document.createElement("summary");summary.textContent=`${actor.name??actor.id} · ${actor.group} · ${actor.enabled?"active":"archived"}`;row.append(summary);people.append(row);
      const name=input(row,"Display name",actor.name??actor.id),group=input(row,"Department ID",actor.group),capabilities=input(row,"What this person handles (comma separated)",(actor.capabilities??[]).join(", ")),scope=input(row,"Scope: sites, orders or customers (comma separated)",(actor.scope??[]).join(", ")),authority=input(row,"Can approve these subject types (comma separated; blank means no special limit)",(actor.approvalScopes??[]).join(", ")),channel=input(row,"Preferred first channel — actual email/WhatsApp endpoints are set separately",actor.preferredChannel??""),hours=input(row,"Working hours and timezone",actor.workingHours??""),backup=input(row,"Backup person ID",actor.backupActorId??"");
      button(row,"Save person to draft",()=>{Object.assign(actor,{name:name.value,group:group.value,capabilities:list(capabilities.value),scope:list(scope.value),approvalScopes:list(authority.value),preferredChannel:channel.value||undefined,workingHours:hours.value||undefined,backupActorId:backup.value||undefined});status.textContent="Draft updated. Preview and publish below.";});
      button(row,actor.enabled?"Archive person":"Restore person",()=>{actor.enabled=!actor.enabled;render();});
      button(row,"Remove unused person",()=>{draft.policy.actors=draft.policy.actors.filter(a=>a.id!==actor.id);render();});
    }
    const actorId=input(people,"New person ID — short internal name, e.g. qa_manager",""),actorGroup=input(people,"Department ID",""),actorRole=input(people,"Role: respondent, verifier or coordinator","respondent");
    button(people,"Add person",()=>{if(draft.policy.actors.some(a=>a.id===actorId.value))throw new Error("Person ID already exists");draft.policy.actors.push({id:actorId.value,group:actorGroup.value,role:actorRole.value as Actor["role"],enabled:true,capabilities:[],scope:[],approvalScopes:[]});render();});
    const controls=fold("Automatic intake, timing & shared participant routing (advanced)");
    const intake=input(controls,"Assisted intake enabled: true or false",String(draft.configuration.assistedIntake??false)),owner=input(controls,"Intake department",draft.configuration.intakeGroup??""),supervisor=input(controls,"Exception supervisor (coordinator ID)",draft.policy.supervisorActorId??""),sla=input(controls,"Response SLA seconds",String(draft.policy.deadlineSeconds),"number"),extension=input(controls,"Automatic extension seconds (0 disables)",String(draft.policy.autoExtendSeconds??0),"number"),count=input(controls,"Maximum automatic extensions",String(draft.policy.maxExtensions??0),"number"),fallback=input(controls,"Allow channel fallback: true or false",String(draft.configuration.automaticFallback)),demo=input(controls,"Demo routing enabled: true or false",String(draft.configuration.demoRouting?.enabled??false)),demoActor=input(controls,"Demo endpoint person ID",draft.configuration.demoRouting?.actorId??"");
    demo.parentElement!.firstChild!.textContent="Shared participant routing enabled (simulated sources only): true or false";
    demoActor.parentElement!.firstChild!.textContent="Default recipient person ID (used when no department routes exist)";
    button(controls,"Save controls to draft",()=>{draft.configuration.assistedIntake=intake.value==="true";draft.configuration.intakeGroup=owner.value||undefined;draft.configuration.automaticFallback=fallback.value==="true";draft.policy.supervisorActorId=supervisor.value||undefined;draft.policy.deadlineSeconds=Number(sla.value);draft.policy.autoExtendSeconds=Number(extension.value);draft.policy.maxExtensions=Number(count.value);draft.configuration.demoRouting=demoActor.value?{...draft.configuration.demoRouting,enabled:demo.value==="true",actorId:demoActor.value}:undefined;status.textContent="Draft updated.";});
    const routes=fold("Shared participant routes by department and channel");
    const explanation=document.createElement("p");explanation.textContent="For simulated source requests, one registered participant may represent different departments. Each route names an existing consented endpoint owner. Case, department and reply-reference checks still apply. Unmapped departments have no shared route.";routes.append(explanation);
    for(const route of draft.configuration.demoRouting?.routes??[]) {const row=document.createElement("div");row.textContent=`${route.group} · ${route.channel} → ${route.actorId}`;routes.append(row);button(row,"Remove route from draft",()=>{draft.configuration.demoRouting!.routes=draft.configuration.demoRouting!.routes!.filter(r=>r!==route);render();});}
    const routeGroup=input(routes,"Department ID",""),routeChannel=input(routes,"Channel: email or whatsapp","email"),routeActor=input(routes,"Registered endpoint owner ID","");
    button(routes,"Add / replace participant route",()=>{if(!draft.configuration.demoRouting)throw new Error("Enable shared participant routing and save controls first.");const route={group:routeGroup.value.trim(),channel:routeChannel.value as "email"|"whatsapp",actorId:routeActor.value.trim()};if(!draft.policy.groups.includes(route.group)||!["email","whatsapp"].includes(route.channel)||!draft.policy.actors.some(a=>a.id===route.actorId&&a.enabled))throw new Error("Choose an existing department, enabled endpoint owner and supported channel.");draft.configuration.demoRouting.routes=[...(draft.configuration.demoRouting.routes??[]).filter(r=>r.group!==route.group||r.channel!==route.channel),route];render();status.textContent="Route saved to draft. Preview and publish to activate.";});
    const profiles=fold("What each department may receive by channel");
    for(const p of draft.configuration.messageProfiles??[]) {const row=document.createElement("div");row.textContent=`${p.group} / ${p.channel} / ${p.format} / ${p.language}`;profiles.append(row);button(row,"Remove profile",()=>{draft.configuration.messageProfiles=draft.configuration.messageProfiles?.filter(v=>v!==p);render();});}
    const pg=input(profiles,"Department",""),pc=input(profiles,"Channel","email"),pl=input(profiles,"Language: en or bn","en"),ps=input(profiles,"Style: formal or concise","concise"),pf=input(profiles,"Allowed fact keys (comma separated; * explicitly allows all)","usable_quantity,passing_quantity,quarantined_quantity,release_authorization,hold,restriction,instruction,uncertainty"),px=input(profiles,"Allowed source fields (comma separated)","siteId,materialLotId,requiredQuantity,neededBy");
    button(profiles,"Add / replace human profile",()=>{const profile={group:pg.value,channel:pc.value as "email"|"whatsapp",language:pl.value as "en"|"bn",style:ps.value as "formal"|"concise",format:"human" as const,version:`profile-${Date.now()}`,factKeys:list(pf.value),sourceFields:list(px.value),fields:[]};draft.configuration.messageProfiles=[...(draft.configuration.messageProfiles??[]).filter(p=>p.group!==profile.group||p.channel!==profile.channel),profile];render();});
    const workflows=fold("Configured workflow templates");
    for(const w of draft.configuration.workflows){const row=document.createElement("div");row.textContent=w.workflow;workflows.append(row);button(row,"Remove from future intake",()=>{draft.configuration.workflows=draft.configuration.workflows.filter(v=>v!==w);render();});}
  }
  render();
  let previewed="";
  const payload=()=>({...draft,action:"preview",expectedRevision:current.revision,policy:{...draft.policy,version:`company-${current.revision+1}-${Date.now()}`}});
  let ready:ReturnType<typeof payload>|undefined;
  button(section,"Preview changes",async()=>{ready=payload();const {revision,...request}=ready;const result=await api("/configuration",request);previewed=JSON.stringify(draft);status.textContent=`Preview: ${JSON.stringify(result)}. Review affected cases before publishing.`;});
  button(section,"Publish previewed changes",async()=>{if(!ready||previewed!==JSON.stringify(draft))throw new Error("Preview the current draft first");const {revision,...request}=ready;await api("/configuration",{...request,action:"publish"});status.textContent="Published. Reload settings before making more changes; affected active cases need explicit configuration adoption.";ready=undefined;});
}
