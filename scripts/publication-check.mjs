import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/(^|\/)(\.private|research|node_modules|\.terraform)(\/|$)|(^|\/)(AGENTS\.md|PROJECT_CONTEXT\.md|\.env(?:\..*)?)$|\.private\.zip$|\.tfstate(?:\..*)?$|\.tfplan$|(?<!example)\.tfvars$/i;
let failed=false;
for(const file of files){
 if(forbidden.test(file)){console.error(`Forbidden tracked path: ${file}`);failed=true;continue;}
 if(!/\.(?:md|ts|mjs|json|ya?ml|tf|sql|txt)$/.test(file))continue;
 const content=readFileSync(file,'utf8');
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content)){console.error(`Credential pattern: ${file}`);failed=true;}
}
if(failed)process.exit(1);
console.log('Tracked-file publication guard passed.');
