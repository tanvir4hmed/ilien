import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const sections=['# Dependency license inventory\n\nGenerated from the committed npm lockfile. Package licenses apply independently of the ILIEN license. Includes build tooling.\n'];
for(const [path,entry] of Object.entries(lock.packages??{})){
 if(!path.startsWith('node_modules/')||entry.link||!existsSync(path))continue;
 const meta=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
 const names=readdirSync(path).filter(n=>/^(license|licence|notice)(\..*)?$/i.test(n));
 sections.push(`## ${meta.name} ${meta.version}\n\nDeclared license: ${meta.license??entry.license??'See upstream package'}\n`);
 for(const name of names){ sections.push(`### ${name}\n\n\x60\x60\x60text\n${readFileSync(join(path,name),'utf8')}\n\x60\x60\x60\n`); }
}
writeFileSync('docs/DEPENDENCY_LICENSES.md',sections.join('\n').replace(/[ \t]+$/gm,''));
