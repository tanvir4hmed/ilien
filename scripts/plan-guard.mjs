import {readFileSync} from 'node:fs';
const plan=JSON.parse(readFileSync(process.argv[2],'utf8'));
const destructive=(plan.resource_changes??[]).filter(r=>r.change.actions.includes('delete'));
if(destructive.length){console.error('Automatic deployment refuses deletion/replacement:',destructive.map(r=>r.address).join(', '));process.exit(1);}
console.log(`Plan contains ${(plan.resource_changes??[]).length} resource entries; no destructive changes.`);
