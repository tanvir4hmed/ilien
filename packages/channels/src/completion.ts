import {param,query,rows} from '../../persistence/src/database.js';
import {configurationFor} from '../../product/src/configuration.js';
import {createDelivery,decode,type Binding} from './intents.js';
import {contactBindings} from './routing.js';
import type {CaseState,Contact} from '../../coordination/src/types.js';

/** Same transaction as source publication: one optional notice per exact completed result. */
export async function queueCompletionNotice(tenant:string,resultId:string,tx:string){
 const row=rows<{case_id:string;connection_id:string;snapshot:CaseState|string;case_revision:number}>(await query("SELECT r.case_id,c.connection_id,c.snapshot,r.case_revision FROM coordination_results r JOIN coordination_cases c ON c.tenant_id=r.tenant_id AND c.id=r.case_id JOIN result_dispatches d ON d.tenant_id=r.tenant_id AND d.result_id=r.id WHERE r.id=CAST(:id AS uuid) AND d.state='published' FOR UPDATE OF c",[param('id',resultId)],tx))[0];
 if(!row)return;
 const state=decode(row.snapshot),configuration=(await configurationFor(row.connection_id,tx)).configuration,notice=configuration.completionNotice;
 if(!notice?.enabled||state.status!=='completed'||state.revision!==row.case_revision)return;
 const task=state.obligations.find(o=>o.group===notice.group&&o.assignee===notice.actorId);
 if(!task)return;
 const endpoints=rows<Binding>(await query("SELECT * FROM channel_bindings WHERE connection_id=CAST(:source AS uuid) AND enabled AND channel='whatsapp' ORDER BY priority,id",[param('source',row.connection_id)],tx));
 const binding=contactBindings(endpoints,notice.actorId,notice.group,state.origin,configuration)[0];
 if(!binding)return;
 const contact:Contact={obligationId:task.id,actorId:notice.actorId,kind:'completion_notice',resultId,resultRevision:state.revision,question:'Inform the registered recipient that coordination is complete and the outcome was published to the requesting source. No reply or operational action is required.',subject:state.subject,sourceEvidenceId:state.sourceEvidenceId,origin:state.origin};
 await query("INSERT INTO coordination_contacts(tenant_id,case_id,id,case_revision,contact) VALUES(CAST(:tenant AS uuid),CAST(:case AS uuid),CAST(:id AS uuid),CAST(:revision AS integer),CAST(:contact AS jsonb)) ON CONFLICT(tenant_id,id) DO NOTHING",[param('tenant',tenant),param('case',state.id),param('id',resultId),param('revision',String(state.revision)),param('contact',JSON.stringify(contact))],tx);
 await createDelivery(tenant,state,resultId,contact,tx,binding.id);
}
