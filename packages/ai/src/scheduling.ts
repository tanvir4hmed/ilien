import type {CaseState} from '../../coordination/src/types.js';
import {satisfied} from '../../coordination/src/engine.js';
/** Contact-producing transitions already send their question. Wait for evidence, not another model poll. */
export function needsCasePlanning(state:CaseState,trigger?:string) {
 if(!state.autonomous || ['completed','cancelled','handed_off','paused'].includes(state.status))return false;
 if(state.sourceQuestions?.some(q=>!q.answer))return false;
 if(state.planningPending)return true;
 if(state.awaitingPlan)return true;
 if(state.obligations.some(o=>o.kind==='decision'&&!satisfied(o)&&!o.proposal&&o.dependencies.every(id=>state.obligations.some(d=>d.id===id&&satisfied(d)))))return true;
 const outstandingAsk=state.obligations.some(o=>o.status==='waiting'&&o.reminders>0&&o.dependencies.every(id=>state.obligations.some(d=>d.id===id&&satisfied(d))));
 return (trigger==='source_response'&&!outstandingAsk)||trigger==='decide'||trigger==='relay_decision';
}
